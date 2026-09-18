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

	function switchPanel(panel) {
		for (const tab of document.querySelectorAll('.tab')) {
			tab.classList.toggle('is-active', tab.dataset.panel === panel)
		}
		for (const section of document.querySelectorAll('.panel')) {
			section.classList.toggle('is-active', section.dataset.panel === panel)
		}
		window.bbState.set({ rightPanel: panel })
	}

	for (const tab of document.querySelectorAll('.tab')) {
		tab.addEventListener('click', () => switchPanel(tab.dataset.panel))
	}

	// ---------------------------------------------------------------
	// 左栏导航
	// ---------------------------------------------------------------

	function setActiveNav(view) {
		for (const item of document.querySelectorAll('.nav__item')) {
			item.classList.toggle('is-active', item.dataset.view === view)
		}
		// 收藏夹工具条只在收藏夹视图显示
		const bar = document.getElementById('favorite-bar')
		if (bar) bar.hidden = view !== 'favorites'
		// 共享视图的根节点常驻在 index.html 里（探针要能直接 `#view-share` 找到它），
		// 所以这里手动与 #content 互斥：否则两个 flex 子项会把中栏挤成上下两半
		toggleShareView(view === 'share')
	}

	/**
	 * 在「共享视图」与「#content 里的其它视图」之间切换（两者互斥）。
	 *
	 * `#content` 是 library / 搜索 / 导入 / 历史 / 收藏夹 / 合集共用的容器，
	 * 它们渲染时都会清空它 —— 而共享视图是**常驻**的兄弟节点，不会被清掉。
	 * 所以从任何路径切回 #content 时都要显式把共享视图藏起来
	 * （`bbLibrary.renderTrackTable` 这类不经过导航的渲染也要走 `showContent`）。
	 */
	function toggleShareView(showShare) {
		const shareRoot = document.getElementById('view-share')
		const content = document.getElementById('content')
		if (shareRoot) shareRoot.hidden = !showShare
		if (content) content.hidden = showShare
	}

	for (const item of document.querySelectorAll('.nav__item')) {
		item.addEventListener('click', () => {
			const view = item.dataset.view
			setActiveNav(view)
			if (view === 'library') {
				void window.bbLibrary.init()
			} else if (view === 'search') {
				const input = document.getElementById('search-input')
				if (input) {
					input.focus()
					input.select()
				}
			} else if (view === 'import') {
				void window.bbImport.show()
			} else if (view === 'history') {
				void window.bbHistory.show()
			} else if (view === 'favorites') {
				void window.bbFavorites.show()
			} else if (view === 'collection') {
				window.bbLibrary.renderTrackTable([], { title: '合集' })
			} else if (view === 'share') {
				// ⚠️ `show()` 只读本地状态（`share.status()` 不发网络请求），
				// 所以打开视图不会因为后端不可达而卡住或抛错
				void window.bbShare?.show?.()
			}
		})
	}

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
	async function loadLyricsFor(track) {
		if (!lyricsPanel || !track) return
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
		/** 从共享视图切回 #content 里的其它视图（library.js 直接渲染时要用） */
		showContent: () => toggleShareView(false),
		keys: () => keys.list(),
		keyHistory: () => keys.history(),
		/** 歌词面板（供自动化断言）；未初始化时为 null */
		lyricsPanel: () => lyricsPanel,
		/** 手动触发当前曲目的歌词匹配 */
		reloadLyrics: () => loadLyricsFor(player.getCurrent()),
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
