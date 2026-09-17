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
			} else if (view === 'collection') {
				window.bbLibrary.renderTrackTable([], { title: '合集' })
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
	keys.register('ctrl+3', { description: '切到合集' }, () => {
		document.querySelector('[data-view="collection"]')?.click()
	})
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

	/** 当前曲目变化时自动匹配歌词 */
	async function loadLyricsFor(track) {
		if (!lyricsPanel || !track) return
		// 并发的加载用序号作废，避免慢请求覆盖新曲目的歌词
		const seq = ++lyricsRequestSeq
		setLyricsStatus('正在匹配歌词…')
		lyricsPanel.setLyrics([])

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
			setLyricsStatus(
				`${result.data.candidate.title} — ${result.data.candidate.artist}（匹配度 ${Number(result.data.score).toFixed(2)}，${result.data.lineCount} 行）`,
			)
			log(`歌词已加载：${result.data.lineCount} 行`)
		} catch (error) {
			if (seq !== lyricsRequestSeq) return
			setLyricsStatus(`歌词匹配异常：${error.message}`)
		}
	}

	const reloadButton = document.getElementById('lyrics-reload')
	if (reloadButton) {
		reloadButton.addEventListener('click', () => {
			void loadLyricsFor(player.getCurrent())
		})
	}

	// 播放位置驱动高亮（时间更新频繁，直接挂 timeupdate）
	player.getAudio().addEventListener('timeupdate', () => {
		if (!lyricsPanel) return
		if (window.bbState.get().rightPanel !== 'lyrics') return
		lyricsPanel.setPosition(player.getAudio().currentTime)
	})

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
			void loadLyricsFor(event.track)
		} else if (event.type === 'mode-changed') {
			log(`播放模式：${event.mode}`)
		}
	})

	// ---------------------------------------------------------------
	// 自动化接口
	// ---------------------------------------------------------------

	window.bbUI = {
		switchPanel,
		setActiveNav,
		keys: () => keys.list(),
		keyHistory: () => keys.history(),
		/** 歌词面板（供自动化断言）；未初始化时为 null */
		lyricsPanel: () => lyricsPanel,
		/** 手动触发当前曲目的歌词匹配 */
		reloadLyrics: () => loadLyricsFor(player.getCurrent()),
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

		try {
			const info = await window.bbProbe?.ports?.()
			if (info?.ok) {
				log(`数据目录：${info.dataDir}`)
				const badge = document.getElementById('account-badge')
				if (badge) {
					badge.textContent = info.hasCookie ? '已登录' : '未登录'
					badge.classList.toggle('is-online', Boolean(info.hasCookie))
				}
			}
		} catch {
			// 诊断信息拿不到不影响主流程
		}

		await window.bbLibrary.init()

		window.__bbReady = true
		log('初始化完成')
	}

	void boot()
})()
