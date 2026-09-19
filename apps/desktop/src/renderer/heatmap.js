/**
 * 听歌频率热力图（阶段 6d-4）。
 *
 * ## 为什么是"重画"而不是"复用组件"
 *
 * 移动端用的是 `packages/heatmap` 的 `WeeklyHeatMap` —— 那是 **React Native
 * SVG** 组件，而桌面渲染进程是纯 DOM/JS（没有 React，也没有 RN 的 SVG 绑定）。
 * 所以这里复用的是它的**规则**，不是它的代码：
 *
 *   * 网格：最近一年、**按周分列 × 7 天**（`getWeeklyData`，周日起）
 *   * 档位：**固定阈值** ≥1 / ≥2 / ≥3 / ≥4（`calendar.ts:88-102` 的 `getLevel`），
 *     不是分位数 —— 分位数会让"这个月只听了 3 次"也画成深色
 *   * 配色：**主题主色的 20/40/60/100% 透明度**，空单元用 surfaceVariant
 *     （`index.tsx:397-403`）
 *   * 有数据/没数据**都画网格**（新用户看到的是一整片灰格子，不是空白）
 *   * 初始滚到最新（`initialScrollEnd`）
 *
 * ⚠️ 与移动端的差别（因宽屏）：格子按**窗口宽度**缩放。
 * 移动端写死 `cellSize=18 gap=4`（横向可滚动）；桌面端中栏是有限的宽，
 * 一年 53 周 × 22px = 1166px 会溢出（巡检的"横向溢出"规则会直接报）。
 * 所以这里算一个能放下的格子尺寸，**下限 10px**（再小就看不出来了），
 * 且始终保持 1:1 的方格与圆角。
 */
