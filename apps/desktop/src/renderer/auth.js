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
		/**
		 * 账号入口按钮。
		 *
		 * ⚠️ 原来这里是一个**文字徽标**（`#account-badge`，显示「未登录 / 用户名」）。
		 * 阶段 2 换成了**头像按钮**：登录状态属于"账号"、属于设置，
		 * 不需要挂在每一屏的品牌行上；文字徽标还会挤掉品牌名
		 * （历史上真出现过左栏按钮被压成两行）。
		 */
		accountOpen: document.getElementById('account-open'),
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
	}

	const setStatus = (node, text, kind) => {
		if (!node) return
		node.textContent = text ?? ''
		node.className = `login-status${kind ? ` login-status--${kind}` : ''}`
	}

	/**
	 * 登录成功后的**收束动作**（三条登录路径共用）。
	 *
	 * 扫码 / 密码 / 粘贴 Cookie 都能登录，但原来只有各自的成功分支
	 * 改了弹窗内的一行小字就结束 —— 用户看到的是"弹窗还杵在那儿、
	 * 里面一行字变了"，既没有"完成了"的收束感，也不知道接下来干什么。
	 * （用户复审时明确提了这一条。）
	 *
	 * 所以统一成三件事：
	 *   1. 关掉登录弹窗；
	 *   2. 在**全局胶囊**（`#status`，与 library/history/import 等模块
	 *      完全同一个元素、同一套写法）上提示「登录成功」——
	 *      它会被 `status.js` 接管并**自动淡出**；
	 *   3. 有昵称就带上昵称，让用户确认登的是哪个账号。
	 *
	 * ⚠️ 顺序：先关弹窗再弹提示，否则提示会被弹窗盖住。
	 *
	 * ⚠️ 不要把 `mid` 之类的字段拼进文案（原来粘贴 Cookie 那条写的是
	 * 「…（mid=12345）」）—— 那是给开发者看的，用户只关心"是不是我"。
	 */
	function finishLogin(statusNode, uname) {
		const name = typeof uname === 'string' && uname.trim() ? uname.trim() : ''
		setStatus(statusNode, name ? `登录成功：${name}` : '登录成功', 'ok')
		close()
		const pill = document.getElementById('status')
		if (pill) {
			pill.textContent = name ? `登录成功，欢迎 ${name}` : '登录成功'
			pill.className = 'status status--ok'
		}
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

		if (els.accountOpen) {
			const user = status?.user
			// 按钮上**不写文字**：未登录就是 person 图标，已登录换成头像/首字。
			// 登录与否在弹窗里说清楚，不必在每一屏的标题栏上重复一遍。
			const name = loggedIn ? (user?.uname ?? '已登录') : ''
			els.accountOpen.dataset.loggedIn = String(loggedIn)
			els.accountOpen.title = loggedIn
				? `${name} · mid=${user?.mid ?? '?'}${user?.vip ? ` · ${user.vipLabel ?? '会员'}` : ''} · 点击管理登录`
				: '登录 B 站账号（公开收藏夹无需登录也能导入）'
			els.accountOpen.setAttribute(
				'aria-label',
				loggedIn ? `账号：${name}` : '账号：未登录',
			)

			const iconNode = els.accountOpen.querySelector('.icon')
			if (iconNode)
				iconNode.textContent = loggedIn ? 'account_circle' : 'person'

			/*
			 * 用户名写到**品牌名右边**（用户复审时明确要求）。
			 *
			 * ⚠️ 未登录时**隐藏而不是写"未登录"** —— 品牌行只有 240px 宽，
			 * 一个常驻的"未登录"会把 `BBPlayer` 挤掉，而"没登录"这件事
			 * 在账号弹窗里说一次就够了。
			 */
			const userLabel = document.getElementById('sidebar-user')
			if (userLabel) {
				const shown = loggedIn ? name : ''
				userLabel.textContent = shown
				userLabel.hidden = shown === ''
				userLabel.title = shown
			}
			// 已登录时给按钮加个色，作为"有登录态"的唯一视觉线索
			els.accountOpen.classList.toggle('is-online', loggedIn)
		}

		if (!els.account) return

		/*
		 * ⚠️ 「退出登录」按钮必须跟着登录态显隐。
		 *
		 * 它原来**从来没有被隐藏过** —— 于是账号页出现
		 * "写着你尚未登录，唯一的按钮却是退出登录"这种自相矛盾的画面
		 * （截图审查发现的）。
		 *
		 * 按钮与它描述的状态必须一致：没登录就没有可退的。
		 */
		if (els.logout) els.logout.hidden = !loggedIn

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

	// 凭据的落盘方式**不在这里显示**。
	//
	// 原来这里会写「凭据已由系统密钥环加密存储」，系统没有密钥环时还会写
	// 「⚠️ …仅做混淆存储（等同明文）—— 共享账号的机器上请注意」。那是把
	// 安全审计的结论摆在了登录面板正中：用户在扫码登录时不需要被教育这件事，
	// 而且一句「等同明文」只会让人以为出事了。
	//
	// 事实仍然**可查**，只是换了地方：设置 › 备份 › 诊断信息 › 凭据存储。
	// 见 `settings-panel.js` 的 `refreshDiagnostics()`。

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
			qrKey = null
			await refresh()
			finishLogin(els.qrStatus, data.user?.uname)
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
			finishLogin(els.passwordStatus, data.user?.uname)
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
			finishLogin(els.cookieStatus, data.user?.uname)
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
			return status
		} catch (error) {
			renderAccount({ loggedIn: false })
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

	if (els.accountOpen)
		els.accountOpen.addEventListener('click', () => open('qr'))
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
