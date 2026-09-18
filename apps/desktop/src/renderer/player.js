/**
 * 播放器：`<audio>` + 队列 + 模式（顺序 / 单曲 / 随机）。
 *
 * 音频源始终是 `bbplayer-audio://track/<bvid>`（主进程代理，注入 Referer、
 * 透传 Range），而不是直连 CDN —— 原因见 docs/DESKTOP_PLAN.md §2.3。
 *
 * 同时暴露 `window.bbTest`，供自动化验证脚本做「点击级」断言
 * （见 scripts/verify-desktop.mjs 与 apps/desktop/src/probe-driver.cjs）。
 */
;(function () {
	'use strict'

	/**
	 * 生成一个 Material Symbols 图标节点的 HTML。
	 *
	 * 图标名是字体的**合字**（ligature），所以写的是 `play_arrow` 这样的名字，
	 * 字体把它渲染成图形 —— HTML 里读起来是语义，不是乱码。
	 * 字体来自 `scripts/build-icon-font.mjs`（子集，9.3 KB，随源码提交）。
	 */
	function icon(name, extraClass = '') {
		return `<span class="icon ${extraClass}">${name}</span>`
	}

	const PLAY_MODES = ['order', 'repeat-one', 'shuffle']
	/**
	 * 播放模式的图标与无障碍名。
	 *
	 * 第一版这里是一个**文字按钮**（顺序 / 单曲 / 随机），在一排图标按钮里
	 * 显得格格不入 —— 移动端用的是图标。	itle / ria-label 保留文字，
	 * 所以鼠标悬停与读屏仍然能知道当前是什么模式。
	 */
	const MODE_ICON = {
		order: 'repeat',
		'repeat-one': 'repeat_one',
		shuffle: 'shuffle',
	}
	const MODE_LABEL = {
		order: '顺序播放',
		'repeat-one': '单曲循环',
		shuffle: '随机播放',
	}

	const els = {
		audio: document.getElementById('audio'),
		play: document.getElementById('play'),
		prev: document.getElementById('prev'),
		next: document.getElementById('next'),
		progress: document.getElementById('progress'),
		volume: document.getElementById('volume'),
		mode: document.getElementById('mode'),
		timeCurrent: document.getElementById('time-current'),
		timeTotal: document.getElementById('time-total'),
		title: document.getElementById('now-title'),
		artist: document.getElementById('now-artist'),
		queueList: document.getElementById('queue-list'),
		queueEmpty: document.getElementById('queue-empty'),
		status: document.getElementById('status'),
	}

	/** 事件计数：自动化脚本靠它断言「确实发生过网络/解码活动」 */
	const counters = {
		loadstart: 0,
		loadedmetadata: 0,
		canplay: 0,
		playing: 0,
		pause: 0,
		seeking: 0,
		seeked: 0,
		waiting: 0,
		stalled: 0,
		error: 0,
		ended: 0,
	}

	const state = {
		queue: [],
		index: -1,
		mode: 'order',
	}

	const listeners = new Set()
	const on = (fn) => {
		listeners.add(fn)
		return () => listeners.delete(fn)
	}
	const emit = (event) => {
		for (const fn of listeners) {
			try {
				fn(event)
			} catch (error) {
				console.error('[player] 监听器抛错:', error)
			}
		}
	}

	// ---------------------------------------------------------------
	// 工具
	// ---------------------------------------------------------------

	function formatTime(seconds) {
		if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
		const total = Math.floor(seconds)
		const m = Math.floor(total / 60)
		const s = total % 60
		return `${m}:${String(s).padStart(2, '0')}`
	}

	function setStatus(text, kind) {
		if (!els.status) return
		els.status.textContent = text
		els.status.className = `status status--${kind || 'idle'}`
	}

	function describeError() {
		const error = els.audio.error
		if (!error) return null
		const names = {
			1: 'MEDIA_ERR_ABORTED',
			2: 'MEDIA_ERR_NETWORK',
			3: 'MEDIA_ERR_DECODE',
			4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
		}
		return {
			code: error.code,
			name: names[error.code] || `UNKNOWN(${error.code})`,
			message: error.message || null,
		}
	}

	function bufferedRanges() {
		const ranges = []
		try {
			for (let i = 0; i < els.audio.buffered.length; i++) {
				ranges.push([els.audio.buffered.start(i), els.audio.buffered.end(i)])
			}
		} catch {
			// 未就绪时读取 buffered 可能抛错
		}
		return ranges
	}

	const proxyUrlFor = (track) =>
		`bbplayer-audio://track/${encodeURIComponent(track.bvid)}`

	// ---------------------------------------------------------------
	// 队列
	// ---------------------------------------------------------------

	function setQueue(tracks, startIndex) {
		state.queue = tracks.slice()
		state.index = Number.isInteger(startIndex) ? startIndex : 0
		renderQueue()
		emit({ type: 'queue-changed' })
	}

	function playAt(index) {
		if (index < 0 || index >= state.queue.length) return false
		state.index = index
		const track = state.queue[index]
		if (!track) return false

		els.audio.src = proxyUrlFor(track)
		els.audio.load()
		updateNowPlaying()
		renderQueue()
		emit({ type: 'track-changed', track })
		return true
	}

	function nextIndex(auto) {
		const { queue, index, mode } = state
		if (queue.length === 0) return -1
		if (mode === 'repeat-one' && auto) return index
		if (mode === 'shuffle') {
			if (queue.length === 1) return index
			let candidate = index
			// 避免随机到同一首
			while (candidate === index) {
				candidate = Math.floor(Math.random() * queue.length)
			}
			return candidate
		}
		return (index + 1) % queue.length
	}

	function prevIndex() {
		const { queue, index } = state
		if (queue.length === 0) return -1
		return (index - 1 + queue.length) % queue.length
	}

	// ---------------------------------------------------------------
	// 播放控制
	// ---------------------------------------------------------------

	async function play() {
		try {
			await els.audio.play()
			return true
		} catch (error) {
			setStatus(`播放失败：${error.message}`, 'bad')
			return false
		}
	}

	function pause() {
		els.audio.pause()
	}

	function toggle() {
		if (els.audio.paused) return play()
		pause()
		return Promise.resolve(true)
	}

	async function playNext(auto) {
		const index = nextIndex(auto)
		if (index < 0) return false
		playAt(index)
		return await play()
	}

	async function playPrev() {
		const index = prevIndex()
		if (index < 0) return false
		playAt(index)
		return await play()
	}

	function seekTo(seconds) {
		els.audio.currentTime = seconds
	}

	function seekBy(delta) {
		const target = Math.max(0, els.audio.currentTime + delta)
		const duration = els.audio.duration
		els.audio.currentTime = Number.isFinite(duration)
			? Math.min(target, duration)
			: target
	}

	/**
	 * 把滑块已播放的比例写进 `--range-fill`。
	 *
	 * 滑块改成自绘（`appearance: none`）之后，进度不能再靠 Chromium 原生的
	 * 填充着色，需要自己给轨道上色 —— CSS 用这个变量把轨道分成
	 * 「已播放（主色）」与「剩余（surface-3）」两段。这样不用加任何 DOM。
	 */
	function syncRangeFill(input, percent) {
		if (!input) return
		const clamped = Math.max(0, Math.min(100, percent))
		input.style.setProperty('--range-fill', `${clamped}%`)
	}

	function setVolume(percent) {
		const clamped = Math.max(0, Math.min(100, percent))
		els.audio.volume = clamped / 100
		syncRangeFill(els.volume, clamped)
	}

	function cycleMode() {
		const i = PLAY_MODES.indexOf(state.mode)
		state.mode = PLAY_MODES[(i + 1) % PLAY_MODES.length]
		if (els.mode) {
			els.mode.innerHTML = icon(MODE_ICON[state.mode])
			els.mode.title = MODE_LABEL[state.mode]
			els.mode.setAttribute('aria-label', MODE_LABEL[state.mode])
		}
		emit({ type: 'mode-changed', mode: state.mode })
		return state.mode
	}

	// ---------------------------------------------------------------
	// 渲染
	// ---------------------------------------------------------------

	function updateNowPlaying() {
		const track = state.queue[state.index]
		if (els.title) els.title.textContent = track ? track.title : '未在播放'
		if (els.artist) els.artist.textContent = track ? track.artist || '—' : '—'
	}

	function renderQueue() {
		if (!els.queueList) return
		els.queueList.textContent = ''
		if (els.queueEmpty) els.queueEmpty.hidden = state.queue.length > 0

		state.queue.forEach((track, index) => {
			const li = document.createElement('li')
			li.className = 'queue-list__item'
			if (index === state.index) li.classList.add('is-playing')
			li.dataset.index = String(index)
			// 语义属性：探针计数用它，改视觉类名不会让它失效（见 ui() 里的注释）
			li.dataset.queueIndex = String(index)
			li.dataset.testid = `queue-item-${index}`
			li.title = track.title

			const span = document.createElement('span')
			span.className = 'queue-list__title'
			span.textContent = track.title
			li.appendChild(span)

			li.addEventListener('click', () => {
				playAt(index)
				void play()
			})
			els.queueList.appendChild(li)
		})
	}

	function updateProgress() {
		const { currentTime, duration } = els.audio
		if (els.timeCurrent) els.timeCurrent.textContent = formatTime(currentTime)
		if (els.timeTotal) els.timeTotal.textContent = formatTime(duration)
		if (els.progress && Number.isFinite(duration) && duration > 0) {
			// 拖动中不要覆盖用户的手动位置
			if (!isScrubbing) {
				els.progress.value = String(Math.round((currentTime / duration) * 1000))
				syncRangeFill(els.progress, (currentTime / duration) * 100)
			}
		}
	}

	// ---------------------------------------------------------------
	// 事件绑定
	// ---------------------------------------------------------------

	for (const name of Object.keys(counters)) {
		els.audio.addEventListener(name, () => {
			counters[name] += 1
			if (name === 'error') {
				const error = describeError()
				setStatus(`播放失败：${error ? error.name : '未知'}`, 'bad')
			} else if (name === 'playing') {
				setStatus('正在播放', 'ok')
				if (els.play) els.play.innerHTML = icon('pause')
			} else if (name === 'pause') {
				setStatus('已暂停', 'idle')
				if (els.play) els.play.innerHTML = icon('play_arrow')
			} else if (name === 'ended') {
				// 自动续播
				void playNext(true)
			}
			updateProgress()
		})
	}

	els.audio.addEventListener('timeupdate', updateProgress)

	let isScrubbing = false
	if (els.progress) {
		els.progress.addEventListener('input', () => {
			isScrubbing = true
			const duration = els.audio.duration
			// 拖动过程中也要跟着重画已播放段，否则滑块看着像没动
			syncRangeFill(els.progress, Number(els.progress.value) / 10)
			if (Number.isFinite(duration) && duration > 0) {
				const target = (Number(els.progress.value) / 1000) * duration
				if (els.timeCurrent) els.timeCurrent.textContent = formatTime(target)
			}
		})
		els.progress.addEventListener('change', () => {
			const duration = els.audio.duration
			if (Number.isFinite(duration) && duration > 0) {
				seekTo((Number(els.progress.value) / 1000) * duration)
			}
			isScrubbing = false
		})
		// 初始状态（value 默认是 0，所以这里是 0%，但显式设一次更稳）
		syncRangeFill(els.progress, Number(els.progress.value) / 10)
	}

	if (els.play) els.play.addEventListener('click', () => void toggle())
	if (els.next) els.next.addEventListener('click', () => void playNext(false))
	if (els.prev) els.prev.addEventListener('click', () => void playPrev())
	if (els.mode) els.mode.addEventListener('click', cycleMode)
	if (els.volume) {
		els.volume.addEventListener('input', () =>
			setVolume(Number(els.volume.value)),
		)
		// 初始音量也要把已填充段画出来（默认 100%）
		syncRangeFill(els.volume, Number(els.volume.value))
	}

	// ---------------------------------------------------------------
	// 对外接口
	// ---------------------------------------------------------------

	window.bbPlayer = {
		on,
		setQueue,
		playAt,
		play,
		pause,
		toggle,
		playNext,
		playPrev,
		seekTo,
		seekBy,
		cycleMode,
		getQueue: () => state.queue.slice(),
		getIndex: () => state.index,
		getCurrent: () => state.queue[state.index] || null,
		getMode: () => state.mode,
		getAudio: () => els.audio,
		describeError,
		bufferedRanges,
		counters,
		formatTime,
	}

	// ---------------------------------------------------------------
	// 自动化验证接口（保持与既有探针兼容）
	// ---------------------------------------------------------------

	const waitFor = (predicate, timeoutMs) =>
		new Promise((resolve) => {
			const start = Date.now()
			const tick = () => {
				let ok = false
				try {
					ok = Boolean(predicate())
				} catch {
					ok = false
				}
				if (ok) return resolve(true)
				if (Date.now() - start > timeoutMs) return resolve(false)
				setTimeout(tick, 100)
			}
			tick()
		})

	window.bbTest = {
		state() {
			const track = state.queue[state.index]
			return {
				readyState: els.audio.readyState,
				networkState: els.audio.networkState,
				duration: els.audio.duration,
				currentTime: els.audio.currentTime,
				paused: els.audio.paused,
				ended: els.audio.ended,
				src: els.audio.src,
				error: describeError(),
				buffered: bufferedRanges(),
				counters: { ...counters },
				mode: state.mode,
				queueLength: state.queue.length,
				queueIndex: state.index,
				resolved: track
					? {
							bvid: track.bvid,
							title: track.title,
							proxyUrl: proxyUrlFor(track),
						}
					: null,
				status: els.status ? els.status.textContent : '',
			}
		},

		/** 把一个 bvid 解析、加载并**开始播放**，验证代理链路 */
		async load(bvid) {
			counters.error = 0
			const resolved = await window.bbplayer.resolveAudio(bvid)
			if (!resolved.ok) return { ok: false, error: resolved.error }

			// 造一个临时队列，便于走统一的播放路径
			setQueue(
				[
					{
						bvid,
						title: resolved.data.title,
						artist: '',
						duration: resolved.data.duration,
					},
				],
				0,
			)
			playAt(0)

			const metaOk = await waitFor(() => els.audio.readyState >= 1, 15000)
			// 元数据就绪后开始播放：`load()` 的语义是「加载**并可播放**」，
			// 只 load 不 play 会让调用方以为已开始（实测踩过）。
			if (metaOk) await play()

			return {
				ok: metaOk,
				readyState: els.audio.readyState,
				duration: els.audio.duration,
				error: describeError(),
			}
		},

		async play() {
			await play()
			const ok = await waitFor(
				() => !els.audio.paused && els.audio.currentTime > 0,
				15000,
			)
			return {
				ok,
				currentTime: els.audio.currentTime,
				paused: els.audio.paused,
				error: describeError(),
			}
		},

		pause() {
			pause()
			return { paused: els.audio.paused }
		},

		async seek(seconds) {
			const before = els.audio.currentTime
			const seekedBefore = counters.seeked
			seekTo(seconds)
			const ok = await waitFor(() => counters.seeked > seekedBefore, 10000)
			return {
				ok,
				before,
				after: els.audio.currentTime,
				seekedEvents: counters.seeked - seekedBefore,
				error: describeError(),
			}
		},

		async advance(ms) {
			const start = els.audio.currentTime
			await new Promise((resolve) => setTimeout(resolve, ms))
			return {
				start,
				end: els.audio.currentTime,
				advanced: els.audio.currentTime - start,
			}
		},

		buttons() {
			return [...document.querySelectorAll('button')].map(
				(button) => button.textContent.trim() || button.title,
			)
		},

		log() {
			const el = document.getElementById('log')
			return el ? el.textContent : ''
		},

		/** 面板/视图的可见状态，供 UI 断言 */
		ui() {
			const visible = (selector) => {
				const el = document.querySelector(selector)
				if (!el) return false
				const rect = el.getBoundingClientRect()
				return rect.width > 0 && rect.height > 0
			}
			return {
				sidebar: visible('[data-testid="sidebar"]'),
				main: visible('[data-testid="main"]'),
				rightbar: visible('[data-testid="rightbar"]'),
				playbar: visible('[data-testid="playbar"]'),
				navItems: document.querySelectorAll('.nav__item').length,
				// ⚠️ 用**语义属性**而不是视觉类名来计数。
				// 侧栏歌单行原来叫 `.playlist-list__item`，阶段 1c 换成组件层的
				// `.list-row` 之后，这条断言就永远是 0 —— 探针会一直等一个
				// 永远不会满足的条件，表现为**整个套件卡死到超时**
				// （不是失败，是挂住，更难查）。
				// `data-playlist-id` 是行本身带的数据，与外观无关，改样式不会碰它。
				playlistItems: document.querySelectorAll('[data-playlist-id]').length,
				trackRows: document.querySelectorAll('.track-table tbody tr').length,
				queueItems: document.querySelectorAll('[data-queue-index]').length,
				activePanel: document.querySelector('.panel.is-active')?.dataset.panel,
				activeView: document
					.querySelector('.nav__item.is-active')
					?.getAttribute('data-view'),
				viewTitle: document.querySelector('.view-head h2')?.textContent || '',
			}
		},
	}
})()