;(function () {
	'use strict'

	const SVG_NS = 'http://www.w3.org/2000/svg'
	/** 与移动端一致的固定档位 */
	const LEVELS = [1, 2, 3, 4]
	const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']
	/** 最近一年 */
	const DAYS = 371

	function el(name, attrs = {}) {
		const node = document.createElementNS(SVG_NS, name)
		for (const [key, value] of Object.entries(attrs)) {
			node.setAttribute(key, String(value))
		}
		return node
	}

	/** 本地日期串（**不能用 `toISOString`** —— 那会按 UTC 切天） */
	function dateKey(date) {
		const y = date.getFullYear()
		const m = String(date.getMonth() + 1).padStart(2, '0')
		const d = String(date.getDate()).padStart(2, '0')
		return `${y}-${m}-${d}`
	}

	function startOfDay(date) {
		return new Date(date.getFullYear(), date.getMonth(), date.getDate())
	}

	function addDays(date, days) {
		const next = new Date(date)
		next.setDate(next.getDate() + days)
		return next
	}

	/**
	 * 把"每天的次数"变成画图用的坐标。
	 *
	 * 列 = 周（周日起），行 = 星期几 —— 与移动端 `getWeeklyData` 同一套。
	 */
	function buildGrid(byDate, today) {
		const end = startOfDay(today ?? new Date())
		const start = addDays(end, -(DAYS - 1))
		// 起点回退到所在周的周日：否则第一列只有半列，左边的星期标签会错位
		const gridStart = addDays(start, -start.getDay())

		const weeks = []
		let cursor = gridStart
		while (cursor <= end) {
			const week = []
			for (let i = 0; i < 7; i++) {
				const day = addDays(cursor, i)
				week.push({
					date: day,
					key: dateKey(day),
					inRange: day >= start && day <= end,
					count: Number(byDate?.[dateKey(day)] ?? 0),
				})
			}
			weeks.push(week)
			cursor = addDays(cursor, 7)
		}
		return { weeks, start, end }
	}

	function levelOf(count) {
		let level = 0
		for (const threshold of LEVELS) {
			if (count >= threshold) level = threshold
		}
		return level
	}

	/**
	 * 画到 `container` 里。
	 *
	 * @param {HTMLElement} container
	 * @param {Record<string, number>} byDate
	 * @param {{ onPick?: (key: string) => void, today?: Date }} [options]
	 */
	function render(container, byDate, { onPick, today } = {}) {
		container.textContent = ''
		const { weeks, start } = buildGrid(byDate, today)

		// 按容器可用宽度算格子尺寸（见文件头注释）
		const available = Math.max(320, container.clientWidth || 900)
		const weekdayGutter = 26
		const monthLabelHeight = 18
		const minCell = 10
		const cell = Math.max(
			minCell,
			Math.min(18, Math.floor((available - weekdayGutter) / weeks.length) - 3),
		)
		const gap = cell >= 14 ? 4 : 3
		const step = cell + gap

		const width = weekdayGutter + weeks.length * step
		const height = monthLabelHeight + 7 * step

		const svg = el('svg', {
			class: 'heatmap',
			viewBox: `0 0 ${width} ${height}`,
			width,
			height,
			role: 'img',
			'aria-label': '听歌频率热力图',
		})

		// 月份标签：某一列的 1 号就标它的月份
		let lastMonth = -1
		weeks.forEach((week, column) => {
			const first = week.find((day) => day.inRange)
			if (!first) return
			const month = first.date.getMonth()
			if (month === lastMonth) return
			lastMonth = month
			const text = el('text', {
				x: weekdayGutter + column * step,
				y: 12,
				class: 'heatmap__label',
			})
			text.textContent = `${month + 1} 月`
			svg.appendChild(text)
		})

		// 星期标签：只标 一 / 三 / 五（移动端同款，全标会挤）
		for (const row of [1, 3, 5]) {
			const text = el('text', {
				x: 0,
				y: monthLabelHeight + row * step + cell - 2,
				class: 'heatmap__label',
			})
			text.textContent = WEEKDAY_LABELS[row]
			svg.appendChild(text)
		}

		let total = 0
		weeks.forEach((week, column) => {
			week.forEach((day, row) => {
				if (!day.inRange) return
				total += day.count
				const level = levelOf(day.count)
				const rect = el('rect', {
					x: weekdayGutter + column * step,
					y: monthLabelHeight + row * step,
					width: cell,
					height: cell,
					rx: Math.max(2, Math.round(cell / 4)),
					ry: Math.max(2, Math.round(cell / 4)),
					class: `heatmap__cell${level > 0 ? ` heatmap__cell--l${level}` : ''}`,
					// 与移动端一致：**每格可点**（点一天看那天的历史）
					'data-date': day.key,
					'data-count': String(day.count),
					tabindex: '0',
				})
				const title = el('title')
				title.textContent = `${day.key} · ${day.count} 次`
				rect.appendChild(title)
				if (onPick) {
					rect.addEventListener('click', () => onPick(day.key))
					rect.addEventListener('keydown', (event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault()
							onPick(day.key)
						}
					})
				}
				svg.appendChild(rect)
			})
		})

		container.appendChild(svg)

		// 图例（少 → 多）+ 汇总。安卓端的色块语义也要有一句人话解释。
		const legend = document.createElement('div')
		legend.className = 'heatmap__legend'
		const hint = document.createElement('span')
		hint.className = 'muted'
		hint.dataset.testid = 'heatmap-summary'
		hint.textContent = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')} 至今 · 共 ${total} 次播放`
		legend.appendChild(hint)

		const scale = document.createElement('span')
		scale.className = 'heatmap__scale'
		const less = document.createElement('span')
		less.className = 'muted'
		less.textContent = '少'
		scale.appendChild(less)
		for (const level of [0, 1, 2, 3, 4]) {
			const box = document.createElement('span')
			box.className = `heatmap__swatch${level > 0 ? ` heatmap__cell--l${level}` : ''}`
			scale.appendChild(box)
		}
		const more = document.createElement('span')
		more.className = 'muted'
		more.textContent = '多'
		scale.appendChild(more)
		legend.appendChild(scale)
		container.appendChild(legend)

		return { weeks: weeks.length, total, cell }
	}

	window.bbHeatmap = { render, buildGrid, levelOf, dateKey }
})()
