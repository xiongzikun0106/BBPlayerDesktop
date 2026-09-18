/**
 * 歌词面板（渲染进程，纯 Web，无框架）。
 *
 * 设计约束：preload 是别人正在改的文件，本模块**不碰 IPC**。
 * 它只是一个「接收数据的纯 UI 模块」：
 *
 *   const panel = window.createLyricsPanel(container)
 *   panel.setLyrics([{ startTime, content, translation }])   // startTime 单位毫秒
 *   panel.setActiveIndex(3)                                  // 高亮并滚动居中
 *   panel.setOffset(-0.5)                                    // 歌词偏移（秒）
 *
 * 由主进程订阅 `player:position` 事件自己按偏移量算当前行 ——
 * 这样 UI 不需要知道播放器在哪，也不需要在渲染进程里跑计时器，
 * 控制台 / 自动化脚本可以完全脱离音频驱动它。
 *
 * 同时挂到 `window.__lyricsPanel`，便于 CDP / executeJavaScript 自动化断言。
 */
;(function attachLyricsPanel(global) {
	'use strict'

	/** 默认的「当前行」判定容差（毫秒）：歌词通常比人声早一点点出来 */
	const LYRIC_LEAD_MS = 0

	/** 高亮线距离滚动区中心的最大距离（px），保证超短面板也不会滚飞 */
	function clamp(value, min, max) {
		return Math.min(max, Math.max(min, value))
	}

	/** 毫秒 -> m:ss */
	function formatTime(ms) {
		const total = Math.max(0, Math.round(ms / 1000))
		const minutes = Math.floor(total / 60)
		const seconds = total % 60
		return `${minutes}:${String(seconds).padStart(2, '0')}`
	}

	/** 把任意输入整形成面板内部的歌词行结构 */
	function normalizeLine(input, index) {
		const startTime = Number(input?.startTime)
		const translations = Array.isArray(input?.translations)
			? input.translations.filter((item) => typeof item === 'string' && item)
			: []
		let translation = input?.translation
		if (!translation && translations.length > 0) translation = translations[0]
		return {
			index,
			startTime: Number.isFinite(startTime) ? startTime : 0,
			content: typeof input?.content === 'string' ? input.content : '',
			translation:
				typeof translation === 'string' && translation ? translation : null,
		}
	}

	/**
	 * 二分查找 offsetSec 时刻对应的行号。
	 *
	 * 返回 `-1` 表示「还没到第一行」（前奏），调用方据此清空高亮。
	 */
	function findActiveIndex(lines, positionMs) {
		if (lines.length === 0) return -1
		if (positionMs < lines[0].startTime) return -1

		let low = 0
		let high = lines.length - 1
		let found = 0
		while (low <= high) {
			const mid = (low + high) >> 1
			if (lines[mid].startTime <= positionMs) {
				found = mid
				low = mid + 1
			} else {
				high = mid - 1
			}
		}
		return found
	}

	/**
	 * 创建歌词面板。
	 *
	 * @param {HTMLElement} container 挂载容器（会被清空）
	 * @param {{ offset?: number, emptyText?: string }} [options]
	 */
	function createLyricsPanel(container, options) {
		if (!container || typeof container.appendChild !== 'function') {
			throw new Error('createLyricsPanel: 需要一个 HTMLElement 容器')
		}

		const emptyText = options?.emptyText ?? '暂无歌词'

		/** @type {ReturnType<typeof normalizeLine>[]} */
		let lines = []
		/** 高亮行下标；-1 表示「没有当前行」 */
		let activeIndex = -1
		/** 偏移（秒）：正数表示歌词提前显示 */
		let offsetSec = Number.isFinite(options?.offset)
			? Number(options.offset)
			: 0
		/** 最近一次 setPosition 的播放位置（毫秒），供 getState 汇报 */
		let lastPositionMs = null

		// ── DOM ────────────────────────────────────────────────
		container.classList.add('lyrics-panel')
		container.textContent = ''

		const headerEl = document.createElement('div')
		headerEl.className = 'lyrics-panel__header'
		headerEl.dataset.testid = 'lyrics-header'

		const metaEl = document.createElement('div')
		metaEl.className = 'lyrics-panel__meta mono'
		metaEl.dataset.testid = 'lyrics-meta'

		const offsetEl = document.createElement('div')
		offsetEl.className = 'lyrics-panel__offset'
		offsetEl.dataset.testid = 'lyrics-offset'

		const offsetLabel = document.createElement('span')
		offsetLabel.className = 'lyrics-panel__offset-value mono'
		offsetLabel.dataset.testid = 'lyrics-offset-value'

		const minusButton = document.createElement('button')
		minusButton.type = 'button'
		minusButton.className = 'lyrics-panel__offset-btn'
		minusButton.dataset.testid = 'lyrics-offset-minus'
		minusButton.textContent = '−0.5s'
		minusButton.title = '歌词延后 0.5 秒'

		const plusButton = document.createElement('button')
		plusButton.type = 'button'
		plusButton.className = 'lyrics-panel__offset-btn'
		plusButton.dataset.testid = 'lyrics-offset-plus'
		plusButton.textContent = '+0.5s'
		plusButton.title = '歌词提前 0.5 秒'

		const resetButton = document.createElement('button')
		resetButton.type = 'button'
		resetButton.className = 'lyrics-panel__offset-btn is-reset'
		resetButton.dataset.testid = 'lyrics-offset-reset'
		resetButton.textContent = '归零'
		resetButton.title = '偏移归零'

		offsetEl.append(minusButton, offsetLabel, plusButton, resetButton)
		headerEl.append(metaEl, offsetEl)

		const scrollEl = document.createElement('div')
		scrollEl.className = 'lyrics-panel__scroll'
		scrollEl.dataset.testid = 'lyrics-scroll'

		const listEl = document.createElement('ul')
		listEl.className = 'lyrics-panel__list'
		listEl.dataset.testid = 'lyrics-list'

		const spacerTop = document.createElement('li')
		spacerTop.className = 'lyrics-panel__spacer'
		spacerTop.setAttribute('aria-hidden', 'true')
		const spacerBottom = document.createElement('li')
		spacerBottom.className = 'lyrics-panel__spacer'
		spacerBottom.setAttribute('aria-hidden', 'true')

		scrollEl.append(listEl)
		container.append(headerEl, scrollEl)

		/**
		 * 空状态只建一次，靠 hidden 切换。
		 *
		 * ⚠️ 用组件层的 `.empty`（图标 + 标题 + 说明），不要自己拼一行灰字。
		 *
		 * 第一版就是 `<div class="... muted">暂无歌词</div>` ——
		 * 截图审查里它是"一行灰字悬在中上部，无图标、无说明、无出口"，
		 * 与设置页 / 欢迎视图里那些**被设计过的**空状态完全不是一套语言。
		 * 同一个应用里不该有两种空状态。
		 *
		 * `data-testid="lyrics-empty"` 保留在外层，探针按它找不受影响。
		 */
		const emptyEl = document.createElement('div')
		emptyEl.className = 'lyrics-panel__empty'
		emptyEl.dataset.testid = 'lyrics-empty'
		if (window.bbComponents?.empty) {
			emptyEl.appendChild(
				window.bbComponents.empty({
					testid: 'lyrics-empty-box',
					iconName: 'lyrics',
					title: emptyText,
					hint: '正在播放的曲目如果有歌词，会自动显示在这里。',
				}),
			)
		} else {
			// 组件层还没就绪时退回纯文本，不让面板空着
			emptyEl.classList.add('muted')
			emptyEl.textContent = emptyText
		}
		scrollEl.append(emptyEl)

		/** @type {HTMLElement[]} 与 lines 同下标的 DOM 节点 */
		let lineEls = []

		// ── 渲染 ───────────────────────────────────────────────

		function updateMeta() {
			const hasActive = activeIndex >= 0 && activeIndex < lines.length
			metaEl.textContent = hasActive
				? `${activeIndex + 1} / ${lines.length} · ${formatTime(lines[activeIndex].startTime)}`
				: lines.length > 0
					? `— / ${lines.length}`
					: '— / 0'
			offsetLabel.textContent = `${offsetSec >= 0 ? '+' : ''}${offsetSec.toFixed(1)}s`
			offsetLabel.dataset.offset = offsetSec.toFixed(1)
			offsetEl.dataset.offset = offsetSec.toFixed(1)
		}

		function applyActive() {
			for (let i = 0; i < lineEls.length; i++) {
				const el = lineEls[i]
				const isActive = i === activeIndex
				el.classList.toggle('is-active', isActive)
				if (isActive) el.setAttribute('aria-current', 'true')
				else el.removeAttribute('aria-current')
			}
			container.dataset.active = String(activeIndex)
			updateMeta()
		}

		function renderLines() {
			listEl.textContent = ''
			lineEls = []
			emptyEl.hidden = lines.length > 0

			if (lines.length === 0) {
				applyActive()
				return
			}

			listEl.append(spacerTop)
			const fragment = document.createDocumentFragment()
			for (const line of lines) {
				const item = document.createElement('li')
				item.className = 'lyrics-panel__line'
				item.dataset.testid = 'lyric-line'
				item.dataset.index = String(line.index)
				item.dataset.time = String(line.startTime)

				const main = document.createElement('span')
				main.className = 'lyrics-panel__text'
				main.dataset.testid = 'lyric-text'
				// 空行（间奏）给一个可读的占位符，否则行高会塌掉
				main.textContent = line.content || '· · ·'
				if (!line.content) main.classList.add('is-blank')
				item.append(main)

				if (line.translation) {
					const sub = document.createElement('span')
					sub.className = 'lyrics-panel__translation'
					sub.dataset.testid = 'lyric-translation'
					sub.textContent = line.translation
					item.append(sub)
				}

				item.addEventListener('click', () => {
					// 点击某行 => 让外部去 seek（面板自己不放音频）
					container.dispatchEvent(
						new CustomEvent('lyricseek', {
							bubbles: true,
							detail: { index: line.index, startTime: line.startTime },
						}),
					)
				})

				lineEls.push(item)
				fragment.append(item)
			}
			listEl.append(fragment, spacerBottom)
			applySpacerHeight()
			applyActive()
		}

		/** 把上下留白设成「半个滚动区高度」，让首尾行也能居中 */
		function applySpacerHeight() {
			const half = Math.max(40, Math.round(scrollEl.clientHeight / 2))
			const value = `${half}px`
			spacerTop.style.height = value
			spacerBottom.style.height = value
		}

		/** 把高亮行滚到滚动区垂直中央；`smooth` 供手动点击时用 */
		function scrollActiveIntoView(smooth) {
			const el = lineEls[activeIndex]
			if (!el) return
			const target =
				el.offsetTop - scrollEl.clientHeight / 2 + el.offsetHeight / 2
			const maxScroll = Math.max(
				0,
				scrollEl.scrollHeight - scrollEl.clientHeight,
			)
			const top = clamp(target, 0, maxScroll)
			if (typeof scrollEl.scrollTo === 'function') {
				scrollEl.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
			} else {
				scrollEl.scrollTop = top
			}
		}

		// ── 偏移按钮 ───────────────────────────────────────────

		function bumpOffset(delta) {
			setOffset(offsetSec + delta)
		}

		minusButton.addEventListener('click', () => bumpOffset(-0.5))
		plusButton.addEventListener('click', () => bumpOffset(0.5))
		resetButton.addEventListener('click', () => setOffset(0))

		// 面板尺寸变化（窗口缩放 / 布局切换）后留白要重算，
		// 否则「居中」会随着视口变高而逐渐偏上。
		let resizeObserver = null
		if (typeof ResizeObserver === 'function') {
			resizeObserver = new ResizeObserver(() => {
				applySpacerHeight()
				scrollActiveIntoView(false)
			})
			resizeObserver.observe(scrollEl)
		}

		// ── 公开 API ───────────────────────────────────────────

		/** 写入歌词（会重置高亮并滚回顶部） */
		function setLyrics(nextLines) {
			const raw = Array.isArray(nextLines) ? nextLines : []
			lines = raw.map((item, index) => normalizeLine(item, index))
			activeIndex = -1
			renderLines()
			scrollEl.scrollTop = 0
			lastPositionMs = null
			return getState()
		}

		/** 直接指定高亮行（自动化 / 手动跳转用） */
		function setActiveIndex(index) {
			const next = Number(index)
			const resolved =
				Number.isFinite(next) && next >= 0 && next < lines.length
					? Math.trunc(next)
					: -1
			const changed = resolved !== activeIndex
			activeIndex = resolved
			applyActive()
			if (changed) scrollActiveIntoView(false)
			return getState()
		}

		/** 设置偏移（秒）；会立即重算高亮 */
		function setOffset(seconds) {
			const next = Number(seconds)
			offsetSec = Number.isFinite(next) ? Math.round(next * 10) / 10 : 0
			// 注意单位：`lastPositionMs` 是毫秒，而 `setPosition` 收的是**秒**。
			// 直接把毫秒传进去会被再乘一次 1000（偏移后高亮跳到错误位置）；
			// 另外 `!== null` 的判断是必要的 —— 位置 0 是合法值，不能用真值判断。
			if (lastPositionMs !== null) setPosition(lastPositionMs / 1000)
			else updateMeta()
			return getState()
		}

		/**
		 * 由播放位置驱动高亮。
		 *
		 * 语义（必须和按钮文案一致，之前这里写反过一次）：
		 *   effective = position + offset
		 * 偏移为 `+1.5s` 时相当于「假装已经放到 1.5 秒之后」，
		 * 也就是**歌词提前 1.5 秒**出现。所以 +1.5s 的偏移下，
		 * 播放位置 40.5s 会高亮 42s 的那一行。
		 */
		function setPosition(positionSec) {
			const seconds = Number(positionSec)
			if (!Number.isFinite(seconds)) return getState()
			lastPositionMs = seconds * 1000
			const effective = seconds * 1000 + offsetSec * 1000 + LYRIC_LEAD_MS
			return setActiveIndex(findActiveIndex(lines, effective))
		}

		function getState() {
			const active = activeIndex >= 0 ? lines[activeIndex] : null
			return {
				lineCount: lines.length,
				activeIndex,
				offset: offsetSec,
				/** 便于脚本断言「高亮的是哪一行」 */
				activeText: active?.content ?? null,
				activeTranslation: active?.translation ?? null,
				activeTime: active?.startTime ?? null,
				lines: lines.map((line) => ({
					index: line.index,
					startTime: line.startTime,
					content: line.content,
					translation: line.translation,
				})),
			}
		}

		function destroy() {
			resizeObserver?.disconnect()
			resizeObserver = null
			container.textContent = ''
			container.classList.remove('lyrics-panel')
			lines = []
			lineEls = []
		}

		const api = {
			setLyrics,
			setActiveIndex,
			setOffset,
			setPosition,
			getState,
			destroy,
			/** 测试用的纯函数出口，便于脚本在页面里直接复算 */
			_findActiveIndex: (positionMs) => findActiveIndex(lines, positionMs),
		}

		applyActive()
		return api
	}

	global.createLyricsPanel = createLyricsPanel
	global.__lyricsPanelUtils = { findActiveIndex, formatTime }

	// 若页面提供了挂载点，自动创建一份，方便自动化脚本直接驱动
	if (typeof document !== 'undefined') {
		const boot = () => {
			const existing = document.getElementById('lyrics-panel')
			if (existing && !global.__lyricsPanel) {
				global.__lyricsPanel = createLyricsPanel(existing)
			}
			document.dispatchEvent(new CustomEvent('lyrics-panel-ready'))
		}
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', boot, { once: true })
		} else {
			boot()
		}
	}
})(typeof window !== 'undefined' ? window : globalThis)
