/**
 * 共享歌单视图（Phase 3.4）。
 *
 * ## 为什么每个动作都要处理失败分支
 *
 * `window.bbplayer.share.*` 与 B 站那套接口不同：它**不抛异常**，一律返回
 * `{ok:true,data}` 或 `{ok:false,error,status,code}` —— 因为共享会失败在很多种
 * 原因上（没登录 / 网络不可达 / 404 / 403 / 邀请码不对），渲染进程必须能区分
 * 「请重新登录」和「歌单不存在」。所以这里每个动作都先判 `ok`，失败时把状态码
 * 翻成人话（见 `describeFailure`），**绝不去碰 `data` 里的字段**。
 *
 * ## 打开视图不发网络请求
 *
 * `share.status()` 只读本地（账号文件 + SQLite），所以 `show()` 里直接调它是
 * 安全的。默认后端是**线上生产服务**，后端不可达时这里只应渲染成「未登录」，
 * 不能抛异常、也不能卡在 await 上。所有会走网络的动作都发生在用户点击之后。
 *
 * ## 状态文案的书写顺序
 *
 * `refresh()` 结尾会写一条「已加载 N 个共享歌单」，所以**所有动作都必须先
 * `await refresh()` 再写结果文案**，否则结果会被立刻覆盖、用户永远看不到
 * （`history.js` 的清空、`import.js` 的导入都踩过这个坑，探针抓到过两次）。
 *
 * ## 角色
 *
 * owner 可邀请 / 取消共享，editor 可写但不能邀请，subscriber **只读**。
 * 只读这件事在界面上一律显式写出来（徽标 + 文案），不靠按钮多少去暗示。
 *
 * ## 用户可控字符串
 *
 * 标题 / 成员名 / 分享链接都来自后端。这里**全部**用 `textContent` 写入
 * （与 library.js / history.js 同一做法），没有任何 `innerHTML`，
 * 因此不存在注入面。
 */
