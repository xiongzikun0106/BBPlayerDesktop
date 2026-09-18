/**
 * 外部歌单导入视图（Phase 3.3）。
 *
 * ## 交互设计：为什么是「先匹配、再逐条确认」
 *
 * B 站搜索对中文歌名的召回很不稳（翻唱、伴奏、鬼畜、纯音乐版混在一起），
 * 而**自动匹配错的代价很高** —— 用户点开歌单听到一半是伴奏，还不如让他
 * 在导入前花一分钟扫一遍。所以流程是：
 *
 *   1. 粘贴歌单链接 / id → 拉取曲目列表
 *   2. 逐首匹配（**串行**，带进度；B 站搜索对突发请求敏感）
 *   3. 结果分三档展示：`auto`（默认勾选）/ `review`（列候选，让人选）/
 *      `unmatched`（默认不勾选，可以手工填 BV 号）
 *   4. 用户确认后一次落库
 *
 * ## 匹配为什么在渲染进程驱动循环
 *
 * 每首一次 IPC（而不是「一次调用整批」）：进度是天然的、可中断的，
 * 而且不需要额外的推送通道（少一条通道就少一处状态同步）。
 */
;(function () {
	'use strict'

	const els = {
		content: document.getElementById('content'),
		status: document.getElementById('status'),
	}

	const setStatus = (text, kind) => {
		if (!els.status) return
		els.status.textContent = text
		els.status.className = `status status--${kind || 'idle'}`
	}

	function unwrap(result, what) {
		if (!result || result.ok !== true) {
			throw new Error(`${what}失败：${result?.error ?? '未知错误'}`)
		}
		return result.data
	}

	// ---------------------------------------------------------------
	// 状态
	// ---------------------------------------------------------------

	/**
	 * 会话状态。
	 *
	 * `rows` 的每一项在匹配后被就地更新（`match` 字段），这样重绘不会
	 * 丢掉已经匹配好的结果。
	 */
	const state = {
		playlist: null,
		rows: [],
		/** 匹配进度 */
		matching: false,
		matchDone: 0,
		/** 用户手工改过的 bvid：index -> bvid */
		overrides: new Map(),
		/** 取消匹配用的标记 */
		abort: false,
	}

	/** 用户「导入」时会带上哪些行：勾选 + 已改过的 */
	const selected = new Set()

	// ---------------------------------------------------------------
	// 渲染
	// ---------------------------------------------------------------

	const STATUS_LABEL = {
		auto: { text: '自动匹配', kind: 'ok' },
		review: { text: '待确认', kind: 'warn' },
		unmatched: { text: '未匹配', kind: 'bad' },
		pending: { text: '待匹配', kind: '' },
		matching: { text: '匹配中…', kind: 'busy' },
	}

	function render() {
		const content = els.content
		if (!content) return
		content.textContent = ''

		const head = document.createElement('div')
		head.className = 'view-head'
		const h2 = document.createElement('h2')
		h2.textContent = '导入外部歌单'
		head.appendChild(h2)
		if (state.playlist) {
			const meta = document.createElement('span')
			meta.className = 'muted'
			meta.dataset.testid = 'import-summary'
			meta.textContent =
				`${state.playlist.name} · ${state.rows.length} 首` +
				(state.playlist.total !== state.rows.length
					? `（远端声明 ${state.playlist.total} 首）`
					: '')
			head.appendChild(meta)
		}
		content.appendChild(head)

		renderForm(content)
		if (state.rows.length > 0) renderResults(content)
	}

	/** 输入区：歌单链接/id + 拉取按钮 */
	function renderForm(container) {
		const form = document.createElement('div')
		form.className = 'import-form'

		const label = document.createElement('label')
		label.className = 'muted'
		label.textContent = '网易云歌单链接或 id'
		form.appendChild(label)

		const input = document.createElement('input')
		input.id = 'import-input'
		input.dataset.testid = 'import-input'
		input.type = 'text'
		input.spellcheck = false
		input.placeholder = 'https://music.163.com/playlist?id=3778678 或 3778678'
		if (state.playlist) input.value = state.playlist.playlistId
		form.appendChild(input)

		const actions = document.createElement('div')
		actions.className = 'row-actions'

		const fetchButton = document.createElement('button')
		fetchButton.dataset.testid = 'import-fetch'
		fetchButton.textContent = '拉取歌单'
		fetchButton.disabled = state.matching
		fetchButton.addEventListener('click', () => void fetchAndMatch())
		actions.appendChild(fetchButton)

		const demo = document.createElement('button')
		demo.dataset.testid = 'import-demo'
		demo.textContent = '用示例（热歌榜）'
		demo.disabled = state.matching
		demo.addEventListener('click', () => {
			if (input) input.value = '3778678'
			void fetchAndMatch()
		})
		actions.appendChild(demo)

		if (state.matching) {
			const cancel = document.createElement('button')
			cancel.dataset.testid = 'import-cancel-match'
			cancel.textContent = '停止匹配'
			cancel.addEventListener('click', () => {
				state.abort = true
			})
			actions.appendChild(cancel)
		}

		form.appendChild(actions)

		const hint = document.createElement('p')
		hint.className = 'muted settings-hint'
		// ⚠️ 只说用户能观察到的事（"逐首、要几分钟"），
		// 不说我们的请求策略（串行 / 限流）—— 那是实现细节。
		hint.textContent =
			'会逐首在 B 站搜索匹配，可能要几分钟。' +
			'「待确认」的条目会列出候选让你选；「未匹配」的可以手工填 BV 号。'
		form.appendChild(hint)

		container.appendChild(form)
	}

	/** 结果区：汇总 + 逐条表格 + 导入按钮 */
	function renderResults(container) {
		const counts = { auto: 0, review: 0, unmatched: 0, pending: 0, matching: 0 }
		for (const row of state.rows) {
			const status =
				row.match?.status ?? (state.matching ? 'matching' : 'pending')
			counts[status] = (counts[status] ?? 0) + 1
		}

		const progress = document.createElement('div')
		progress.className = 'import-progress'
		progress.dataset.testid = 'import-progress'
		progress.textContent =
			`已匹配 ${state.matchDone}/${state.rows.length} · ` +
			`自动 ${counts.auto} · 待确认 ${counts.review} · 未匹配 ${counts.unmatched}` +
			(counts.pending + counts.matching > 0
				? ` · 待匹配 ${counts.pending + counts.matching}`
				: '')
		container.appendChild(progress)

		const actions = document.createElement('div')
		actions.className = 'row-actions'

		const selectAuto = document.createElement('button')
		selectAuto.dataset.testid = 'import-select-auto'
		selectAuto.textContent = '只选自动匹配'
		selectAuto.addEventListener('click', () => {
			selected.clear()
			state.rows.forEach((row, index) => {
				if (row.match?.status === 'auto') selected.add(index)
			})
			render()
		})
		actions.appendChild(selectAuto)

		const selectAll = document.createElement('button')
		selectAll.dataset.testid = 'import-select-all'
		selectAll.textContent = '全选已匹配'
		selectAll.addEventListener('click', () => {
			selected.clear()
			state.rows.forEach((row, index) => {
				if (resolvedBvid(row)) selected.add(index)
			})
			render()
		})
		actions.appendChild(selectAll)

		const startButton = document.createElement('button')
		startButton.dataset.testid = 'import-start'
		startButton.textContent = `导入选中的 ${selected.size} 首`
		startButton.disabled = selected.size === 0 || state.matching
		startButton.addEventListener('click', () => void startImport())
		actions.appendChild(startButton)

		container.appendChild(actions)

		// 表格
		const table = document.createElement('table')
		table.className = 'track-table import-table'
		table.dataset.testid = 'import-table'

		const thead = document.createElement('thead')
		const headRow = document.createElement('tr')
		for (const [text, cls] of [
			['选', 'col-pick'],
			['#', 'col-index'],
			['远端曲目', 'col-title'],
			['匹配结果', 'col-match'],
			['状态', 'col-status'],
		]) {
			const th = document.createElement('th')
			th.className = cls
			th.textContent = text
			headRow.appendChild(th)
		}
		thead.appendChild(headRow)
		table.appendChild(thead)

		const tbody = document.createElement('tbody')
		state.rows.forEach((row, index) => {
			const tr = document.createElement('tr')
			tr.dataset.testid = `import-row-${index}`
			const status =
				row.match?.status ?? (state.matching ? 'matching' : 'pending')
			tr.dataset.status = status
			tr.dataset.selected = String(selected.has(index))

			// 勾选框
			const pickCell = document.createElement('td')
			pickCell.className = 'col-pick'
			const checkbox = document.createElement('input')
			checkbox.type = 'checkbox'
			checkbox.dataset.testid = `import-pick-${index}`
			checkbox.checked = selected.has(index)
			checkbox.addEventListener('change', () => {
				if (checkbox.checked) selected.add(index)
				else selected.delete(index)
				render()
			})
			pickCell.appendChild(checkbox)
			tr.appendChild(pickCell)

			// 序号
			const indexCell = document.createElement('td')
			indexCell.className = 'col-index'
			indexCell.textContent = String(index + 1)
			tr.appendChild(indexCell)

			// 远端曲目
			const titleCell = document.createElement('td')
			titleCell.className = 'col-title'
			titleCell.textContent = `${row.title}${row.artist ? ` — ${row.artist}` : ''}`
			titleCell.title = titleCell.textContent
			tr.appendChild(titleCell)

			// 匹配结果
			const matchCell = document.createElement('td')
			matchCell.className = 'col-match'

			const bvid = resolvedBvid(row)
			if (row.manualBvid) {
				// 用户手工指定
				const tag = document.createElement('span')
				tag.className = 'import-manual'
				tag.textContent = `手工: ${bvid}`
				matchCell.appendChild(tag)
			} else if (row.match?.best) {
				const text = document.createElement('span')
				text.textContent = row.match.best.title
				text.title =
					`${row.match.best.title}\n分数 ${row.match.best.score.toFixed(3)}` +
					`（标题 ${row.match.best.titleScore.toFixed(2)} / 歌手 ${row.match.best.artistScore.toFixed(2)} / 时长 ${row.match.best.durationScore.toFixed(2)}）` +
					(row.match.best.penalties?.length
						? `\n已因「${row.match.best.penalties.join('/')}」降权`
						: '')
				matchCell.appendChild(text)

				// 候选下拉：只在「待确认/未匹配」时给，自动匹配的不打扰用户
				if (status !== 'auto' && row.match.candidates.length > 1) {
					const select = document.createElement('select')
					select.dataset.testid = `import-candidates-${index}`
					select.addEventListener('change', () => {
						const chosen = row.match.candidates.find(
							(candidate) => candidate.bvid === select.value,
						)
						if (chosen) {
							row.match.best = chosen
							row.match.status = 'review'
							selected.add(index)
						}
						render()
					})
					for (const candidate of row.match.candidates) {
						const option = document.createElement('option')
						option.value = candidate.bvid
						option.textContent = `${candidate.title.slice(0, 40)} (${candidate.score.toFixed(2)})`
						option.selected = candidate.bvid === row.match.best.bvid
						select.appendChild(option)
					}
					matchCell.appendChild(select)
				}
			} else {
				// 未匹配：给一个手工填 BV 号的入口
				const manualInput = document.createElement('input')
				manualInput.dataset.testid = `import-manual-${index}`
				manualInput.type = 'text'
				manualInput.placeholder = '手工填 BV 号'
				manualInput.spellcheck = false
				manualInput.value = row.manualBvid ?? ''
				manualInput.addEventListener('change', () => {
					const value = manualInput.value.trim()
					row.manualBvid = value || null
					if (value) selected.add(index)
					else selected.delete(index)
					render()
				})
				matchCell.appendChild(manualInput)
			}
			tr.appendChild(matchCell)

			// 状态
			const statusCell = document.createElement('td')
			statusCell.className = 'col-status'
			const info = STATUS_LABEL[status] ?? STATUS_LABEL.pending
			statusCell.textContent = info.text
			if (info.kind) statusCell.classList.add(`import-status--${info.kind}`)
			if (row.match?.best) {
				statusCell.title = `分数 ${row.match.best.score.toFixed(3)}`
			}
			tr.appendChild(statusCell)

			// 点击行切换选中（除了点在输入控件上）
			tr.addEventListener('click', (event) => {
				if (event.target.closest('input, select')) return
				if (selected.has(index)) selected.delete(index)
				else if (resolvedBvid(row)) selected.add(index)
				else return
				render()
			})

			tbody.appendChild(tr)
		})
		table.appendChild(tbody)
		container.appendChild(table)
	}

	/** 该行最终要用哪个 bvid（手工优先） */
	function resolvedBvid(row) {
		if (row.manualBvid) return row.manualBvid
		return row.match?.best?.bvid ?? null
	}

	// ---------------------------------------------------------------
	// 流程
	// ---------------------------------------------------------------

	async function fetchAndMatch() {
		const input = document.getElementById('import-input')
		const value = input?.value?.trim() ?? ''
		if (!value) {
			setStatus('请填写歌单链接或 id', 'bad')
			return
		}

		state.abort = false
		state.playlist = null
		state.rows = []
		state.matchDone = 0
		selected.clear()
		render()

		// 1) 拉歌单
		setStatus('正在拉取歌单…', 'busy')
		let playlist
		try {
			playlist = unwrap(
				await window.bbplayer.externalImport.fetchPlaylist(value),
				'拉取歌单',
			)
		} catch (error) {
			setStatus(error.message, 'bad')
			return
		}

		state.playlist = playlist
		state.rows = playlist.tracks.map((track) => ({
			...track,
			match: null,
			manualBvid: null,
		}))
		render()
		setStatus(
			`已拉取「${playlist.name}」${playlist.tracks.length} 首，开始匹配…`,
			'busy',
		)

		await runMatching()
	}

	/**
	 * 匹配运行序号。
	 *
	 * ⚠️ 必须防并发：匹配是**长时间串行循环**（200 首要几分钟），期间用户
	 * 完全可能再点一次「示例」或「拉取歌单」。若两个循环同时跑：
	 *   * 两边都往 `selected` 里加下标，而 `state.rows` 已被换成新数组 ——
	 *     于是出现**越界下标**（实测 `selectedCount=7` 而 `rowCount=6`）；
	 *   * 界面每首刷新两次，进度数字来回跳；
	 *   * 后完成的那个循环会用旧数据覆盖新结果。
	 *
	 * 每次 `runMatching` 自增，循环里每轮检查；不是当次的就立即退出。
	 * 与 `renderer.js` 的 `lyricsRequestSeq`、`history.js` 的 `refreshSeq`
	 * 是同一个手法（这个仓库里已经是第三次用到它）。
	 */
	let matchingRunId = 0

	/**
	 * 逐首匹配当前 `state.rows`（串行 + 可中断）。
	 *
	 * 单独抽出来是为了让「拉取」与「匹配」可以分开驱动 ——
	 * 自动化需要「拉取一次 → 截断到 N 首 → 只匹配这 N 首」，
	 * 否则每跑一次都要匹配 200 首（几分钟）。
	 */
	async function runMatching() {
		if (state.rows.length === 0) return state

		const runId = ++matchingRunId
		/** 本次运行是否已被更新的一次取代 */
		const superseded = () => runId !== matchingRunId

		// 循环开始前记下本轮的数组引用，之后只操作它 —— 这样即使
		// `state.rows` 被换成新数组，本轮也不会往新数组的下标空间里塞东西
		const rows = state.rows

		state.abort = false
		state.matchDone = 0
		state.matching = true
		selected.clear()
		render()

		for (const [index, row] of rows.entries()) {
			if (state.abort || superseded()) break
			try {
				row.match = unwrap(
					await window.bbplayer.externalImport.matchTrack({
						title: row.title,
						artist: row.artist,
						duration: row.duration,
					}),
					`匹配「${row.title}」`,
				)
				// 自动匹配的默认勾选；其余留给用户
				if (row.match.status === 'auto') selected.add(index)
			} catch (error) {
				row.match = {
					status: 'unmatched',
					best: null,
					candidates: [],
					error: error.message,
				}
			}
			if (superseded()) break
			state.matchDone = index + 1
			// 每首刷新一次：用户能看到进度在走（而不是等 200 首一起出来）
			render()
		}

		// 被取代的那一轮**不要**改 `matching` 与状态文案 —— 那是新那轮的职责
		if (superseded()) return state

		state.matching = false
		render()

		if (state.abort) {
			setStatus(`已停止匹配（完成 ${state.matchDone}/${rows.length}）`, 'busy')
		} else {
			setStatus(
				`匹配完成：${rows.length} 首，已默认勾选 ${selected.size} 首自动匹配的`,
				'ok',
			)
		}
		return state
	}

	async function startImport() {
		const items = []
		for (const index of [...selected].sort((a, b) => a - b)) {
			const row = state.rows[index]
			const bvid = resolvedBvid(row)
			if (!bvid) continue
			items.push({
				title: row.title,
				artist: row.artist,
				duration: row.duration,
				cover: row.match?.best?.cover ?? null,
				bvid,
			})
		}
		if (items.length === 0) {
			setStatus('没有可导入的曲目', 'bad')
			return
		}

		setStatus(`正在导入 ${items.length} 首（逐个取 cid）…`, 'busy')
		try {
			const data = unwrap(
				await window.bbplayer.externalImport.start({
					title: state.playlist?.name ?? '导入歌单',
					remoteId: state.playlist?.playlistId ?? '',
					cover: state.playlist?.cover ?? null,
					source: 'netease',
					items,
				}),
				'导入',
			)
			// ⚠️ 先刷新与跳转，**最后**才写结果文案。
			//
			// `openPlaylist()` 内部会 `setStatus('已加载 N 首')`，所以先写
			// 「已导入 N 首」会被它立刻覆盖 —— 用户永远看不到导入结果
			// （与播放历史「清空」是同一个 bug 模式，探针断言这条文案时抓到）。
			await window.bbLibrary.refreshPlaylists()
			await window.bbLibrary.openPlaylist(data.playlistId)

			const failureNote =
				data.failures.length > 0 ? `，${data.failures.length} 首失败` : ''
			setStatus(
				`已导入「${data.title}」${data.added} 首（跳过 ${data.skipped}）${failureNote}`,
				data.failures.length > 0 ? 'busy' : 'ok',
			)
		} catch (error) {
			setStatus(error.message, 'bad')
		}
	}

	async function show() {
		render()
		return state
	}

	window.bbImport = {
		show,
		fetchAndMatch,
		/** 只匹配当前行（不重新拉取）—— 自动化要「拉一次、截断、再匹配」 */
		runMatching,
		startImport,
		/** 供自动化断言 */
		describe: () => ({
			playlistName: state.playlist?.name ?? null,
			rowCount: state.rows.length,
			matchDone: state.matchDone,
			matching: state.matching,
			selectedCount: selected.size,
			statuses: state.rows.reduce((acc, row) => {
				const status = row.match?.status ?? 'pending'
				acc[status] = (acc[status] ?? 0) + 1
				return acc
			}, {}),
			/** 前几行的匹配结果摘要 */
			sample: state.rows.slice(0, 5).map((row) => ({
				title: row.title,
				artist: row.artist,
				status: row.match?.status ?? null,
				bestTitle: row.match?.best?.title ?? null,
				score: row.match?.best?.score ?? null,
				penalties: row.match?.best?.penalties ?? [],
			})),
		}),
		/** 供自动化：只保留前 N 行（避免探针跑 200 首） */
		limitTo: (count) => {
			if (state.rows.length > count) {
				// ⚠️ 先让可能正在跑的匹配置次失效。
				// 否则那个循环会继续在**旧数组**上跑，并往 `selected` 里加
				// 已经越界的下标（实测 `selectedCount=7` 而 `rowCount=6`）。
				matchingRunId += 1
				state.abort = true
				state.matching = false

				state.rows = state.rows.slice(0, count)
				state.playlist.total = state.rows.length
				// `matchDone` 也必须跟着夹住，否则会出现
				// 「matchDone=200 但 rowCount=6」这种自相矛盾的状态
				state.matchDone = Math.min(state.matchDone, state.rows.length)
				// 已勾选的下标可能越界，清理掉
				for (const index of [...selected]) {
					if (index >= count) selected.delete(index)
				}
			}
			return state.rows.length
		},
	}
})()
