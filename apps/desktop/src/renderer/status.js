/**
 * 全局状态提示（阶段 2）。
 *
 * ## 为什么要有这个文件
 *
 * 原来底部有一条常驻状态栏：`就绪`，操作时变成 `已导入 24/24 首`。它有三个问题：
 *   1. **看起来像调试控制台** —— 一条永远存在的日志行；
 *   2. 底部是**最不显眼**的位置，而它承载的却是"刚刚发生了什么"；
 *   3. 它把界面永远撑高 26px，还和内容抢空间（历史上真出现过内容压到它上面）。
 *
 * 现在改成**浮动提示胶囊**：默认不显示，有反馈时出现在播放条上方，
 * `ok` 几秒后淡出。
 *
 * ## 为什么不用组件层的 toast
 *
 * 组件层的 `toast()` 会**创建和销毁**节点。而 `#status` 是六个渲染模块共用的
 * 反馈出口，也是探针读进度/结果的地方 —— 节点一旦被销毁，探针会读到 `null`，
 * 于是"操作完成了"和"什么都没发生"看起来一模一样。
 *
 * 所以这里刻意**只切类名、不删文本**：视觉上淡出，DOM 里仍然查得到。
 * 探针不会被"已经消失"骗到。
 *
 * ## 为什么不改那六个模块
 *
 * 它们的 `setStatus(node, text, kind)` 写的是 `node.textContent` 与
 * `node.className`。这里只在**外面**加一个观察者，按类名决定何时淡出 ——
 * 六个模块一行都不用动，风险最小。
 */
;(function () {
	'use strict'

	/**
	 * 各类型停留多久。
	 *
	 * ⚠️ **每一种都要淡出。** 原实现只让 `ok` / `warn` 淡出，
	 * `idle` / `busy` / `bad` 永远挂着 —— 用户实测反馈"胶囊不会消失，
	 * 会一直出现"，截图里能同时看到两条（一条失败提示、一条状态）。
	 *
	 * 分档而不是一刀切，是因为它们的"读多久才够"确实不同：
	 *   * `bad` 是错误，用户需要看清原因 → 留久一点；
	 *   * `busy` 是"进行中"，正常会被结果覆盖；万一卡住也不该永久占屏；
	 *   * `idle` / `ok` / `warn` 是即时状态，读几秒就够。
	 */
	const FADE_MS = {
		bad: 9000,
		busy: 9000,
		ok: 4500,
		warn: 4500,
		idle: 3500,
	}

	/** 从类名取出当前类型（`status--ok` → `ok`） */
	function currentKind() {
		for (const kind of Object.keys(FADE_MS)) {
			if (status.classList.contains(`status--${kind}`)) return kind
		}
		// 没有类型类（例如刚被清空）→ 按 idle 处理
		return 'idle'
	}

	const host = document.querySelector('[data-testid="status-host"]')
	const status = document.getElementById('status')
	if (!host || !status) return

	let timer = null

	function isEmpty() {
		return (status.textContent ?? '').trim() === ''
	}

	/** 按当前内容/类名决定显示还是淡出 */
	function sync() {
		host.classList.toggle('is-visible', !isEmpty() && !isEmptyKind())
	}

	function isEmptyKind() {
		// 空文本 + idle 类 = 没有任何要说的
		return isEmpty() && status.classList.contains('status--idle')
	}

	function scheduleFade() {
		if (timer) clearTimeout(timer)
		// 没内容就没什么可淡出的
		if (isEmpty()) return
		timer = setTimeout(() => {
			// ⚠️ 只加类名，**不清文本**：探针还要读（见文件头注释）
			host.classList.remove('is-visible')
		}, FADE_MS[currentKind()] ?? 4500)
	}

	const observer = new MutationObserver(() => {
		sync()
		scheduleFade()
	})
	observer.observe(status, {
		childList: true,
		characterData: true,
		subtree: true,
		attributes: true,
		attributeFilter: ['class'],
	})

	sync()

	window.bbStatus = {
		/** 立刻隐藏（但保留文本，探针仍可读） */
		hide: () => host.classList.remove('is-visible'),
		/** 供探针断言：当前是否可见、文本是什么 */
		describe: () => ({
			visible: host.classList.contains('is-visible'),
			text: status.textContent ?? '',
			kind: [...status.classList]
				.find((c) => c.startsWith('status--'))
				?.replace('status--', ''),
			elementExists: document.body.contains(status),
		}),
	}
})()