;(function () {
	'use strict'

	/** 与 `bbplayer-account.cjs` 的本地校验同规则（同一份规则写在界面上） */
	const USERNAME_MIN = 3
	const PASSWORD_MIN = 8

	const ROLE_LABEL = {
		owner: '创建者',
		editor: '编辑者',
		subscriber: '订阅者',
	}

	/** 每个角色的能力，直接写在行内（订阅者的只读必须一眼可见） */
	const ROLE_DESC = {
		owner: '可编辑、可邀请、可取消共享',
		editor: '可编辑，不能邀请或取消共享',
		subscriber: '只读：不能增删曲目，只能拉取同步',
	}

	const els = {
		/** 共享视图的根节点常驻在 index.html 里（探针要能 `#view-share` 找到它） */
		root: document.getElementById('view-share'),
		status: document.getElementById('status'),
	}

	/**
	 * 视图状态。
	 *
	 * 视图是「整块重绘」的（`render()` 清空后重建），所以输入框里已经敲的内容、
	 * 预览结果、每一行的即时反馈都必须存在这里，重绘时再填回去。
	 */
	const state = {
		/** `share.status()` 的返回；未读取时为 null */
		account: null,
		/** 订阅区的输入 */
		url: '',
		inviteCode: '',
		/** 最近一次成功的预览结果（`share.preview` 的 data） */
		preview: null,
		/** 最近一次预览的失败文案 */
		previewError: null,
		/** playlistId -> { note?, link?, invite?, members?, membersFrom?, canSeeSubscribers? } */
		rowInfo: new Map(),
		/** `share.syncAll()` 的逐条结果 */
		syncAll: null,
	}

	/** 视图内状态行（重绘会重建 DOM，所以文案也存一份在这里） */
	let viewStatus = { text: '尚未读取共享状态', kind: 'idle' }

	// ---------------------------------------------------------------
	// 基础工具
	// ---------------------------------------------------------------

	/** 统一的 IPC 结果解包（主进程返回 `{ok,data}` 或 `{ok:false,error}`） */
	function unwrap(result, what) {
		if (!result || result.ok !== true) {
			throw new Error(`${what}失败：${result?.error ?? '未知错误'}`)
		}
		return result.data
	}

	/**
	 * 把 `{ok:false,error,status,code}` 翻成一句人能看懂的话。
	 *
	 * 401 与 404 是最常见的两种，单独说清楚（前者要重登、后者是歌单没了）；
	 * 其余原样透出后端/网络层的 error，不吞、不猜。
	 */
	function describeFailure(result, what) {
		const status = result?.status ?? null
		const message = result?.error ?? '未知错误'
		if (status === 401 || result?.code === 'no_token') {
			return `${what}失败：需要先登录 BBPlayer 账号（登录状态可能已失效）`
		}
		if (status === 404) return `${what}失败：歌单不存在或已被删除（404）`
		if (status === 403) return `${what}失败：当前角色没有这个权限（403）`
		if (status === 0) return `${what}失败：无法连接后端（${message}）`
		return `${what}失败：${message}`
	}

	/** 全局状态栏（与其它视图一致） */
	function setStatus(text, kind) {
		if (!els.status) return
		els.status.textContent = text
		els.status.className = `status status--${kind || 'idle'}`
	}

	/**
	 * 写一行状态：视图内 `#share-status` + 全局状态栏。
	 *
	 * 全局状态栏只在共享视图可见时写 —— 否则一次后台刷新会把别的视图
	 * 刚写好的状态文案冲掉。
	 */
	function report(text, kind) {
		viewStatus = { text: text ?? '', kind: kind ?? 'idle' }
		paintViewStatus()
		if (els.root && !els.root.hidden)
			setStatus(viewStatus.text, viewStatus.kind)
	}

	/**
	 * 把 state 里的状态文案画到视图内的状态行上。
	 *
	 * ⚠️ 必须按 `data-testid` 查（而不是 `getElementById`）：状态行是每次
	 * `render()` 重建的节点，只有 `data-testid` 会跟着重建走。第一版用
	 * `getElementById('share-status')` 但 `el()` 并不写 `id`，于是状态行永远
	 * 停在首屏那一句「尚未读取共享状态」—— 所有动作的结果文案都写不进去
	 * （UI 探针读 `[data-testid="share-status"]` 时抓到）。
	 */
	function paintViewStatus() {
		const node = els.root?.querySelector('[data-testid="share-status"]')
		if (!node) return
		node.textContent = viewStatus.text
		node.className = `share-status share-status--${viewStatus.kind}`
	}

	/** 建元素的小工具：`el('div', 'a b', 'testid')` */
	function el(tag, className, testid) {
		const node = document.createElement(tag)
		if (className) node.className = className
		if (testid) node.dataset.testid = testid
		return node
	}

	/** 输入框：id 与 data-testid 同名，方便 `getElementById` 直接读值 */
	function inputEl(
		testid,
		{ type = 'text', placeholder, value, autocomplete } = {},
	) {
		const input = el('input', null, testid)
		input.id = testid
		input.type = type
		input.spellcheck = false
		if (placeholder) input.placeholder = placeholder
		if (value) input.value = value
		if (autocomplete) input.autocomplete = autocomplete
		return input
	}

	/** 带标签的输入框（标签点击聚焦，便于键盘操作） */
	function field(labelText, input) {
		const box = el('div', 'share-field')
		const label = document.createElement('label')
		label.textContent = labelText
		label.htmlFor = input.id
		box.append(label, input)
		return box
	}

	function buttonEl(
		testid,
		text,
		onClick,
		{ danger = false, action = null } = {},
	) {
		const button = el('button', danger ? 'is-danger' : null, testid)
		button.id = testid
		button.textContent = text
		// 行内动作另外用 `data-action` 标记：探针（和未来的快捷键）靠它定位，
		// 比 testid 更稳定（testid 里带歌单 id，值每次都可能不同）
		if (action) button.dataset.action = action
		button.addEventListener('click', onClick)
		return button
	}

	function hint(text) {
		const node = el('p', 'muted share-hint')
		node.textContent = text
		return node
	}

	function valueOf(id) {
		const node = document.getElementById(id)
		return node ? node.value : ''
	}

	function setValueOf(id, value) {
		const node = document.getElementById(id)
		if (node) node.value = value
	}

	/** 重绘前把输入框里的内容存回 state（否则会被下一次重绘抹掉） */
	function captureInputs() {
		const url = document.getElementById('share-url-input')
		if (url) state.url = url.value
		const invite = document.getElementById('share-invite-input')
		if (invite) state.inviteCode = invite.value
	}

	/**
	 * 所有异步动作的统一外壳：禁用按钮 → 执行 → 恢复按钮。
	 *
	 * 按钮上的临时文案只是视觉反馈（避免用户重复点）；执行期间的进度/结果由
	 * 动作自己写状态行。重绘会把按钮节点换掉，所以恢复前先确认它还在文档里
	 * （`isConnected`），否则会去改一个已经脱离文档的节点（无害但没意义）。
	 */
	async function runAction(button, busyText, work) {
		const original = button?.textContent ?? null
		if (button) {
			button.disabled = true
			if (busyText) button.textContent = busyText
		}
		try {
			await work()
		} catch (error) {
			// IPC 本身失败（理论上 handler 已经包成 ok:false）也要落到界面上
			report(`操作异常：${error?.message ?? String(error)}`, 'bad')
		} finally {
			if (button?.isConnected) {
				button.disabled = false
				if (original !== null) button.textContent = original
			}
		}
	}

	/**
	 * 复制到剪贴板。
	 *
	 * ⚠️ 剪贴板**可能不可用**（无权限 / 非安全上下文 / 无头环境）。失败时返回
	 * false，由调用方把链接显示成只读输入框让人手工复制 —— 而不是静默失败，
	 * 也不是把链接丢掉。
	 */
	async function writeClipboard(text) {
		try {
			if (!navigator.clipboard?.writeText) return false
			await navigator.clipboard.writeText(text)
			return true
		} catch {
			return false
		}
	}

	/**
	 * 就地（**不重绘**）往某一行的反馈区塞一行文字。
	 *
	 * 为什么不用 `setRowInfo + render()`：这些动作的请求要走网络，可能在 1 秒
	 * 以上；而重绘会换掉按钮节点，`runAction` 刚设上的 `disabled` 就丢了（按钮
	 * 在请求期间又变成可点）。就地插一行占位既能让用户/探针马上看到反馈，
	 * 又保住了按钮的禁用状态。数据回来后由 `render()` 重建完整结构。
	 *
	 * ⚠️ 占位行的 testid 必须带 `-loading` 后缀，**不能**复用结果元素的
	 * `data-testid`：否则探针会把「正在读取…」当成结果读到，断言就失去意义
	 * （第一版就是这样让「成员列表里有创建者」误报失败的）。
	 */
	function showInlineInfo(playlistId, text, kind, testid) {
		const row = document.querySelector(
			`[data-testid="share-row"][data-share-id="${playlistId}"]`,
		)
		const info = row?.querySelector('[data-share-info]')
		if (!info) return
		info.hidden = false
		info.textContent = ''
		const note = el('p', `share-note share-note--${kind ?? 'busy'}`, testid)
		note.textContent = text
		info.appendChild(note)
	}

	/** 相对时间（与 history.js 同一套措辞，两处都只服务自己的视图） */
	function formatRelative(ms) {
		if (!ms) return '从未同步'
		const diff = Date.now() - ms
		if (diff < 60_000) return '刚刚'
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
		const days = Math.floor(diff / 86_400_000)
		if (days < 30) return `${days} 天前`
		return new Date(ms).toLocaleDateString('zh-CN')
	}

	/**
	 * 绝对时间：后端可能给毫秒时间戳（`track_count` 那种 pg 字符串也一样），
	 * 也可能给 ISO 串。**不要**把原始值直接贴到界面上 —— 用户看到的会是
	 * `1789671237658` 这种数字（实测在预览里就是这样）。
	 */
	function formatTimestamp(value) {
		if (value === null || value === undefined || value === '') return null
		const ms = typeof value === 'number' ? value : Date.parse(value)
		if (!Number.isFinite(ms)) return String(value)
		return new Date(ms).toLocaleString('zh-CN', { hour12: false })
	}

	function findShared(playlistId) {
		const list = state.account?.sharedPlaylists ?? []
		return list.find((item) => item.id === playlistId) ?? null
	}

	function setRowInfo(playlistId, patch) {
		// 邀请码与成员列表是「一次只看一个」的：探针用
		// `document.querySelector('[data-testid="share-invite"]')` 取（同名元素
		// 只能有一个），多行同时展开会让它读到别的行。所以开一个就关掉其余的。
		if (patch.invite || patch.members) {
			for (const [id, info] of state.rowInfo) {
				if (id === playlistId) continue
				if (patch.invite) info.invite = null
				if (patch.members) info.members = null
			}
		}
		state.rowInfo.set(playlistId, {
			// `{ ...undefined }` 本来就是合法的空展开，`?? {}` 是多余的兜底
			...state.rowInfo.get(playlistId),
			...patch,
		})
	}

	/**
	 * 不可逆操作的二次确认。
	 *
	 * ⚠️ 探针模式下（`window.bbProbe` 只在 `--*-probe` 启动时由 preload 暴露）
	 * **直接放行**：`executeJavaScript` 驱动的点击没有人能去点那个原生确认框，
	 * 确认框要么返回 false、要么把渲染进程挂住，探针就永远等不到结果。
	 * 正常启动时 `bbProbe` 不存在，所以真人操作**一定**会看到确认框。
	 */
	function confirmDestructive(message) {
		if (typeof window.bbProbe !== 'undefined') return true
		return window.confirm(message)
	}

	// ---------------------------------------------------------------
	// 渲染
	// ---------------------------------------------------------------

	function render() {
		const root = els.root
		if (!root) return
		captureInputs()
		root.textContent = ''

		root.appendChild(renderHead())
		root.appendChild(statusLine())
		root.appendChild(renderAccountSection())
		root.appendChild(renderSubscribeSection())
		root.appendChild(renderPlaylistSection())
		// 重建过 DOM 之后把状态文案补回去（状态行是新建的节点，字面量只是初值）
		paintViewStatus()
	}

	function renderHead() {
		/*
		 * ⚠️ 这里**不再**渲染「共享歌单」标题。
		 *
		 * 标题由外壳的 `#page-title` 统一负责（阶段 2b 定的规矩：
		 * 标题只有一处）。视图自己再来一个 h2 就会出现两个一模一样的标题 ——
		 * 设置页踩过同一个坑（截图里一眼可见）。
		 *
		 * 这一行只留右侧的账号摘要。
		 */
		const head = el('div', 'share-head')
		const summary = el('span', 'muted', 'share-account-status')
		summary.textContent = describeAccountSummary()
		head.appendChild(summary)
		return head
	}

	/** 账号摘要（`share-account-status`）：探针与用户都靠它一眼看登录态 */
	function describeAccountSummary() {
		const account = state.account
		if (!account) return '正在读取本地共享状态…'
		if (!account.loggedIn)
			return '未登录（可以预览与订阅，登录后才能分享自己的歌单）'
		// 昵称与用户名都给出来：探针按用户名等待登录态，而用户更认得昵称
		const parts = [account.account?.name, account.account?.username].filter(
			Boolean,
		)
		return `已登录：${parts.length > 0 ? parts.join(' / ') : '已登录'}`
	}

	function statusLine() {
		const node = el('p', 'share-status', 'share-status')
		node.textContent = viewStatus.text
		node.className = `share-status share-status--${viewStatus.kind}`
		return node
	}

	/** 账号区：未登录给登录/注册，已登录给账号信息 + 退出 + 从云端恢复 */
	function renderAccountSection() {
		const section = el('section', 'share-section', 'share-account')
		const heading = document.createElement('h3')
		heading.textContent = '账号'
		section.appendChild(heading)

		const account = state.account
		if (account?.loggedIn) renderLoggedIn(section, account)
		else renderLoggedOut(section, account)
		return section
	}

	function renderLoggedOut(section, account) {
		section.appendChild(
			hint(
				`共享歌单用的是 BBPlayer 账号（与 B 站登录无关）。` +
					// ⚠️ 只说用户要遵守的规则（几位），
					// 不说我们怎么校验（"本地先行校验""不发出网络请求"）——
					// 那是实现细节，用户照做就行。
					`用户名至少 ${USERNAME_MIN} 位，密码至少 ${PASSWORD_MIN} 位。`,
			),
		)

		const grid = el('div', 'share-grid')
		const username = inputEl('share-username', {
			placeholder: `用户名（至少 ${USERNAME_MIN} 位）`,
			autocomplete: 'off',
		})
		const password = inputEl('share-password', {
			type: 'password',
			placeholder: `密码（至少 ${PASSWORD_MIN} 位）`,
			autocomplete: 'new-password',
		})
		const display = inputEl('share-display-name', {
			placeholder: '昵称（可选，仅注册用）',
			autocomplete: 'off',
		})
		grid.append(
			field('用户名', username),
			field('密码', password),
			field('昵称', display),
		)
		section.appendChild(grid)

		const actions = el('div', 'row-actions')
		const loginButton = buttonEl(
			'share-login',
			'登录',
			() => void login(loginButton),
		)
		const registerButton = buttonEl(
			'share-register',
			'注册',
			() => void register(registerButton),
		)
		actions.append(loginButton, registerButton)
		section.appendChild(actions)

		// 回车即提交（与登录弹窗一致）
		for (const input of [username, password]) {
			input.addEventListener('keydown', (event) => {
				if (event.key === 'Enter') void login(loginButton)
			})
		}

		if (account === null) {
			section.appendChild(
				hint('正在读取本地共享状态；读取失败时这里会显示原因。'),
			)
		}
	}

	function renderLoggedIn(section, account) {
		const info = account.account ?? {}
		// 账号区只回答一件事：**你现在是谁**。
		//
		// 原来这里是一个 `key: value` 表，列出名称 / 用户名 / **账号 ID（UUID）** /
		// **后端 URL** / 登录时间，下面还有一段「令牌已由系统密钥环加密存储」
		// 或「⚠️ 未加密…等同明文」。对照移动端，同一个功能只有一行：
		// `BBPlayer 账号 · 御坂代理服务（@御坂鱼板）`。
		//
		// 账号 ID 与登录时间对用户没有任何用处（UUID 更是只能让人紧张）；
		// 后端地址与令牌存储方式属于诊断信息，见「设置 › 备份 › 诊断信息」。
		const list = el('dl', 'login-account__list')
		const rows = [
			['名称', info.name ?? '—'],
			['用户名', info.username ?? '—'],
		]
		for (const [label, value] of rows) {
			const dt = document.createElement('dt')
			dt.textContent = label
			const dd = document.createElement('dd')
			dd.textContent = value
			dd.title = value
			list.append(dt, dd)
		}
		section.appendChild(list)

		const actions = el('div', 'row-actions')
		const logoutButton = buttonEl(
			'share-logout',
			'退出登录',
			() => void logout(logoutButton),
		)
		const restoreButton = buttonEl(
			'share-restore',
			'从云端恢复歌单',
			() => void restore(restoreButton),
		)
		actions.append(logoutButton, restoreButton)
		section.appendChild(actions)
	}

	/** 订阅区：链接 + 邀请码 + 预览（预览不需要登录） */
	function renderSubscribeSection() {
		const section = el('section', 'share-section', 'share-subscribe-section')
		const heading = document.createElement('h3')
		heading.textContent = '订阅共享歌单'
		section.appendChild(heading)

		section.appendChild(
			hint(
				// 不说"形如 8-4-4-4-12 的十六进制"——那是 ID 的格式细节，
				// 用户手上拿到的是别人给的链接，粘贴进来就行。
				'粘贴别人给你的分享链接或歌单 ID。' +
					'「预览」不需要登录；点「订阅」才需要 BBPlayer 账号。',
			),
		)

		const grid = el('div', 'share-grid')
		grid.append(
			field(
				'分享链接 / ID',
				inputEl('share-url-input', {
					placeholder: 'https://bbplayer.roitium.com/share/playlist?shareId=…',
					value: state.url,
					autocomplete: 'off',
				}),
			),
			field(
				'邀请码（可选）',
				inputEl('share-invite-input', {
					placeholder: '有邀请码可升级为编辑者',
					value: state.inviteCode,
					autocomplete: 'off',
				}),
			),
		)
		section.appendChild(grid)

		const actions = el('div', 'row-actions')
		const previewButton = buttonEl(
			'share-preview',
			'预览',
			() => void preview(previewButton),
		)
		const subscribeButton = buttonEl(
			'share-subscribe',
			'订阅',
			() => void subscribe(subscribeButton),
		)
		actions.append(previewButton, subscribeButton)
		section.appendChild(actions)

		section.appendChild(renderPreviewResult())
		return section
	}

	function renderPreviewResult() {
		const box = el('div', 'share-preview', 'share-preview-result')

		if (state.previewError) {
			const error = el('p', 'share-preview__error')
			error.textContent = state.previewError
			box.appendChild(error)
		}

		// ⚠️ 不要叫 `preview` —— 外层已经有一个同名标识符，内层再声明会遮蔽它
		// （`no-shadow` 抓到的）。当前读起来"恰好对"，但那种遮蔽正是
		// "改了一个、另一个没改"的温床。
		const previewState = state.preview
		if (!previewState) {
			if (!state.previewError) {
				const empty = el('p', 'muted')
				empty.textContent = '还没有预览内容。'
				box.appendChild(empty)
			}
			return box
		}

		const title = el('div', 'share-preview__title')
		title.textContent = previewState.title ?? '(无标题)'
		box.appendChild(title)

		const owner = previewState.owner
		const meta = el('div', 'muted share-preview__meta')
		meta.dataset.testid = 'share-preview-meta'
		const updated = formatTimestamp(previewState.updatedAt)
		meta.textContent =
			`${previewState.trackCount ?? 0} 首` +
			(owner ? ` · 拥有者：${owner.name ?? '—'}` : ' · 拥有者：未知') +
			(updated ? ` · 更新于 ${updated}` : '')
		box.appendChild(meta)

		if (previewState.description) {
			const description = el('p', 'muted share-preview__desc')
			description.textContent = previewState.description
			box.appendChild(description)
		}

		const tracks = previewState.tracks ?? []
		if (tracks.length > 0) {
			const list = el('ol', 'share-preview__tracks')
			list.dataset.testid = 'share-preview-tracks'
			for (const track of tracks.slice(0, 10)) {
				const item = document.createElement('li')
				item.textContent = `${track.title ?? '(无标题)'}${track.artistName ? ` — ${track.artistName}` : ''}`
				list.appendChild(item)
			}
			box.appendChild(list)

			if ((previewState.trackCount ?? 0) > tracks.length) {
				box.appendChild(
					hint(
						`预览只返回前 ${tracks.length} 首（服务端上限 ${previewState.previewLimit ?? '?'}）。` +
							`订阅后会把全部 ${previewState.trackCount} 首拉下来。`,
					),
				)
			}
		} else {
			box.appendChild(hint('这个共享歌单目前没有曲目。'))
		}

		const link = el('p', 'muted mono share-preview__link')
		link.textContent = previewState.shareLink ?? ''
		box.appendChild(link)
		return box
	}

	/** 我的共享歌单列表 */
	function renderPlaylistSection() {
		const section = el('section', 'share-section', 'share-playlists')
		const heading = document.createElement('h3')
		heading.textContent = '我的共享歌单'
		section.appendChild(heading)

		const list = state.account?.sharedPlaylists ?? []

		const actions = el('div', 'row-actions')
		const syncAllButton = buttonEl(
			'share-sync-all',
			'全部同步',
			() => void syncAll(syncAllButton),
		)
		actions.appendChild(syncAllButton)
		section.appendChild(actions)

		const results = renderSyncAllResults()
		if (results) section.appendChild(results)

		const ul = el('ul', 'share-list', 'share-list')
		if (list.length === 0) {
			const empty = el('li', 'empty muted', 'share-list-empty')
			empty.textContent =
				'还没有共享歌单。在左栏的歌单上点「分享」就会出现在这里。'
			ul.appendChild(empty)
		} else {
			for (const playlist of list) ul.appendChild(renderRow(playlist))
		}
		section.appendChild(ul)
		return section
	}

	function renderSyncAllResults() {
		const results = state.syncAll
		if (!results || results.length === 0) return null
		const box = el('div', 'share-results', 'share-sync-all-result')
		for (const item of results) {
			const row = el('div', 'share-results__row')
			row.dataset.testid = `share-sync-all-row-${item.id}`
			if (item.error) {
				row.classList.add('share-results__row--bad')
				row.textContent = `「${item.title ?? item.id}」失败：${item.error}`
			} else {
				row.textContent =
					`「${item.title ?? item.id}」推送 ${item.pushed ?? 0} · ` +
					`丢弃 ${item.dropped ?? 0} · 失败 ${item.failed ?? 0} · ` +
					`应用 ${item.applied ?? 0}`
			}
			box.appendChild(row)
		}
		return box
	}

	function renderRow(playlist) {
		const id = playlist.id
		const role = playlist.shareRole ?? 'subscriber'
		const info = state.rowInfo.get(id) ?? {}

		const row = el('li', 'share-row', 'share-row')
		row.dataset.shareId = String(id)
		row.dataset.shareRole = String(role)

		const top = el('div', 'share-row__top')
		const title = el('div', 'share-row__title')
		title.textContent = playlist.title ?? `歌单 #${id}`
		title.title = title.textContent
		top.appendChild(title)

		const roleBadge = el(
			'div',
			`share-badge share-badge--${role}`,
			`share-role-${id}`,
		)
		roleBadge.textContent = ROLE_LABEL[role] ?? role
		top.appendChild(roleBadge)
		row.appendChild(top)

		const meta = el('div', 'muted share-row__meta', `share-row-meta-${id}`)
		const parts = [
			`${ROLE_LABEL[role] ?? role}（${ROLE_DESC[role] ?? '角色未知'}）`,
			`${playlist.itemCount ?? 0} 首`,
			`上次同步：${formatRelative(playlist.lastShareSyncAt)}`,
		]
		meta.textContent = parts.join(' · ')
		row.appendChild(meta)

		if (Number(playlist.pendingCount ?? 0) > 0 || role === 'subscriber') {
			const badges = el('div', 'share-row__badges')
			if (Number(playlist.pendingCount ?? 0) > 0) {
				// 待同步的改动**必须可见**，否则用户以为「已同步」，
				// 实际改动还没推上去。但不必露出「outbox / 条数」这种内部概念，
				// 一个带小圆点的「同步中」就够表达状态了（条数放进 title 供排查）。
				const pending = el(
					'div',
					'share-badge share-badge--pending',
					`share-pending-${id}`,
				)
				pending.textContent = '同步中'
				pending.title = `${playlist.pendingCount} 项改动待上传`
				badges.appendChild(pending)
			}
			if (role === 'subscriber') {
				const readonly = el(
					'div',
					'share-badge share-badge--readonly',
					`share-readonly-${id}`,
				)
				readonly.textContent = '只读'
				badges.appendChild(readonly)
			}
			row.appendChild(badges)
		}

		const actions = el('div', 'row-actions share-row__actions')

		// 同步：任何成员都能拉取，所以订阅者也有这个按钮（推送会被主进程按角色丢弃）
		const syncButton = buttonEl(
			`share-sync-${id}`,
			'同步',
			() => void sync(id, syncButton),
			{ action: 'sync' },
		)
		actions.appendChild(syncButton)

		const linkButton = buttonEl(
			`share-link-${id}`,
			'分享链接',
			() => void copyLink(id),
			{ action: 'copy-link' },
		)
		actions.appendChild(linkButton)

		// 邀请码只属于 owner：其它角色**不渲染**这个按钮（而不是禁用）——
		// 服务端也会 403，界面上不该摆一个必然失败的入口
		if (playlist.isOwner === true || role === 'owner') {
			const inviteButton = buttonEl(
				`share-invite-${id}`,
				'邀请码',
				() => void loadInvite(id, inviteButton),
				{ action: 'invite' },
			)
			actions.appendChild(inviteButton)
		}

		const membersButton = buttonEl(
			`share-members-${id}`,
			'成员',
			() => void loadMembers(id, membersButton),
			{ action: 'members' },
		)
		actions.appendChild(membersButton)

		const leaveButton = buttonEl(
			`share-unshare-${id}`,
			role === 'owner' ? '取消共享' : '退出共享',
			() => void unshare(id, leaveButton),
			{ danger: true, action: 'unshare' },
		)
		actions.appendChild(leaveButton)

		row.appendChild(actions)
		row.appendChild(renderRowInfo(id, info))
		return row
	}

	/** 行内反馈区：链接 / 邀请码 / 成员列表都写在这里 */
	function renderRowInfo(playlistId, info) {
		const box = el('div', 'share-row__info')
		box.dataset.testid = `share-row-info-${playlistId}`
		// 给 `showInlineInfo` 用的稳定钩子（testid 里带 id，值每次都可能不同）
		box.dataset.shareInfo = ''

		if (info.note) {
			const note = el('p', `share-note share-note--${info.note.kind ?? 'idle'}`)
			note.dataset.testid = `share-note-${playlistId}`
			note.textContent = info.note.text
			box.appendChild(note)
		}

		if (info.link) {
			// 剪贴板不可用时的兜底：只读输入框，选中即可手工复制
			const caption = el('p', 'muted share-note')
			caption.textContent = '链接（可手动复制）：'
			box.appendChild(caption)
			const wrap = el('div', 'share-inline-link')
			const input = inputEl(`share-link-input-${playlistId}`, {
				value: info.link,
			})
			input.readOnly = true
			wrap.appendChild(input)
			box.appendChild(wrap)
		}

		// 邀请码区：`share-invite` 是固定 testid（一次只开一行，见 setRowInfo）
		if (info.invite) {
			const inviteBox = el('div', 'share-invite-box', 'share-invite')
			const note = el(
				'p',
				`share-note share-note--${info.invite.kind ?? 'idle'}`,
				`share-invite-note-${playlistId}`,
			)
			note.textContent = info.invite.text
			inviteBox.appendChild(note)

			if (info.invite.needsRotate) {
				const inviteActions = el('div', 'row-actions')
				const rotateButton = buttonEl(
					'share-invite-rotate',
					'生成邀请码',
					() => void rotateInvite(playlistId, rotateButton),
				)
				rotateButton.dataset.action = 'invite-rotate'
				inviteActions.appendChild(rotateButton)
				inviteBox.appendChild(inviteActions)
			}
			box.appendChild(inviteBox)
		}

		// 成员区：`share-members` 同样是固定 testid，提示也放在里面
		// （否则读这个元素的探针会漏掉「订阅者不可见」那句说明）
		if (info.members) {
			const membersBox = el('div', 'share-members-box', 'share-members')
			const list = el('ul', 'share-members')
			if (info.members.length === 0) {
				const empty = document.createElement('li')
				empty.className = 'muted'
				empty.textContent = '没有读到成员。'
				list.appendChild(empty)
			}
			for (const member of info.members) {
				const item = document.createElement('li')
				item.textContent = `${member.name ?? member.accountId ?? '—'}（${ROLE_LABEL[member.role] ?? member.role ?? '未知'}）`
				list.appendChild(item)
			}
			membersBox.appendChild(list)

			if (info.canSeeSubscribers === false) {
				// 不能静默地给一份更短的名单 —— 必须说明为什么少了订阅者。
				//
				// ⚠️ 但**不写"服务端 403"**：那是实现细节。用户要知道的是
				// "为什么名单短了"，而不是我们调了哪个接口、它回了什么状态码。
				const note = el('p', 'muted share-note')
				note.textContent =
					'你的角色看不到订阅者：' +
					`下面${info.membersFrom === 'cache' ? '是上次同步时记录到的协作者' : '只有协作者'}，不含订阅者。`
				membersBox.appendChild(note)
			}
			box.appendChild(membersBox)
		}

		if (box.childElementCount === 0) box.hidden = true
		return box
	}

	// ---------------------------------------------------------------
	// 账号动作
	// ---------------------------------------------------------------

	/** 与 `bbplayer-account.cjs` 的 `validateCredentials` 同规则，返回错误文案或 null */
	function validateCredentials(username, password) {
		if (!username) return '请填写用户名'
		if (username.length < USERNAME_MIN) return `用户名至少 ${USERNAME_MIN} 位`
		if (!password) return '请填写密码'
		if (password.length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位`
		return null
	}

	async function login(button) {
		const username = valueOf('share-username').trim()
		const password = valueOf('share-password')
		const problem = validateCredentials(username, password)
		if (problem) {
			report(problem, 'bad')
			return
		}

		await runAction(button, '登录中…', async () => {
			report('登录中…', 'busy')
			const result = await window.bbplayer.share.login({ username, password })
			// ⚠️ 清密码放在结果判断**之前**：失败路径同样需要清干净
			// （auth.js 第一版把清理放在成功分支里，被探针抓到）
			setValueOf('share-password', '')
			const data = result?.ok === true ? result.data : null
			await refresh()
			if (!data) {
				report(describeFailure(result, '登录'), 'bad')
				return
			}
			// 登录成功就说登录成功。令牌存得加不加密是诊断信息
			// （见「设置 › 备份 › 诊断信息」），不是登录结果的反馈。
			report(`登录成功：${data.account?.name ?? username}`, 'ok')
		})
	}

	async function register(button) {
		const username = valueOf('share-username').trim()
		const password = valueOf('share-password')
		const display = valueOf('share-display-name').trim()
		const problem = validateCredentials(username, password)
		if (problem) {
			report(problem, 'bad')
			return
		}

		await runAction(button, '注册中…', async () => {
			report('注册中…', 'busy')
			const payload = { username, password }
			if (display) payload.name = display
			const result = await window.bbplayer.share.register(payload)
			setValueOf('share-password', '')
			const data = result?.ok === true ? result.data : null
			await refresh()
			if (!data) {
				report(describeFailure(result, '注册'), 'bad')
				return
			}
			report(
				`注册成功并已登录：${data.account?.name ?? username}`,
				data.encrypted ? 'ok' : 'busy',
			)
		})
	}

	async function logout(button) {
		await runAction(button, '退出中…', async () => {
			report('退出登录中…', 'busy')
			const result = await window.bbplayer.share.logout()
			await refresh()
			if (result?.ok !== true) {
				report(describeFailure(result, '退出登录'), 'bad')
				return
			}
			report('已退出 BBPlayer 账号（本地共享标记不受影响）', 'ok')
		})
	}

	/**
	 * 改后端地址。
	 *
	 * UI 已经搬到「设置 › 备份 › 诊断信息」（那里的输入框直接调
	 * `share.setBaseUrl`），这里保留一个**带参数**的入口供自动化驱动同一条
	 * 代码路径 —— 注意它不再去读页面上的输入框，因为那个输入框已经不在这个
	 * 模块里了（第一版还写着 `valueOf('share-base-url')`，搬迁之后会永远取到
	 * 空字符串并报「请填写后端地址」）。
	 */
	async function applyBaseUrl(button, url) {
		const next = String(url ?? '').trim()
		if (!next) {
			report('请填写后端地址', 'bad')
			return
		}

		await runAction(button, '保存中…', async () => {
			const result = await window.bbplayer.share.setBaseUrl(next)
			const data = result?.ok === true ? result.data : null
			await refresh()
			if (!data) {
				report(describeFailure(result, '修改后端地址'), 'bad')
				return
			}
			report('后端地址已更新', 'ok')
		})
	}

	async function restore(button) {
		await runAction(button, '恢复中…', async () => {
			report('从云端恢复中…', 'busy')
			const result = await window.bbplayer.share.restore()
			const data = result?.ok === true ? result.data : null
			await refresh()
			// 左栏歌单列表也要跟着更新（恢复会新建本地歌单）
			await window.bbLibrary?.refreshPlaylists?.()
			if (!data) {
				report(describeFailure(result, '从云端恢复'), 'bad')
				return
			}
			const restored = data.restored?.length ?? 0
			const failed = data.failed?.length ?? 0
			const failureNote =
				failed > 0
					? `；失败：${(data.failed ?? []).map((item) => item.error ?? item.shareId).join('；')}`
					: ''
			report(
				`恢复完成：新增 ${restored} 个；云端 ${data.remoteCount ?? 0} 个 / 本地原有 ${data.localCount ?? 0} 个${failureNote}`,
				failed > 0 ? 'bad' : 'ok',
			)
		})
	}

	// ---------------------------------------------------------------
	// 订阅动作
	// ---------------------------------------------------------------

	async function preview(button) {
		captureInputs()
		const input = state.url.trim()
		if (!input) {
			report('请先粘贴分享链接或歌单 ID', 'bad')
			return
		}

		await runAction(button, '预览中…', async () => {
			report('预览中…正在读取共享歌单', 'busy')
			const result = await window.bbplayer.share.preview(input)
			const data = result?.ok === true ? result.data : null
			if (!data) {
				state.preview = null
				state.previewError = describeFailure(result, '预览')
				render()
				report(state.previewError, 'bad')
				return
			}
			state.preview = data
			state.previewError = null
			// 链接里带的邀请码自动填进输入框（用户不必再抄一遍）
			if (!state.inviteCode && data.inviteCode)
				state.inviteCode = data.inviteCode
			render()
			report(
				`已读取「${data.title ?? '(无标题)'}」（${data.trackCount ?? 0} 首）—— 预览不需要登录，订阅需要`,
				'ok',
			)
		})
	}

	async function subscribe(button) {
		captureInputs()
		const input = state.url.trim()
		if (!input) {
			report('请先粘贴分享链接或歌单 ID', 'bad')
			return
		}
		const inviteCode =
			state.inviteCode.trim() || state.preview?.inviteCode || ''

		await runAction(button, '订阅中…', async () => {
			report('订阅中…', 'busy')
			const result = await window.bbplayer.share.subscribe({
				input,
				inviteCode: inviteCode || null,
			})
			const data = result?.ok === true ? result.data : null
			await refresh()
			await window.bbLibrary?.refreshPlaylists?.()
			if (!data) {
				report(describeFailure(result, '订阅'), 'bad')
				return
			}
			const local = (state.account?.sharedPlaylists ?? []).find(
				(item) => item.id === data.localPlaylistId,
			)
			const title = local?.title ?? state.preview?.title ?? '共享歌单'
			const role = ROLE_LABEL[data.role] ?? data.role ?? '订阅者'
			const notes = []
			if (data.alreadySubscribed) notes.push('此前已订阅，已重新拉取')
			if (data.upgraded) notes.push('已用邀请码升级为编辑者')
			if (typeof data.applied === 'number')
				notes.push(`应用 ${data.applied} 条改动`)
			report(
				`已订阅「${title}」（角色：${role}）${notes.length > 0 ? ` · ${notes.join(' · ')}` : ''}`,
				data.role === 'subscriber' ? 'busy' : 'ok',
			)
		})
	}

	// ---------------------------------------------------------------
	// 共享歌单行内动作
	// ---------------------------------------------------------------

	async function sync(playlistId, button) {
		await runAction(button, '同步中…', async () => {
			report('同步中…', 'busy')
			const result = await window.bbplayer.share.sync(playlistId)
			const data = result?.ok === true ? result.data : null
			await refresh()
			if (!data) {
				report(describeFailure(result, '同步'), 'bad')
				return
			}
			const failed = Number(data.failed ?? 0)
			const dropped = Number(data.dropped ?? 0)
			const title = findShared(playlistId)?.title ?? `歌单 #${playlistId}`
			report(
				`「${title}」同步完成：推送 ${data.pushed ?? 0} · 丢弃 ${dropped} · 失败 ${failed} · 应用 ${data.applied ?? 0}` +
					(dropped > 0 ? '（丢弃＝角色不可写或已不是共享歌单，不会重试）' : ''),
				failed > 0 ? 'bad' : 'ok',
			)
		})
	}

	async function syncAll(button) {
		captureInputs()
		const total = state.account?.sharedPlaylists?.length ?? 0
		if (total === 0) {
			// 没有目标就别发网络请求
			state.syncAll = []
			render()
			report('没有共享歌单需要同步（先在左栏歌单上点「分享」）', 'busy')
			return
		}

		await runAction(button, '同步中…', async () => {
			report(`同步中…（${total} 个共享歌单）`, 'busy')
			const result = await window.bbplayer.share.syncAll()
			const list = result?.ok === true ? (result.data ?? []) : null
			state.syncAll = list
			await refresh()
			if (!list) {
				report(describeFailure(result, '全部同步'), 'bad')
				return
			}
			render()
			const problems = list.filter(
				(item) => item.error || Number(item.failed ?? 0) > 0,
			)
			report(
				`全部同步完成：${list.length} 个歌单，${problems.length} 个有问题` +
					(problems.length > 0
						? `（${problems.map((item) => item.title ?? item.id).join('、')}）`
						: ''),
				problems.length > 0 ? 'bad' : 'ok',
			)
		})
	}

	async function copyLink(playlistId) {
		const playlist = findShared(playlistId)
		const link = playlist?.shareLink ?? null
		if (!link) {
			setRowInfo(playlistId, {
				note: { text: '这条记录没有分享链接（数据异常）', kind: 'bad' },
			})
			render()
			report('这条共享记录没有分享链接', 'bad')
			return
		}

		const copied = await writeClipboard(link)
		setRowInfo(playlistId, {
			note: copied
				? { text: '分享链接已复制到剪贴板', kind: 'ok' }
				: { text: '剪贴板不可用，请手动复制下面的链接', kind: 'busy' },
			// 复制失败时把链接显示成只读输入框，不能让它只存在于状态栏里
			link: copied ? null : link,
		})
		render()
		report(
			copied ? `已复制分享链接：${link}` : `剪贴板不可用，请手动复制：${link}`,
			copied ? 'ok' : 'busy',
		)
	}

	async function loadInvite(playlistId, button) {
		await runAction(button, '读取中…', async () => {
			showInlineInfo(
				playlistId,
				'正在读取邀请码…',
				'busy',
				'share-invite-loading',
			)
			report('邀请码读取中…', 'busy')
			const result = await window.bbplayer.share.invite(playlistId)
			const data = result?.ok === true ? result.data : null
			await refresh()
			if (!data) {
				report(describeFailure(result, '读取邀请码'), 'bad')
				return
			}
			// `inviteCode === null` 是**合法**的：owner 还没生成过，要 rotate 一次
			if (data.inviteCode === null || data.inviteCode === undefined) {
				setRowInfo(playlistId, {
					invite: {
						text: '还没有邀请码（服务端返回 null）—— 需要生成一个才能邀请协作者',
						kind: 'busy',
						needsRotate: true,
					},
					link: null,
				})
				render()
				report('这个歌单还没有邀请码，点「生成邀请码」创建一个', 'busy')
				return
			}
			setRowInfo(playlistId, {
				invite: {
					text: `邀请码：${data.inviteCode}`,
					kind: 'ok',
					needsRotate: false,
				},
				link: data.shareLink ?? null,
			})
			render()
			report(`邀请码：${data.inviteCode}`, 'ok')
		})
	}

	async function rotateInvite(playlistId, button) {
		await runAction(button, '生成中…', async () => {
			showInlineInfo(
				playlistId,
				'正在生成邀请码…',
				'busy',
				'share-invite-loading',
			)
			report('邀请码生成中…', 'busy')
			const result = await window.bbplayer.share.rotateInvite(playlistId)
			const data = result?.ok === true ? result.data : null
			await refresh()
			if (!data || !data.inviteCode) {
				report(
					data
						? '生成邀请码失败：后端没有返回邀请码'
						: describeFailure(result, '生成邀请码'),
					'bad',
				)
				return
			}
			setRowInfo(playlistId, {
				invite: {
					text: `新的邀请码：${data.inviteCode}`,
					kind: 'ok',
					needsRotate: false,
				},
				link: data.shareLink ?? null,
			})
			render()
			report(`已生成新的邀请码：${data.inviteCode}（旧的邀请码已失效）`, 'ok')
		})
	}

	async function loadMembers(playlistId, button) {
		await runAction(button, '读取中…', async () => {
			showInlineInfo(
				playlistId,
				'正在读取成员…',
				'busy',
				'share-members-loading',
			)
			report('成员读取中…', 'busy')
			const result = await window.bbplayer.share.members(playlistId)
			const data = result?.ok === true ? result.data : null
			await refresh()
			if (!data) {
				report(describeFailure(result, '读取成员'), 'bad')
				return
			}
			const members = data.members ?? []
			setRowInfo(playlistId, {
				members,
				membersFrom: data.from ?? null,
				canSeeSubscribers: data.canSeeSubscribers !== false,
			})
			render()
			report(
				`「${findShared(playlistId)?.title ?? `歌单 #${playlistId}`}」成员 ${members.length} 人` +
					(data.canSeeSubscribers === false ? '（订阅者列表不可见）' : '') +
					(data.from === 'cache' ? '（来自本地缓存）' : ''),
				'ok',
			)
		})
	}

	async function unshare(playlistId, button) {
		const playlist = findShared(playlistId)
		const title = playlist?.title ?? `歌单 #${playlistId}`
		const isOwner =
			playlist?.isOwner === true || playlist?.shareRole === 'owner'

		// 二次确认：owner 会删远端歌单，其余角色会退出协作，两者都不可轻率
		const confirmed = confirmDestructive(
			isOwner
				? `确定取消共享「${title}」吗？\n\n远端歌单会被删除，其他协作者将不再看到它。本地歌单与曲目会保留。`
				: `确定退出共享「${title}」吗？\n\n你将不再收到它的更新。本地副本会保留，不再与远端同步。`,
		)
		if (!confirmed) return

		await runAction(button, isOwner ? '取消中…' : '退出中…', async () => {
			report(isOwner ? '取消共享中…' : '退出共享中…', 'busy')
			const result = await window.bbplayer.share.unshare(playlistId)
			const data = result?.ok === true ? result.data : null
			await refresh()
			await window.bbLibrary?.refreshPlaylists?.()
			if (!data) {
				report(
					describeFailure(result, isOwner ? '取消共享' : '退出共享'),
					'bad',
				)
				return
			}
			const remote = data.remoteError
				? `；远端清理失败：${data.remoteError}（本地标记已清除）`
				: ''
			report(
				`${isOwner ? '已取消共享' : '已退出共享'}「${title}」${remote}`,
				data.remoteError ? 'bad' : 'ok',
			)
		})
	}

	// ---------------------------------------------------------------
	// 刷新 / 对外接口
	// ---------------------------------------------------------------

	/**
	 * 刷新序号：与 `history.js` 的 `refreshSeq`、`renderer.js` 的
	 * `lyricsRequestSeq` 同一个手法 —— 并发刷新时丢弃过期结果，
	 * 否则慢的那次会把旧数据画到新数据之上。
	 */
	let refreshSeq = 0

	/**
	 * 读本地共享状态并整块重绘。
	 *
	 * `share.status()` **只读本地**（账号文件 + SQLite），不发网络请求，所以
	 * 打开视图时调用它是安全的：后端不可达时它依然返回 `ok:true`。
	 */
	async function refresh() {
		const root = els.root
		if (!root) return null
		const seq = ++refreshSeq
		try {
			const data = unwrap(await window.bbplayer.share.status(), '读取共享状态')
			if (seq !== refreshSeq) return null
			state.account = data
			render()
			/*
			 * ⚠️ 未登录时**不写状态行**。
			 *
			 * 头部已经有一行账号摘要（`share-account-status`）说了同一件事，
			 * 再写一遍状态行就是屏幕上出现两句几乎一样的话 ——
			 * 截图里一眼可见（"未登录（可以预览与订阅…）" + "未登录：可以预览…"）。
			 *
			 * 状态行留给**动作的结果**（"已加载 N 个共享歌单" / 报错），
			 * 而不是复述当前状态。
			 */
			if (data.loggedIn) {
				report(`已加载 ${data.sharedPlaylists?.length ?? 0} 个共享歌单`, 'ok')
			} else {
				report('', 'idle')
			}
			return data
		} catch (error) {
			if (seq !== refreshSeq) return null
			state.account = null
			render()
			report(error.message, 'bad')
			return null
		}
	}

	async function show() {
		// 骨架先画出来（此刻还不发任何请求），再读本地状态
		render()
		return await refresh()
	}

	// 启动时只画骨架（纯 DOM，不发 IPC），这样 `#view-share` 里的
	// data-testid 在任何时刻都能被找到；真实数据等用户点进来看时再读。
	render()

	window.bbShare = {
		show,
		refresh,
		/** 各动作直连（供自动化在点不到按钮时也能驱动同一条代码路径） */
		login,
		register,
		logout,
		applyBaseUrl,
		restore,
		preview,
		subscribe,
		sync,
		syncAll,
		copyLink,
		loadInvite,
		rotateInvite,
		loadMembers,
		unshare,
		/** 供自动化断言：当前渲染出来的钩子与账号状态摘要 */
		describe: () => ({
			account: state.account,
			loggedIn: Boolean(state.account?.loggedIn),
			sharedCount: state.account?.sharedPlaylists?.length ?? 0,
			statusText: viewStatus.text,
			statusKind: viewStatus.kind,
			previewTitle: state.preview?.title ?? null,
			previewError: state.previewError,
			syncAllCount: state.syncAll?.length ?? null,
			roleLabels: ROLE_LABEL,
			testIds: [...document.querySelectorAll('#view-share [data-testid]')].map(
				(node) => node.dataset.testid,
			),
		}),
	}
})()
