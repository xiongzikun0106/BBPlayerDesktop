/**
 * 登录界面（Phase 3）：扫码 / 密码 / 粘贴 Cookie。
 *
 * ## 三条路并存的原因
 *
 * * **扫码**最适合桌面端（手机本来就在手边），且不接触密码；
 * * **密码**受 B 站风控，可能返回 `-105 验证码错误` —— 本模块不实现验证码，
 *   拿到这个错误就明确引导用户改用扫码；
 * * **粘贴 Cookie** 成本最低、最稳，作为兜底始终保留（DevTools →
 *   Application → Cookies 复制，或直接复制 `document.cookie` 文本）。
 *
 * ## 安全约束
 *
 * 二维码由主进程生成成 PNG 后传进来，渲染进程**拿不到 URL 里的
 * `qrcode_key`**；轮询在主进程做（`bbplayer.loginQrPoll`），
 * 所以登录令牌不会进入渲染进程的 JS 环境。
 */
;(function () {
	'use strict'

	const els = {
		modal: document.getElementById('login-modal'),
		badge: document.getElementById('account-badge'),
		close: document.getElementById('login-close'),
		tabs: document.querySelectorAll('[data-login-tab]'),
		panels: document.querySelectorAll('[data-login-panel]'),

		qrImage: document.getElementById('login-qr-image'),
		qrStatus: document.getElementById('login-qr-status'),
		qrRefresh: document.getElementById('login-qr-refresh'),

		username: document.getElementById('login-username'),
		password: document.getElementById('login-password'),
		passwordSubmit: document.getElementById('login-password-submit'),
		passwordStatus: document.getElementById('login-password-status'),

		cookieInput: document.getElementById('login-cookie-input'),
		cookieSubmit: document.getElementById('login-cookie-submit'),
		cookieStatus: document.getElementById('login-cookie-status'),

		account: document.getElementById('login-account'),
		logout: document.getElementById('login-logout'),
		security: document.getElementById('login-security'),
	}

	const setStatus = (node, text, kind) => {
		if (!node) return
		node.textContent = text ?? ''
		node.className = `login-status${kind ? ` login-status--${kind}` : ''}`
	}

	/** 统一的 IPC 结果解包 */
	function unwrap(result, what) {
		if (!result || result.ok !== true) {
			throw new Error(`${what}失败：${result?.error ?? '未知错误'}`)
		}
		return result.data
	}

	// ---------------------------------------------------------------
	// 账号徽标 / 账号面板
	// ---------------------------------------------------------------

	let currentStatus = { loggedIn: false, available: false }

	function renderAccount(status) {
		currentStatus = status ?? { loggedIn: false }
		const loggedIn = Boolean(status?.loggedIn)

		if (els.badge) {
			const user = status?.user
			els.badge.textContent = loggedIn ? (user?.uname ?? '已登录') : '未登录'
			els.badge.classList.toggle('is-online', loggedIn)
			els.badge.title = loggedIn
				? `mid=${user?.mid ?? '?'}${user?.vip ? ` · ${user.vipLabel ?? '会员'}` : ''} · 点击管理登录`
				: '点击登录（公开收藏夹无需登录也可导入）'
		}

		if (!els.account) return

		if (!loggedIn) {
			els.account.textContent = ''
			const p = document.createElement('p')
			p.className = 'muted'
			p.textContent = status?.stale
				? '本地保存的登录态已失效（cookie 过期或已登出），请重新登录。'
				: '尚未登录。'
			els.account.appendChild(p)

			const note = document.createElement('p')
			note.className = 'muted'
			note.textContent =
				'提示：B 站的公开收藏夹与 UP 合集无需登录即可导入；登录用于读取私密收藏夹、解锁杜比 / Hi-Res 音质与个人化推荐。'
			els.account.appendChild(note)

			if (status?.offline) {
				const offline = document.createElement('p')
				offline.className = 'login-status login-status--warn'
				offline.textContent = `无法连接 B 站校验登录态：${status.error ?? '网络错误'}`
				els.account.appendChild(offline)
			}
			return
		}

		const user = status.user
		const list = document.createElement('dl')
		list.className = 'login-account__list'
		const rows = [
			['用户名', user?.uname ?? '—'],
			['UID', user?.mid != null ? String(user.mid) : '—'],
			['等级', user?.level != null ? `Lv${user.level}` : '—'],
			['会员', user?.vip ? (user.vipLabel ?? '是') : '否'],
		]
		for (const [label, value] of rows) {
			const dt = document.createElement('dt')
			dt.textContent = label
			const dd = document.createElement('dd')
			dd.textContent = value
			list.append(dt, dd)
		}
		els.account.appendChild(list)
	}

	/** 登录态存储方式提示（加密 / 仅混淆） */
	function renderSecurity(status) {
		if (!els.security) return
		if (status?.encrypted) {
			setStatus(els.security, '凭据已由系统密钥环加密存储', 'ok')
		} else {
			setStatus(
				els.security,
				'⚠️ 系统密钥环不可用，凭据仅做混淆存储（等同明文）—— 共享账号的机器上请注意',
				'warn',
			)
		}
	}

	// ---------------------------------------------------------------
	// 扫码
	// ---------------------------------------------------------------

	let qrKey = null
	let qrTimer = null
	let qrGeneration = 0

	function stopQrPolling() {
		if (qrTimer) {
			clearTimeout(qrTimer)
			qrTimer = null
		}
	}

	/** 轮询节奏与主进程一致：首次 1s，之后 2s */
	const pollDelay = (round) => (round === 0 ? 1000 : 2000)

	async function pollQr(round = 0) {
		const generation = qrGeneration
		if (!qrKey) return

		let data
		try {
			data = unwrap(await window.bbplayer.loginQrPoll(qrKey), '查询扫码状态')
		} catch (error) {
			setStatus(els.qrStatus, error.message, 'bad')
			return
		}
		// 期间用户点了「刷新二维码」：丢弃这次结果
		if (generation !== qrGeneration) return

		if (data.state === 'pending') {
			setStatus(els.qrStatus, '等待扫码…（用哔哩哔哩 App 扫描）', 'busy')
		} else if (data.state === 'scanned') {
			setStatus(els.qrStatus, '已扫码，请在手机上确认登录', 'busy')
		} else if (data.state === 'expired') {
			setStatus(els.qrStatus, '二维码已失效，请点击「刷新二维码」', 'bad')
			return
		} else if (data.state === 'confirmed') {
			setStatus(els.qrStatus, '登录成功', 'ok')
			qrKey = null
			await refresh()
			return
		} else {
			setStatus(
				els.qrStatus,
				`未知状态 ${data.status ?? '?'}：${data.message ?? ''}`,
				'bad',
			)
		}

		// 上限约 3 分钟，避免无限轮询
		if (round < 90) {
			qrTimer = setTimeout(() => void pollQr(round + 1), pollDelay(round))
		} else {
			setStatus(els.qrStatus, '二维码等待超时，请刷新重试', 'bad')
		}
	}

	async function startQr() {
		stopQrPolling()
		qrGeneration += 1
		qrKey = null
		setStatus(els.qrStatus, '正在获取二维码…', 'busy')
		if (els.qrImage) {
			els.qrImage.removeAttribute('src')
			els.qrImage.alt = '二维码加载中'
		}

		try {
			const data = unwrap(await window.bbplayer.loginQrCreate(), '获取二维码')
			qrKey = data.qrcodeKey

			if (data.imageDataUrl && els.qrImage) {
				els.qrImage.src = data.imageDataUrl
				els.qrImage.alt = '扫码登录二维码'
			} else if (els.qrImage) {
				// 二维码渲染失败时明确报出来，不要让用户对着空白发呆
				els.qrImage.alt = `二维码渲染失败：${data.imageError ?? '未知原因'}`
			}

			setStatus(els.qrStatus, '等待扫码…（用哔哩哔哩 App 扫描）', 'busy')
			void pollQr(0)
		} catch (error) {
			setStatus(els.qrStatus, error.message, 'bad')
		}
	}

	// ---------------------------------------------------------------
	// 密码 / Cookie
	// ---------------------------------------------------------------

	async function submitPassword() {
		const username = els.username?.value?.trim() ?? ''
		const password = els.password?.value ?? ''
		if (!username || !password) {
			setStatus(els.passwordStatus, '用户名与密码都不能为空', 'bad')
			return
		}

		if (els.passwordSubmit) els.passwordSubmit.disabled = true
		setStatus(els.passwordStatus, '正在登录…', 'busy')
		try {
			const data = unwrap(
				await window.bbplayer.loginWithPassword(username, password),
				'密码登录',
			)
			setStatus(els.passwordStatus, `登录成功：${data.user?.uname ?? ''}`, 'ok')
			await refresh()
		} catch (error) {
			setStatus(els.passwordStatus, error.message, 'bad')
		} finally {
			// ⚠️ 清密码必须放在 finally：第一版放在 try 的成功分支里，
			// 于是**失败时密码一直留在输入框**（被 UI 探针的
			// 「提交后密码框已清空」断言抓到）。失败路径恰恰更需要清干净。
			if (els.password) els.password.value = ''
			if (els.passwordSubmit) els.passwordSubmit.disabled = false
		}
	}

	async function submitCookie() {
		const text = els.cookieInput?.value?.trim() ?? ''
		if (!text) {
			setStatus(els.cookieStatus, 'cookie 不能为空', 'bad')
			return
		}

		if (els.cookieSubmit) els.cookieSubmit.disabled = true
		setStatus(els.cookieStatus, '正在校验 cookie…', 'busy')
		try {
			const data = unwrap(
				await window.bbplayer.importCookie(text),
				'导入 cookie',
			)
			if (els.cookieInput) els.cookieInput.value = ''
			setStatus(
				els.cookieStatus,
				`登录成功：${data.user?.uname ?? ''}（mid=${data.user?.mid ?? '?'}）`,
				'ok',
			)
			await refresh()
		} catch (error) {
			setStatus(els.cookieStatus, error.message, 'bad')
		} finally {
			if (els.cookieSubmit) els.cookieSubmit.disabled = false
		}
	}

	async function logout() {
		try {
			unwrap(await window.bbplayer.logout(), '退出登录')
			setStatus(els.passwordStatus, '')
			setStatus(els.cookieStatus, '')
			stopQrPolling()
			await refresh()
			// 退出后曲目仍可播（公开接口），但会员音轨会掉档，提示一下刷新队列没意义
			setStatus(els.qrStatus, '已退出登录', 'ok')
		} catch (error) {
			setStatus(els.account, error.message, 'bad')
		}
	}

	// ---------------------------------------------------------------
	// 刷新 / 开关
	// ---------------------------------------------------------------

	async function refresh() {
		try {
			const status = unwrap(await window.bbplayer.loginStatus(), '读取登录态')
			renderAccount(status)
			renderSecurity(status)
			return status
		} catch (error) {
			renderAccount({ loggedIn: false })
			renderSecurity(null)
			return { loggedIn: false, error: error.message }
		}
	}

	function switchTab(tab) {
		for (const button of els.tabs) {
			button.classList.toggle('is-active', button.dataset.loginTab === tab)
		}
		for (const panel of els.panels) {
			panel.classList.toggle('is-active', panel.dataset.loginPanel === tab)
		}
		if (tab === 'qr') void startQr()
	}

	function open(tab = 'qr') {
		if (!els.modal) return
		els.modal.hidden = false
		els.modal.classList.add('is-open')
		// 每次打开都重新拉一次登录态：用户可能在别处改了
		void refresh()
		switchTab(tab)
	}

	function close() {
		if (!els.modal) return
		els.modal.hidden = true
		els.modal.classList.remove('is-open')
		// 关掉就停止轮询，避免后台一直请求
		stopQrPolling()
		qrGeneration += 1
		qrKey = null
	}

	// ---------------------------------------------------------------
	// 事件绑定
	// ---------------------------------------------------------------

	if (els.badge) els.badge.addEventListener('click', () => open('qr'))
	if (els.close) els.close.addEventListener('click', close)
	if (els.qrRefresh)
		els.qrRefresh.addEventListener('click', () => void startQr())
	if (els.passwordSubmit) {
		els.passwordSubmit.addEventListener('click', () => void submitPassword())
	}
	if (els.cookieSubmit) {
		els.cookieSubmit.addEventListener('click', () => void submitCookie())
	}
	if (els.logout) els.logout.addEventListener('click', () => void logout())

	for (const button of els.tabs) {
		button.addEventListener('click', () => switchTab(button.dataset.loginTab))
	}

	// 密码框回车直接提交
	for (const input of [els.username, els.password]) {
		input?.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') void submitPassword()
		})
	}

	// 点击遮罩关闭
	els.modal?.addEventListener('click', (event) => {
		if (event.target === els.modal) close()
	})

	window.bbAuth = {
		open,
		close,
		refresh,
		switchTab,
		/** 供自动化断言：当前账号面板文本 */
		status: () => currentStatus,
		/** 供自动化：直接走三条登录路径 */
		submitCookie,
		submitPassword,
		startQr,
		logout,
		/** 轮询状态（自动化等待扫码用） */
		isPolling: () => Boolean(qrTimer),
		setQrKeyForTest: (key) => {
			qrKey = key
		},
	}

	// 启动时同步一次徽标；失败不影响主流程
	void refresh()
})()
