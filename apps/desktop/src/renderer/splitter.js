/**
 * 左栏宽度可拖拽（阶段 6）。
 *
 * 用户的原话：「要能支持左右拉动各个功能区，能改变大小。就是鼠标放到上面会变成
 * 左右箭头样式」，并逐条确认了：
 *   * 只做**左栏 ↔ 中栏**这一条边界（不是所有边界）；
 *   * 宽度**记住**（重启还原）；
 *   * **双击分隔条还原默认**；
 *   * **拖到极窄时自动收起该栏**。
 *
 * ## 为什么宽度走 CSS 变量而不是改内联样式
 *
 * `.app` 是网格：`grid-template-columns: 240px minmax(0,1fr) 320px`。
 * 把第一列写成 `var(--sidebar-width, 240px)` 之后，**收起状态（0）与
 * 右栏收起状态（`is-rightbar-collapsed`）可以同时成立** —— 它们各自只改
 * 一个变量/类，不会互相覆盖（如果两个状态都直接写 `grid-template-columns`，
 * 后写的那个会把另一个吃掉，而这种覆盖在界面上表现为"某次展开/收起失灵"）。
 */
;(function () {
	'use strict'

	const DEFAULT_WIDTH = 240
	/** 再窄就没有可用性了；到这个值以下**自动收起**（用户确认的行为） */
	const MIN_WIDTH = 150
	/** 右栏展开时的上限：再宽就把内容挤没了 */
	const MAX_WIDTH = 520

	const app = document.querySelector('.app')
	const splitter = document.getElementById('sidebar-splitter')
	if (!app || !splitter) return

	/** 当前宽度（0 = 已收起） */
	let width = DEFAULT_WIDTH
	let dragging = false

	function apply(next, { persist = false } = {}) {
		width = next
		const collapsed = width <= 0
		app.classList.toggle('is-sidebar-collapsed', collapsed)
		app.style.setProperty('--sidebar-width', `${collapsed ? 0 : width}px`)
		splitter.setAttribute('aria-valuenow', String(width))
		if (persist) {
			// 不 await：拖拽结束时界面已经更新，落盘失败也不该让手柄卡住
			void window.bbplayer?.settings?.update?.({ sidebarWidth: width })
		}
	}

	// 首屏：用上次存的宽度（`0` 是合法的"已收起"）
	void (async () => {
		try {
			const result = await window.bbplayer.settings.get()
			/*
			 * ⚠️ 是 `data.settings.sidebarWidth` —— `settings.get()` 返回的是
			 * `describe()`，真正的设置值嵌在 `settings` 这一层里。
			 * 少剥一层就是 `undefined`，于是"记住宽度"永远悄悄退回默认值
			 * （这个仓库在 `describe().settings.theme` 上已经栽过一次）。
			 */
			const saved = result?.data?.settings?.sidebarWidth
			apply(typeof saved === 'number' ? saved : DEFAULT_WIDTH)
		} catch {
			apply(DEFAULT_WIDTH)
		}
	})()

	splitter.addEventListener('pointerdown', (event) => {
		// 只认左键；并抓住指针 —— 否则鼠标移出这个 6px 的条就丢事件
		if (event.button !== 0) return
		event.preventDefault()
		dragging = true
		splitter.setPointerCapture(event.pointerId)
		splitter.classList.add('is-dragging')
	})

	splitter.addEventListener('pointermove', (event) => {
		if (!dragging) return
		// 左栏从 0 开始，所以指针的 clientX 就是要的宽度
		const next = event.clientX
		if (next < MIN_WIDTH) {
			// 「拖到极窄」→ 收起（而不是卡在 150px 一个尴尬的窄条）
			apply(0)
			return
		}
		apply(Math.min(next, MAX_WIDTH))
	})

	function endDrag(event) {
		if (!dragging) return
		dragging = false
		splitter.classList.remove('is-dragging')
		if (event?.pointerId != null) {
			try {
				splitter.releasePointerCapture(event.pointerId)
			} catch {
				// 指针已经释放过就忽略
			}
		}
		apply(width, { persist: true })
	}
	splitter.addEventListener('pointerup', endDrag)
	splitter.addEventListener('pointercancel', endDrag)

	// 双击还原默认宽度（用户确认）
	splitter.addEventListener('dblclick', () => {
		apply(DEFAULT_WIDTH, { persist: true })
	})

	// 键盘可达：左右方向键微调、Home 还原（分隔条是 `role="separator"`）
	splitter.addEventListener('keydown', (event) => {
		const step = event.shiftKey ? 32 : 8
		if (event.key === 'ArrowLeft') {
			apply(Math.max(0, (width || DEFAULT_WIDTH) - step), { persist: true })
		} else if (event.key === 'ArrowRight') {
			apply(Math.max(MIN_WIDTH, width + step), { persist: true })
		} else if (event.key === 'Home') {
			apply(DEFAULT_WIDTH, { persist: true })
		} else {
			return
		}
		event.preventDefault()
	})
	splitter.tabIndex = 0

	window.bbSidebar = {
		describe: () => ({
			width,
			collapsed: width <= 0,
			defaultWidth: DEFAULT_WIDTH,
		}),
		set: (value) => apply(value, { persist: true }),
	}
})()
