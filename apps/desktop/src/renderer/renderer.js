/**
 * 渲染进程入口：把各模块接起来。
 *
 * 职责：
 *  - 初始化视图（左栏歌单 / 中栏曲目）
 *  - 注册全局快捷键（docs/DESKTOP_PLAN.md §3.4）
 *  - 右栏面板切换
 *  - 暴露 `window.bbUI` 供自动化断言
 *  - 就绪后置 `window.__bbReady`（验证脚本据此等待）
 */
;(function () {
	'use strict'

	const logEl = document.getElementById('log')
	const logLines = []
	const MAX_LOG = 200

	/** 记录到界面日志（默认隐藏，`Ctrl+Shift+L` 可显示） */
	function log(message) {
		const line = `[${new Date().toLocaleTimeString()}] ${message}`
		logLines.push(line)
		if (logLines.length > MAX_LOG) logLines.shift()
		if (logEl) logEl.textContent = `${logLines.join('\n')}\n`
		console.log(line)
	}

	// ---------------------------------------------------------------
	// 右栏面板切换
	// ---------------------------------------------------------------

	// ---------------------------------------------------------------
	// 右栏（可折叠，默认收起）
	// ---------------------------------------------------------------
	//
	// ⚠️ 右栏原来**常驻 320px**，不管有没有内容都占着，于是：
	//   * 主内容区被压窄；
	//   * 一个"队列为空"的空面板长期占着三分之一的屏；
	//   * 三栏 + 边框 + 状态栏叠在一起，观感就是"IDE 面板"而不是播放器。
	//
	// 改成**默认收起**、按需展开：点图标按钮或 Ctrl+Q 都能开。
	// 收起时整列宽度归零（不是 `display:none`），所以过渡是平滑的，
	// 而且面板里的 DOM 仍然存在 —— 探针读队列/歌词不受影响。
	const app = document.querySelector('.app')
	const rightbarToggle = document.getElementById('rightbar-toggle')

	function isRightbarOpen() {
		return !app?.classList.contains('is-rightbar-collapsed')
	}

	function setRightbar(open) {
		if (!app) return
		app.classList.toggle('is-rightbar-collapsed', !open)
		rightbarToggle?.classList.toggle('is-active', open)
		rightbarToggle?.setAttribute('aria-expanded', String(open))
		window.bbState.set({ rightbarOpen: open })
	}

	rightbarToggle?.addEventListener('click', () =>
		setRightbar(!isRightbarOpen()),
	)

	/**
	 * 右栏面板（播放队列 / 歌词）的页签。
	 *
	 * ⚠️ 选择器必须限定在**右栏**，不能用 `.tab`。
	 *
	 * 音乐库的页签条（播放列表 / 收藏夹 / 合集 / 导入）也用了 `.tab` 类
	 * （视觉上确实是同一套页签）。用 `.tab` 绑事件的话，点「收藏夹」会顺带
	 * 调 `switchPanel(undefined)` —— 右栏两个面板**全部变成不激活**（一片空白），
	 * 而且还会擅自把收起状态的右栏展开。
	 *
	 * 是靠截图巡检发现的：03–11 那几张里右栏一直是展开的（本该收起），
	 * 而体检表显示点完音乐库页签后 `.content` 从 1186 变成了 866。
	 *
	 * 用 `[data-panel]` 而不是 `#rightbar .tab`：前者是**语义属性**，
	 * 右栏页签独有的标记，将来改类名也不会误伤。
	 */
	const rightbarTabs = document.querySelectorAll('[data-panel]')

	function switchPanel(panel) {
		if (!panel) return
		for (const tab of rightbarTabs) {
			tab.classList.toggle('is-active', tab.dataset.panel === panel)
		}
		for (const section of document.querySelectorAll('.panel')) {
			section.classList.toggle('is-active', section.dataset.panel === panel)
		}
		// 切面板的意图就是"我要看它"，所以顺手把栏展开 ——
		// 否则用户按 Ctrl+Q 会觉得"按了没反应"（栏是收起的，看不见变化）
		setRightbar(true)
		window.bbState.set({ rightPanel: panel })
	}

	for (const tab of rightbarTabs) {
		tab.addEventListener('click', () => switchPanel(tab.dataset.panel))
	}

	// ---------------------------------------------------------------
	// 左栏导航（目的地）+ 音乐库页签
	// ---------------------------------------------------------------
	//
	// ⚠️ 这里是阶段 2b 的**信息架构分层**。
	//
	// 原来是一层：左栏 7 个平铺入口（音乐库 / 搜索 / 导入歌单 / 最近播放 /
	// 收藏夹 / 合集 / 共享）。问题是"目的地"（音乐库、搜索）与"某个页面里的
	// 动作/子集"（导入歌单、收藏夹、合集）混在同一层，用户得先猜
	// 「导入歌单」和「合集」有什么区别。
	//
	// 现在两层：
	//   左栏 = 目的地（主页 / 音乐库 / 搜索 / 设置）
	//   音乐库页内 = 页签（播放列表 / 收藏夹 / 合集 / 导入）+ 页内动作（共享 / 刷新）
	//
	// 视图名与页签名的映射保持稳定：`view` 仍然是
	// `home | library | search | settings | share`，页签只决定 `#content` 里渲染什么。

	/** 目的地的页面大标题（由外壳渲染，不再让每个视图各写一份） */
	const VIEW_TITLES = {
		home: '主页',
		library: '音乐库',
		search: '搜索',
		settings: '设置',
		share: '共享歌单',
	}

	function setPageTitle(view) {
		const el = document.getElementById('page-title')
		if (el) el.textContent = VIEW_TITLES[view] ?? ''
	}

	/** 音乐库的页签 → 渲染函数 */
	const LIBRARY_TABS = {
		playlists: () => window.bbLibrary.init(),
		favorites: () => window.bbFavorites.show(),
		collection: () => window.bbLibrary.showCollectionTab(),
		import: () => window.bbImport.show(),
	}

	let currentLibraryTab = 'playlists'

	/** 当前目的地。关闭「正在播放」时要回到它 */
	let currentView = 'library'

	function setLibraryTab(tab, { focusNav = true } = {}) {
		if (!LIBRARY_TABS[tab]) return
		currentLibraryTab = tab
		for (const button of document.querySelectorAll('[data-lib-tab]')) {
			button.classList.toggle('is-active', button.dataset.libTab === tab)
		}
		window.bbState.set({ libraryTab: tab })
		if (focusNav) {
			setActiveNav('library')
			void LIBRARY_TABS[tab]()
		}
	}

	function setActiveNav(view) {
		currentView = view
		for (const item of document.querySelectorAll('.nav__item')) {
			item.classList.toggle('is-active', item.dataset.view === view)
		}
		setPageTitle(view)
		// 收藏夹的 UID 工具条只在「音乐库 › 收藏夹」页签显示
		const bar = document.getElementById('favorite-bar')
		if (bar)
			bar.hidden = !(view === 'library' && currentLibraryTab === 'favorites')
		// 音乐库的页签条只在音乐库目的地显示
		const tabs = document.getElementById('library-tabs')
		if (tabs) tabs.hidden = view !== 'library'
		// ⚠️ 设置子页的返回按钮只属于设置。不显式关掉的话，
		// 从「设置 › 某个分类」切到别的页面它会一直挂着 ——
		// 正在播放面板里就出现了**两个返回按钮**（外壳的 + 面板自己的）。
		const settingsBack = document.getElementById('settings-back')
		if (settingsBack && view !== 'settings') settingsBack.hidden = true
		showMainPane(view)
	}

	/**
	 * 中栏是**三个互斥的页面**：常规内容、共享面板、设置。
	 *
	 * ⚠️ 它们都是 `.main` 的 flex 子项。同时可见会把中栏挤成上下两半
	 * （历史上真出现过：共享视图与 `#content` 都显示，两个 flex 项各分一半）。
	 * 所以要**集中在一处**决定谁可见 —— 分散在各自的模块里迟早会漏掉一个，
	 * 而漏掉的表现是"某两个页面同时出现在屏幕上"，很难往这个方向想。
	 */
	function showMainPane(view) {
		const content = document.getElementById('content')
		const shareRoot = document.getElementById('view-share')
		const settingsRoot = document.getElementById('view-settings')
		const nowRoot = document.getElementById('view-nowplaying')
		const showShare = view === 'share'
		const showSettings = view === 'settings'
		const showNow = view === 'nowplaying'
		if (shareRoot) shareRoot.hidden = !showShare
		if (settingsRoot) settingsRoot.hidden = !showSettings
		if (nowRoot) nowRoot.hidden = !showNow
		if (content) content.hidden = showShare || showSettings || showNow
		// ⚠️ 正在播放面板**自带标题**（大封面 + 曲名），外壳的页面标题区
		// 在它上面就是重复的一行 —— 而且会把封面往下挤。
		const pageHead = document.querySelector('.page-head')
		if (pageHead) pageHead.hidden = showNow
		if (showSettings) window.bbSettings?.open?.()
		// 队列只有一份：它跟着"哪一个面板在前台"搬家（见 placeQueue）
		placeQueue(showNow)
	}

	/**
	 * 把**唯一那份**队列列表放到正确的位置（阶段 4b）。
	 *
	 * ⚠️ 队列在"右栏"和"正在播放面板"里都要出现，但**不能渲染两份**：
	 * 两棵树会让 `data-queue-index` 重复 —— 探针的计数翻倍、
	 * 拖拽与点击落到错误的那一棵上。
	 *
	 * 所以队列是一个 DOM 节点，在需要时被搬到对应的槽位里。
	 * 这个函数是它**唯一**的搬运点。
	 */
	function placeQueue(intoNowPlaying) {
		const list = document.getElementById('queue-list')
		if (!list) return
		const slot = document.getElementById(
			intoNowPlaying ? 'nowplaying-queue-slot' : 'queue-slot',
		)
		if (slot && list.parentElement !== slot) slot.appendChild(list)
	}

	/**
	 * @deprecated 兼容旧调用点（`bbUI.showContent` / `bbLibrary` 里在用）。
	 * 等价于 `showMainPane('share' | 'library')`。
	 */
	function toggleShareView(showShare) {
		showMainPane(showShare ? 'share' : 'library')
	}

	/** 打开一个目的地 */
	function openView(view) {
		setActiveNav(view)
		if (view === 'home') {
			void window.bbHistory.show()
		} else if (view === 'library') {
			// 回到音乐库时留在上次的页签（用户的心智是"我刚才在收藏夹"）
			void LIBRARY_TABS[currentLibraryTab]()
		} else if (view === 'search') {
			const input = document.getElementById('search-input')
			if (input) {
				input.focus()
				input.select()
			}
			window.bbLibrary.renderWelcomeOrLast?.()
		} else if (view === 'settings') {
			// 设置是一级页面（阶段 3）。可见性由 `showMainPane` 统一决定；
			// 这里只需要**回到分类列表** —— 用户从别的页面点「设置」进来时，
			// 期待看到设置首页，而不是上次进去的那个子页。
			window.bbSettings?.showCategories?.()
		} else if (view === 'share') {
			// 页内动作：共享面板由音乐库的按钮打开，不是左栏目的地
			// ⚠️ `show()` 只读本地状态（`share.status()` 不发网络请求），
			// 所以打开视图不会因为后端不可达而卡住或抛错
			void window.bbShare?.show?.()
		}
	}

	for (const item of document.querySelectorAll('.nav__item')) {
		item.addEventListener('click', () => openView(item.dataset.view))
	}

	for (const button of document.querySelectorAll('[data-lib-tab]')) {
		button.addEventListener('click', () => setLibraryTab(button.dataset.libTab))
	}

	/**
	 * 打开 / 关闭「正在播放」面板（阶段 4b）。
	 *
	 * 入口是**播放条的封面与标题区** —— 与移动端"点迷你播放条展开"
	 * 是同一个手势心智。返回按钮在面板左上角。
	 *
	 * ⚠️ 要记住**进入前的目的地**。第一版直接用 `currentView` 返回，
	 * 但 `setActiveNav('nowplaying')` 已经把它改成 `nowplaying` 了，
	 * 于是"返回"又回到正在播放 —— 面板关不掉，队列也搬不回右栏。
	 */
	let viewBeforeNowPlaying = 'library'

	function setNowPlaying(open) {
		if (open) {
			if (currentView !== 'nowplaying') viewBeforeNowPlaying = currentView
			setActiveNav('nowplaying')
			window.bbPlayer?.refreshNowPlayingView?.()
		} else {
			openView(viewBeforeNowPlaying)
		}
	}

	/**
	 * 播放条的封面 / 标题区可点，展开「正在播放」（阶段 4b）。
	 *
	 * ⚠️ 用 `querySelector('[data-testid=…]')` 而不是 `getElementById`：
	 * 封面只有 `data-testid="playbar-cover"`、**没有 id**
	 * （第一版按 id 找，拿到 null，于是"点封面没反应"）。
	 */
	const nowPlayingEntryPoints = [
		document.querySelector('[data-testid="playbar-cover"]'),
		document.getElementById('now-title'),
		document.getElementById('now-artist'),
	]
	for (const node of nowPlayingEntryPoints) {
		if (!node) continue
		node.classList.add('is-clickable')
		node.addEventListener('click', () => setNowPlaying(true))
	}
	document
		.getElementById('nowplaying-close')
		?.addEventListener('click', () => setNowPlaying(false))

	// 页内动作：共享歌单面板
	document.getElementById('library-share')?.addEventListener('click', () => {
		void window.bbShare?.show?.()
		// ⚠️ 共享不是左栏目的地，但页面标题仍然要跟着变 ——
		// 否则从「音乐库」点进共享面板，大标题还写着"音乐库"。
		setActiveNav('share')
		document.querySelector('.page-head')?.classList.add('is-sub-page')
	})

	// 页内动作：刷新左栏歌单
	document.getElementById('library-refresh')?.addEventListener('click', () => {
		void window.bbLibrary.refreshPlaylists()
	})

	// ---------------------------------------------------------------
	// 快捷键（plan §3.4）
	// ---------------------------------------------------------------

	const player = window.bbPlayer
	const keys = window.bbKeys

	// —— 播放 ——
	keys.register('space', { description: '播放/暂停' }, () => {
		void player.toggle()
	})
	keys.register('arrowleft', { description: '快退 5 秒' }, () =>
		player.seekBy(-5),
	)
	keys.register('arrowright', { description: '快进 5 秒' }, () =>
		player.seekBy(5),
	)
	// 队列重排（与拖拽共用同一套底层 API，行为完全一致）。
	// 键盘路径既服务"不想用鼠标拖"的用户，也是自动化断言的入口 ——
	// 原生拖放在无头环境里很难稳定模拟。
	keys.register('alt+arrowup', { description: '队列：当前曲目上移' }, () => {
		const result = player.nudgeCurrent(-1)
		if (result.ok && result.moved) setStatus('已上移一位', 'ok')
	})
	keys.register('alt+arrowdown', { description: '队列：当前曲目下移' }, () => {
		const result = player.nudgeCurrent(1)
		if (result.ok && result.moved) setStatus('已下移一位', 'ok')
	})
	keys.register('shift+arrowleft', { description: '上一首' }, () => {
		void player.playPrev()
	})
	keys.register('shift+arrowright', { description: '下一首' }, () => {
		void player.playNext(false)
	})
	keys.register('ctrl+arrowleft', { description: '音量 −5%' }, () => {
		const volume = document.getElementById('volume')
		if (!volume) return
		volume.value = String(Math.max(0, Number(volume.value) - 5))
		volume.dispatchEvent(new Event('input'))
	})
	keys.register('ctrl+arrowright', { description: '音量 +5%' }, () => {
		const volume = document.getElementById('volume')
		if (!volume) return
		volume.value = String(Math.min(100, Number(volume.value) + 5))
		volume.dispatchEvent(new Event('input'))
	})
	keys.register('ctrl+m', { description: '静音切换' }, () => {
		const audio = player.getAudio()
		audio.muted = !audio.muted
	})

	// —— 模式 ——
	keys.register('ctrl+r', { description: '切换播放模式' }, () => {
		player.cycleMode()
	})

	// —— 视图 ——
	keys.register('ctrl+1', { description: '切到音乐库' }, () => {
		document.querySelector('[data-view="library"]')?.click()
	})
	keys.register('ctrl+2', { description: '切到搜索' }, () => {
		document.querySelector('[data-view="search"]')?.click()
	})
	keys.register('ctrl+3', { description: '切到收藏夹' }, () => {
		document.querySelector('[data-view="favorites"]')?.click()
	})
	keys.register('ctrl+4', { description: '切到合集' }, () => {
		document.querySelector('[data-view="collection"]')?.click()
	})
	// 登录：Ctrl+Shift+A（`Ctrl+L` 在很多系统上是地址栏语义，避开）
	keys.register('ctrl+shift+a', { description: '打开登录面板' }, () => {
		window.bbAuth?.open('qr')
	})
	// 设置：Ctrl+, （与多数桌面应用一致）
	keys.register(
		'ctrl+,',
		{ description: '打开设置', allowInInput: true },
		() => {
			window.bbSettings?.open()
		},
	)
	keys.register('ctrl+q', { description: '队列/歌词面板切换' }, () => {
		const current = window.bbState.get().rightPanel
		switchPanel(current === 'queue' ? 'lyrics' : 'queue')
	})

	// —— 功能 ——
	// `allowInInput`：焦点在搜索框时也要能聚焦（否则 Ctrl+F 在输入框里失效）
	keys.register(
		'ctrl+f',
		{ description: '聚焦搜索', allowInInput: true },
		() => {
			const input = document.getElementById('search-input')
			if (!input) return
			input.focus()
			input.select()
		},
	)
	keys.register('escape', { description: '清空搜索', scope: 'input' }, () => {
		const input = document.getElementById('search-input')
		if (input) {
			input.value = ''
			input.blur()
		}
	})
	keys.register('enter', { description: '播放列表首项' }, () => {
		const tracks = window.bbState.get().tracks
		if (tracks.length === 0) return
		player.setQueue(tracks, 0)
		player.playAt(0)
		void player.play()
	})

	// 独立歌词窗口：Ctrl+Alt+L（Ctrl+Shift+L 已用于日志开关）
	keys.register('ctrl+alt+l', { description: '切换独立歌词窗口' }, () => {
		void toggleLyricsWindow()
	})

	// —— 调试 ——
	keys.register('ctrl+shift+l', { description: '显示/隐藏日志' }, () => {
		if (logEl) logEl.hidden = !logEl.hidden
	})

	keys.install()

	/*
	 * 顶部播放菜单 → 复用同一批快捷键处理器（阶段 6）。
	 *
	 * ⚠️ 这里**不重新实现**播放/上一首/下一首 —— 主进程发来的就是一个
	 * 组合键字符串，交给 `keys.trigger` 转给**已经注册过的那个处理器**。
	 * 于是菜单与快捷键永远同源；否则同一功能两条代码路径，迟早不一致
	 * （这个仓库在别处吃过这个亏）。
	 */
	window.bbplayer?.onMenuAction?.((combo) => {
		if (!keys.trigger(combo)) {
			console.warn(`[menu] 没有注册过快捷键 ${combo}`)
		}
	})

	// ---------------------------------------------------------------
	// 歌词面板
	// ---------------------------------------------------------------

	let lyricsPanel = null
	let lyricsRequestSeq = 0

	function initLyricsPanel() {
		const container = document.getElementById('lyrics-panel')
		if (!container || typeof window.createLyricsPanel !== 'function') {
			log('歌词面板模块不可用，跳过初始化')
			return null
		}
		lyricsPanel = window.createLyricsPanel(container)
		return lyricsPanel
	}

	function setLyricsStatus(text) {
		const el = document.getElementById('lyrics-status')
		if (el) el.textContent = text
	}

	/**
	 * 独立歌词窗口（Phase 4.1）：当前歌词行。
	 *
	 * 声明放在 `loadLyricsFor` **之前** —— 那里会给它赋值。虽然 `let` 的
	 * 暂时性死区只在执行到赋值时才有影响（`loadLyricsFor` 是初始化之后才被
	 * 调用，放后面也不会报错），但「先赋值后声明」读起来像 bug。
	 */
	let lyricsWindowLines = []

	/** 当前曲目变化时自动匹配歌词 */
	async function loadLyricsFor(track, options = {}) {
		if (!lyricsPanel || !track) return

		// 「设置 › 歌词 › 自动匹配」关掉后不再自动请求。
		// 手动入口（歌词面板的「重新匹配」）走的是同一个函数，所以用一个参数
		// 区分"自动触发"与"用户主动要求"—— 否则关掉之后连手动都点不动。
		if (!options?.manual) {
			const settings = await desktopFeatures?.readSettings?.().catch(() => null)
			if (settings && settings.lyricsAutoMatch === false) {
				setLyricsStatus('已关闭自动匹配歌词')
				lyricsPanel.setLyrics([])
				lyricsWindowLines = []
				pushLyricsWindowState()
				return
			}
		}

		// 并发的加载用序号作废，避免慢请求覆盖新曲目的歌词
		const seq = ++lyricsRequestSeq
		setLyricsStatus('正在匹配歌词…')
		lyricsPanel.setLyrics([])
		// 独立歌词窗口也用同一份数据，换曲时先清空（避免显示上一首的歌词）
		lyricsWindowLines = []
		pushLyricsWindowState()

		try {
			const result = await window.bbplayer.autoMatchLyrics({
				title: track.title,
				artist: track.artist ?? null,
				duration: track.duration ?? null,
			})
			if (seq !== lyricsRequestSeq) return

			if (!result.ok) {
				setLyricsStatus(`歌词匹配失败：${result.error}`)
				return
			}
			if (!result.data.matched) {
				setLyricsStatus(
					`未找到匹配歌词（最佳分 ${Number(result.data.bestScore ?? 0).toFixed(2)}，候选 ${result.data.candidateCount}）`,
				)
				return
			}

			// 解析在主进程完成（渲染进程没有模块系统），这里只负责渲染
			lyricsPanel.setLyrics(result.data.lines ?? [])
			// 独立歌词窗口用同一份行数据（主进程只转发，不重复匹配）
			lyricsWindowLines = result.data.lines ?? []
			pushLyricsWindowState()
			setLyricsStatus(
				`${result.data.candidate.title} — ${result.data.candidate.artist}（匹配度 ${Number(result.data.score).toFixed(2)}，${result.data.lineCount} 行）`,
			)
			log(`歌词已加载：${result.data.lineCount} 行`)
		} catch (error) {
			if (seq !== lyricsRequestSeq) return
			setLyricsStatus(`歌词匹配异常：${error.message}`)
		}
	}

	/** 独立歌词窗口的开关（右栏工具栏按钮 + Ctrl+Alt+L） */
	async function toggleLyricsWindow() {
		try {
			const result = await window.bbplayer?.lyricsWindow?.toggle?.()
			if (result?.ok) {
				log(`独立歌词窗口：${result.data.open ? '已打开' : '已关闭'}`)
			} else if (result?.error) {
				log(`独立歌词窗口切换失败：${result.error}`)
			}
		} catch (error) {
			log(`独立歌词窗口切换异常：${error.message}`)
		}
	}

	const popoutButton = document.getElementById('lyrics-popout')
	if (popoutButton) {
		popoutButton.addEventListener('click', () => void toggleLyricsWindow())
	}

	const reloadButton = document.getElementById('lyrics-reload')
	if (reloadButton) {
		reloadButton.addEventListener('click', () => {
			void loadLyricsFor(player.getCurrent())
		})
	}

	// 播放位置驱动高亮（时间更新频繁，直接挂 timeupdate）
	player.getAudio().addEventListener('timeupdate', () => {
		// 独立歌词窗口：**不管右栏面板是否在歌词页**都要推 ——
		// 歌词窗口本来就是「把歌词挪到别处看」，右栏可能正显示队列。
		// 这也是「右栏歌词不渲染」那个已知问题的一个绕过路径。
		const audio = player.getAudio()
		void window.bbplayer?.lyricsWindow?.pushPosition?.(audio.currentTime)
		if (Number.isFinite(audio.duration) && audio.duration > 0) {
			void window.bbplayer?.lyricsWindow?.pushProgress?.(
				audio.currentTime / audio.duration,
			)
		}

		if (!lyricsPanel) return
		if (window.bbState.get().rightPanel !== 'lyrics') return
		lyricsPanel.setPosition(audio.currentTime)
	})

	// ---------------------------------------------------------------
	// 独立歌词窗口（Phase 4.1）
	// ---------------------------------------------------------------

	/**
	 * 把当前歌词/曲目/位置整理成歌词窗口需要的形状推过去。
	 *
	 * 主进程只做转发、不理解内容，所以整理在这里做。窗口没开时 IPC 会静默
	 * 返回（主进程侧 `sendToLyricsWindow` 会跳过），所以**不需要**在这里
	 * 判断开关状态 —— 少一个会与主进程漂移的状态。
	 */
	function pushLyricsWindowState() {
		const bridge = window.bbplayer?.lyricsWindow
		if (!bridge) return
		void bridge.pushLyrics?.(lyricsWindowLines)
		const current = player.getCurrent()
		void bridge.pushTrack?.({
			title: current?.title ?? null,
			artist: current?.artist ?? current?.artist_name ?? null,
		})
		const audio = player.getAudio()
		if (Number.isFinite(audio.duration) && audio.duration > 0) {
			void bridge.pushProgress?.(audio.currentTime / audio.duration)
		}
		void bridge.pushPosition?.(audio.currentTime)
	}

	window.bbplayer?.lyricsWindow?.onOpened?.(() => {
		log('独立歌词窗口已打开，推送当前状态')
		pushLyricsWindowState()
	})
	window.bbplayer?.lyricsWindow?.onClosed?.(() => log('独立歌词窗口已关闭'))
	// 歌词窗口就绪后主动要一次状态（否则要等下一次 timeupdate 才有内容）
	window.bbplayer?.lyricsWindow?.onRequestState?.(() => pushLyricsWindowState())

	// ---------------------------------------------------------------
	// 播放器事件 → 界面同步
	// ---------------------------------------------------------------

	player.on((event) => {
		if (event.type === 'track-changed') {
			log(`开始播放：${event.track.title}`)
			for (const row of document.querySelectorAll('.track-table tbody tr')) {
				row.classList.toggle(
					'is-playing',
					row.dataset.bvid === event.track.bvid,
				)
			}
			// 播放历史：结束上一会话（切歌视为「没听完」）、开始新会话
			void closePlaySession(false).then(() => openPlaySession(event.track))
			void loadLyricsFor(event.track)
		} else if (event.type === 'mode-changed') {
			log(`播放模式：${event.mode}`)
		}
	})

	// ---------------------------------------------------------------
	// MediaSession（Phase 4）：系统媒体键 / 任务栏缩略图 / 系统面板
	// ---------------------------------------------------------------

	/**
	 * 系统媒体集成。
	 *
	 * 任务栏缩略图按钮与硬件媒体键兜底由**主进程**触发，通过
	 * `media:action` 事件回到这里 —— 主进程不知道队列状态，只能转发动作名。
	 */
	const MEDIA_ACTIONS = {
		toggle: () => void player.toggle(),
		next: () => void player.playNext(false),
		prev: () => void player.playPrev(),
		stop: () => {
			player.pause()
			player.seekTo(0)
		},
		seekbackward: () => player.seekBy(-10),
		seekforward: () => player.seekBy(10),
	}

	let mediaSession = null

	function initMediaSession() {
		if (typeof window.createMediaSessionBridge !== 'function') {
			log('MediaSession 模块不可用，跳过初始化')
			return null
		}
		mediaSession = window.createMediaSessionBridge({
			player,
			log: (message) => log(`[media] ${message}`),
		})

		if (mediaSession.supported) {
			log('已接入系统 MediaSession（媒体键 / 系统媒体面板）')
		} else {
			log('当前环境不支持 navigator.mediaSession')
		}

		// 任务栏缩略图按钮的播放状态跟随播放器
		player.getAudio().addEventListener('play', () => {
			void window.bbplayer?.setThumbnailPlaying?.(true)
		})
		player.getAudio().addEventListener('pause', () => {
			void window.bbplayer?.setThumbnailPlaying?.(false)
		})

		// 主进程转发的动作（任务栏按钮 / 硬件媒体键兜底）
		window.bbplayer?.onMediaAction?.((action) => {
			const handler = MEDIA_ACTIONS[action]
			if (!handler) {
				log(`收到未知媒体动作：${action}`)
				return
			}
			log(`媒体动作：${action}`)
			handler()
		})

		return mediaSession
	}

	// ---------------------------------------------------------------
	// 桌面专属功能（Phase 4 收尾）：主题 / 定时关闭 / 响度均衡
	// ---------------------------------------------------------------

	let sleepTimer = null
	let loudness = null
	let desktopFeatures = null

	/** 读设置（面板与初始化都要用，收在一处便于统一错误处理） */
	async function readSettings() {
		const result = await window.bbplayer.settings.get()
		if (result?.ok !== true) {
			throw new Error(result?.error ?? '读取设置失败')
		}
		return result.data
	}

	/** 写设置；返回写入后的完整设置 */
	async function writeSettings(patch) {
		const result = await window.bbplayer.settings.update(patch)
		if (result?.ok !== true) {
			throw new Error(result?.error ?? '写入设置失败')
		}
		return result.data
	}

	async function initDesktopFeatures() {
		const factory = window.bbDesktopFeatures
		if (!factory) {
			log('桌面特性模块不可用，跳过主题/定时/响度')
			return
		}

		let stored
		try {
			stored = await readSettings()
		} catch (error) {
			log(`读取设置失败，使用默认值：${error.message}`)
			stored = {
				settings: {},
				sleepPresets: [15, 30, 45, 60],
				sleepFadeMs: 5000,
			}
		}
		const settings = stored.settings ?? {}

		// 主题：**先应用**，避免界面先闪一下深色再变浅
		factory.applyTheme(settings.theme)

		sleepTimer = factory.createSleepTimer({
			player,
			fadeMs: stored.sleepFadeMs ?? 5000,
			onFire: async () => {
				// 到点后清掉持久化的结束时间，否则重启后又会被恢复成「已过期」
				try {
					await writeSettings({ sleepEndsAt: null })
				} catch (error) {
					log(`清除定时关闭状态失败：${error.message}`)
				}
			},
			log: (message) => log(`[sleep] ${message}`),
		})
		// 重启后恢复未到期的定时
		if (settings.sleepEndsAt) {
			const restored = sleepTimer.restore(settings.sleepEndsAt)
			if (restored) log('已恢复上次未到期的定时关闭')
		}

		loudness = factory.createLoudnessNormalizer(player.getAudio(), {
			targetDb: settings.loudnessTargetDb ?? -14,
			maxGainDb: settings.loudnessMaxGainDb ?? 12,
			log: (message) => log(`[loudness] ${message}`),
		})
		// 只在用户上次确实开着、且播放器已就绪时才自动启用
		if (settings.loudnessNormalization) {
			await loudness.enable()
		}

		desktopFeatures = { applyTheme: factory.applyTheme, sleepTimer, loudness }

		window.bbSettings?.init({
			...desktopFeatures,
			// 面板通过这两个回调读写设置，不直接碰 IPC
			readSettings: async () => (await readSettings()).settings,
			writeSettings,
			sleepPresets: stored.sleepPresets,
		})
		window.bbSettings?.startDownloadPolling()

		log(
			`桌面特性就绪：主题=${settings.theme ?? 'dark'}，` +
				`响度均衡=${loudness.isEnabled() ? '开' : '关'}，` +
				`定时关闭=${sleepTimer.describe().active ? '已设置' : '未设置'}`,
		)
	}

	// ---------------------------------------------------------------
	// 播放历史（Phase 3.5）
	// ---------------------------------------------------------------

	/**
	 * 当前播放会话。
	 *
	 * 一次会话一行记录（`date` = 见 db.cjs 的说明）。这里只维护「当前会话」，
	 * 不做队列管理 —— 会话的生命周期完全由播放器事件驱动：
	 *   * `track-changed` -> 结束上一会话（若有）、开始新会话
	 *   * 每 10 秒 -> 上报累计已播秒数
	 *   * `ended` -> 标记 completed
	 */
	let playSession = { historyId: null, trackId: null, startedAt: 0 }
	/** 上次上报时间，用于节流（每 10 秒一次，不是每次 timeupdate） */
	let lastSessionReport = 0
	const SESSION_REPORT_INTERVAL_MS = 10_000

	/** 收尾当前会话：上报最终时长，可选标记为「已播完」 */
	async function closePlaySession(completed) {
		if (!playSession.historyId) return
		const audio = player.getAudio()
		const played = Number.isFinite(audio.currentTime) ? audio.currentTime : 0
		try {
			await window.bbplayer?.history?.updateSession?.({
				historyId: playSession.historyId,
				durationPlayed: played,
				completed: Boolean(completed),
			})
		} catch (error) {
			log(`播放历史收尾失败：${error.message}`)
		}
		playSession = { historyId: null, trackId: null, startedAt: 0 }
	}

	/** 开始新会话。**只对已落库的曲目记录** —— `play_history.track_id` 是外键 */
	async function openPlaySession(track) {
		if (!track?.bvid) return
		try {
			// 搜索结果的曲目还没落库（没有 tracks 行），此时 findTrackByBvid 返回 null。
			// 这是**预期**的：历史只记录库里的曲目，否则外键会拒绝插入。
			const found = await window.bbplayer?.findTrackByBvid?.(track.bvid)
			const trackId = found?.data ?? null
			if (!trackId) {
				log(`曲目未落库，跳过播放历史：${track.bvid}`)
				return
			}
			const started = await window.bbplayer?.history?.startSession?.(trackId)
			if (started?.ok) {
				playSession = {
					historyId: started.data.historyId,
					trackId,
					startedAt: Date.now(),
				}
				lastSessionReport = Date.now()
			}
		} catch (error) {
			log(`播放历史记录失败：${error.message}`)
		}
	}

	// 每 10 秒上报一次累计时长（timeupdate 约 4Hz，不能每次都写库）
	player.getAudio().addEventListener('timeupdate', () => {
		if (!playSession.historyId) return
		const now = Date.now()
		if (now - lastSessionReport < SESSION_REPORT_INTERVAL_MS) return
		lastSessionReport = now
		void window.bbplayer?.history?.updateSession?.({
			historyId: playSession.historyId,
			durationPlayed: player.getAudio().currentTime,
			completed: false,
		})
	})

	// 播完标记（`ended` 只在自然播完时触发，切歌不会）
	player.getAudio().addEventListener('ended', () => {
		void closePlaySession(true)
	})

	// ---------------------------------------------------------------
	// 自动化接口
	// ---------------------------------------------------------------

	window.bbUI = {
		switchPanel,
		setActiveNav,
		/** 右栏开关（阶段 2：默认收起，按需展开） */
		setRightbar,
		isRightbarOpen,
		/** 从共享视图切回 #content 里的其它视图（library.js 直接渲染时要用） */
		showContent: () => toggleShareView(false),
		keys: () => keys.list(),
		keyHistory: () => keys.history(),
		/** 歌词面板（供自动化断言）；未初始化时为 null */
		lyricsPanel: () => lyricsPanel,
		/** 手动触发当前曲目的歌词匹配 */
		// 手动匹配：显式绕过「自动匹配歌词」开关（用户都点按钮了，就是想要）
		reloadLyrics: () => loadLyricsFor(player.getCurrent(), { manual: true }),
		/** 认证面板（Phase 3） */
		auth: () => window.bbAuth,
		/** 收藏夹视图（Phase 3） */
		favorites: () => window.bbFavorites,
		/** 系统媒体集成（Phase 4）；未初始化时为 null */
		mediaSession: () => mediaSession,
		/** 桌面特性（主题 / 定时关闭 / 响度均衡）；未初始化时为 null */
		desktop: () => desktopFeatures,
		/** 设置面板（Phase 4 收尾） */
		settingsPanel: () => window.bbSettings,
		/** 当前播放会话（供自动化断言播放历史） */
		playSession: () => ({ ...playSession }),
		/** 手动收尾当前会话（供自动化，避免等 10 秒节流） */
		flushPlaySession: (completed) => closePlaySession(Boolean(completed)),
		/** 直接派发一个媒体动作（供自动化，避免真的依赖系统媒体键） */
		dispatchMediaAction(action) {
			const handler = MEDIA_ACTIONS[action]
			if (!handler) return false
			handler()
			return true
		},
		/** 可用的媒体动作名 */
		mediaActions: () => Object.keys(MEDIA_ACTIONS),
		/** 模拟按键（供脚本驱动，避免依赖真实键盘事件） */
		press(combo) {
			const parts = combo.split('+')
			let key = parts[parts.length - 1]
			if (key === 'space') key = ' '
			else if (key === 'escape') key = 'Escape'
			else if (key === 'enter') key = 'Enter'
			else if (key === 'arrowleft') key = 'ArrowLeft'
			else if (key === 'arrowright') key = 'ArrowRight'

			const event = new KeyboardEvent('keydown', {
				ctrlKey: parts.includes('ctrl'),
				shiftKey: parts.includes('shift'),
				altKey: parts.includes('alt'),
				bubbles: true,
				cancelable: true,
				key,
			})
			document.body.dispatchEvent(event)
			return true
		},
		log: () => logLines.slice(),
	}

	// ---------------------------------------------------------------
	// 启动
	// ---------------------------------------------------------------

	async function boot() {
		log('渲染进程就绪')

		initLyricsPanel()
		initMediaSession()
		await initDesktopFeatures()

		// 登录徽标由 auth.js 自己初始化（走正式的 loginStatus IPC，
		// 不再依赖只有探针模式才有的 bbProbe）；这里只把数据目录记进日志。
		try {
			const info = await window.bbProbe?.ports?.()
			if (info?.ok) log(`数据目录：${info.dataDir}`)
		} catch {
			// 诊断信息拿不到不影响主流程
		}

		await window.bbLibrary.init()

		// ⚠️ 首次进入也要走一遍 `setActiveNav`。
		//
		// 页签条在 HTML 里是 `hidden` 的（默认不显示），由 `setActiveNav` 按
		// 当前目的地决定显隐。启动时如果不调，界面停在"音乐库"但**页签条不出现**
		// —— 代码看着对，界面缺少一整条导航。由探针的「音乐库有 4 个页签」抓到。
		setActiveNav('library')

		// 右栏默认收起：初次进入时界面只有「导航 + 内容 + 播放条」三块，
		// 队列/歌词按需展开。这里显式设一次，而不是靠 HTML 上的初始类 ——
		// 状态只有一处真相（`is-rightbar-collapsed`）。
		setRightbar(false)

		// 主题变量要在宣布「就绪」之前落地。
		// 否则探针（和用户）可能在 `<style id="bb-theme-vars">` 还空着的时候
		// 就去看界面 —— 「启动时已应用主题」会变成看运气。
		try {
			await window.bbTheme?.ready
		} catch {
			// 主题拿不到不该让应用起不来：style.css 里有暗色兜底
		}

		window.__bbReady = true
		log('初始化完成')
	}

	void boot()
})()
