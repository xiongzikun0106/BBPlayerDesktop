/**
 * 独立歌词窗口的渲染逻辑（Phase 4.1）。
 *
 * ## 数据从哪来
 *
 * 歌词窗口**不自己取数据**：它不知道播放器状态，也不该去请求接口。
 * 主窗口把「歌词行 + 当前时间 + 曲目信息」通过主进程转发过来
 * （`lw:update` / `lw:position` 事件），这里只负责渲染。
 *
 * 这样做的原因：歌词匹配是有状态的（要跟当前曲目对齐、要处理并发覆盖），
 * 那套逻辑已经在主窗口里了；复制一份到这里的唯一结果是两边不一致。
 *
 * ## 为什么用 translateY 整体滚动
 *
 * 容器自身滚动（`scrollTop`）会有滚动条、惯性、以及 `scrollIntoView` 的
 * 对齐不确定等问题。用一个长列表整体平移，可以让「当前行正好在第 N 行」
 * 这个位置完全由代码决定，也能精确断言（验证脚本会读 `transform`）。
 */
;(function () {
	'use strict'

	/** 行高，必须与 `lyrics-window.css` 里的 `.lyrics__line` 一致 */
	const LINE_HEIGHT = 30
	/** 当前行放在可视区的第几行（0 基） */
	const ACTIVE_ROW = 2

	const els = {
		wrap: document.getElementById('wrap'),
		title: document.getElementById('title'),
		lyrics: document.getElementById('lyrics'),
		empty: document.getElementById('empty'),
		progress: document.getElementById('progress-bar'),
		lock: document.getElementById('btn-lock'),
		close: document.getElementById('btn-close'),
	}

	/** 当前歌词行（来自主窗口） */
	let lines = []
	/** 当前高亮下标 */
	let activeIndex = -1
	/** 是否锁定拖动 */
	let locked = false

	/**
	 * 计算把第 `activeIndex` 行放到 `ACTIVE_ROW` 行所需的平移量。
	 *
	 * 减去半个可视高度让整体居中：容器高度的一半对应「中间那一行」，
	 * 我们想让 activeIndex 落在 ACTIVE_ROW*LINE_HEIGHT 的位置。
	 */
	function computeOffset(index) {
		const containerHeight = els.lyrics?.clientHeight ?? 0
		return (
			containerHeight / 2 -
			LINE_HEIGHT / 2 -
			(index * LINE_HEIGHT + LINE_HEIGHT / 2) +
			ACTIVE_ROW * LINE_HEIGHT
		)
	}

	function renderLines() {
		if (!els.lyrics) return
		els.lyrics.textContent = ''

		if (lines.length === 0) {
			els.empty.hidden = false
			return
		}
		els.empty.hidden = true

		const list = document.createElement('div')
		list.className = 'lyrics__list'
		list.dataset.testid = 'lw-list'

		for (const [index, line] of lines.entries()) {
			const row = document.createElement('div')
			row.className = 'lyrics__line'
			row.dataset.index = String(index)
			row.dataset.testid = `lw-line-${index}`
			row.textContent = line.content ?? ''
			list.appendChild(row)

			if (line.translation) {
				const translation = document.createElement('div')
				translation.className = 'lyrics__translation'
				translation.textContent = line.translation
				list.appendChild(translation)
			}
		}

		els.lyrics.appendChild(list)
		// 首屏先摆好位置，避免从顶部跳一下
		applyOffset()
	}

	/** 按当前 activeIndex 平移列表并切换高亮 */
	function applyOffset() {
		if (!els.lyrics) return
		const list = els.lyrics.querySelector('.lyrics__list')
		if (!list) return

		for (const row of list.querySelectorAll('.lyrics__line')) {
			row.classList.toggle(
				'is-active',
				Number(row.dataset.index) === activeIndex,
			)
		}

		if (activeIndex < 0) {
			list.style.transform = 'translateY(0px)'
			return
		}
		list.style.transform = `translateY(${computeOffset(activeIndex)}px)`
	}

	/** 高亮某一行的「中间态」：换行时把上一行也标一下，视觉更连续 */
	function findByTime(ms) {
		if (lines.length === 0) return -1
		let found = -1
		for (const [index, line] of lines.entries()) {
			if (line.startTime <= ms) found = index
			else break
		}
		return found
	}

	// ---------------------------------------------------------------
	// 与主进程的通道
	// ---------------------------------------------------------------

	window.bbLyricsWindow = {
		/** 收到整首歌的歌词（换曲或重新匹配时） */
		setLyrics(nextLines) {
			lines = Array.isArray(nextLines) ? nextLines : []
			activeIndex = -1
			renderLines()
			return lines.length
		},

		/** 只更新当前位置（高频，每 timeupdate 一次） */
		setPosition(seconds) {
			if (lines.length === 0) return
			const ms = Number(seconds) * 1000
			const index = findByTime(ms)
			if (index === activeIndex) return
			activeIndex = index
			applyOffset()
		},

		/** 曲目信息（标题栏 + 进度条） */
		setTrack(info) {
			if (els.title) {
				els.title.textContent = info?.title ?? '未在播放'
			}
			return info?.title ?? null
		},

		setProgress(ratio) {
			if (!els.progress) return
			const percent = Math.max(0, Math.min(1, Number(ratio) || 0)) * 100
			els.progress.style.width = `${percent}%`
		},

		setLocked(next) {
			locked = Boolean(next)
			document.body.classList.toggle('is-locked', locked)
			if (els.lock) els.lock.textContent = locked ? '🔒' : '🔓'
			return locked
		},

		/** 供自动化断言：当前渲染状态 */
		describe() {
			const list = els.lyrics?.querySelector('.lyrics__list')
			return {
				lineCount: lines.length,
				activeIndex,
				title: els.title?.textContent ?? null,
				lineElements: els.lyrics?.querySelectorAll('.lyrics__line').length ?? 0,
				activeElements:
					els.lyrics?.querySelectorAll('.lyrics__line.is-active').length ?? 0,
				transform: list?.style.transform ?? null,
				emptyHidden: els.empty?.hidden ?? null,
				locked,
				progressWidth: els.progress?.style.width ?? null,
			}
		},
	}

	// ---------------------------------------------------------------
	// 事件
	// ---------------------------------------------------------------

	els.close?.addEventListener('click', () => {
		window.bbLyricsWindowBridge?.close()
	})

	els.lock?.addEventListener('click', () => {
		const next = !locked
		// ⚠️ **本地先应用**，再通知主进程持久化。
		//
		// 第一版只调 `bridge.setLocked(next)` 等主进程回传，而主进程那边只是
		// 记了状态、没有回传 —— 于是点锁定按钮**完全没有任何可见效果**
		// （实测 `body.is-locked` 始终 false、图标也不变）。
		// 本地先应用既响应更快，也不依赖主进程的往返。
		window.bbLyricsWindow.setLocked(next)
		window.bbLyricsWindowBridge?.setLocked(next)
	})

	// 窗口尺寸变化时重新居中（拖动改变高度后必须重算）
	window.addEventListener('resize', () => applyOffset())

	// 主进程推来的事件
	window.bbLyricsWindowBridge?.onLyrics((nextLines) =>
		window.bbLyricsWindow.setLyrics(nextLines),
	)
	window.bbLyricsWindowBridge?.onPosition((seconds) =>
		window.bbLyricsWindow.setPosition(seconds),
	)
	window.bbLyricsWindowBridge?.onTrack((info) =>
		window.bbLyricsWindow.setTrack(info),
	)
	window.bbLyricsWindowBridge?.onProgress((ratio) =>
		window.bbLyricsWindow.setProgress(ratio),
	)
	// 主进程在窗口打开时会推一次当前的锁定状态（窗口关闭再打开要保持一致）
	window.bbLyricsWindowBridge?.onLocked((next) =>
		window.bbLyricsWindow.setLocked(next),
	)

	// 就绪握手：主动要一次当前歌词/曲目/锁定状态，
	// 否则要等到下一次 timeupdate 才有内容（换曲瞬间看起来像卡住）
	window.bbLyricsWindowBridge?.ready?.()

	window.__bbLyricsWindowReady = true
})()
