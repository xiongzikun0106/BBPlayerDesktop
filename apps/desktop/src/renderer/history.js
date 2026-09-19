/**
 * 播放历史视图（Phase 3.5）—— 阶段 6d 起它同时是**主页的下半部分**。
 *
 * ## 主页怎么组成（对齐安卓端 `(tabs)/index.tsx`）
 *
 * 安卓端主页是一个滚动区，三个区块：**听歌频率热力图 → 快捷入口 → 近期歌单**，
 * 区块之间 32px、**区块自身不套卡片**（卡片化只发生在单个条目上）。
 * 桌面端的「主页」在阶段 6d 之前**根本不存在**：点它执行的是 `bbHistory.show()`
 * （`renderer.js` 的 openView），也就是说主页被播放历史独占。
 *
 * 现在主页是「热力图 → 快捷入口 → 最近更新 → 播放历史」四块。
 * 播放历史没有被删掉 —— 它是桌面端比移动端**更完整**的一块功能
 * （三个派生视图各自的 SQL 都在 `db.cjs` 里），所以保留为最后一个区块。
 *
 * ⚠️ 「近期歌单」这个标题**故意没照抄**：安卓端那条查的是
 * `ORDER BY updatedAt DESC`，而 `playlists.updatedAt` 只在歌单被**修改**时才动
 * （播放写的是 `play_history`，不碰 `playlists`）——
 * 所以它实际是「最近**修改**过的歌单」。桌面端用「最近更新」+ 一句说明，
 * 不把"最近听过"这件事说成事实。
 *
 * ## 三个页签，不是一张表
 *
 * 「播放历史」在音乐应用里有三种不同的用法，混在一张表里会都不好用：
 *
 * * **继续收听** —— 最近播放过、但**没听完**的曲目。这是最有用的一个：
 *   直接接着上次的位置播。排在第一位。
 * * **最近播放** —— 按每首歌最后一次播的时间倒序（同一首歌只出现一次）。
 * * **最常播放** —— 按会话次数排序，且只统计「有效播放」（≥30 秒），
 *   否则「点开就切」的误触会把排行冲乱。
 *
 * 三者的 SQL 差异在前端表达很别扭，所以都在 `db.cjs` 里算好，
 * 这里只负责渲染与「点了要做什么」。
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

	/** 与其它视图一致的时长格式化（复用播放器的实现，避免两套格式） */
	const formatDuration = (seconds) =>
		window.bbPlayer?.formatTime?.(seconds) ?? `${Math.round(seconds ?? 0)}s`

	/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 */
	function formatRelative(ms) {
		if (!ms) return '—'
		const diff = Date.now() - ms
		if (diff < 60_000) return '刚刚'
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
		const days = Math.floor(diff / 86_400_000)
		if (days < 30) return `${days} 天前`
		return new Date(ms).toLocaleDateString('zh-CN')
	}

	/** 当前选中的页签 */
	let activeTab = 'resume'

	/**
	 * 热力图点中的那一天（`YYYY-MM-DD`）。
	 *
	 * 非空时播放历史那一块显示**那天**的会话，点任意页签即退出该视图
	 * （用户点页签的意思就是"我要看那个视图"，不该还停在那天）。
	 */
	let pickedDate = null

	/**
	 * 刷新序号。
	 *
	 * ⚠️ 必须防并发：点导航（`show()` → `refresh()`）与点页签（也 → `refresh()`）
	 * 会在同一帧里先后触发两次刷新。两者都先 `content.textContent = ''` 再
	 * 追加内容，于是**慢的那次会把表格追加到快的那次之后**，界面上出现两张
	 * 表（探针读表头时读到重复的两组列，才发现这个问题）。
	 *
	 * 与 `renderer.js` 里歌词加载用的 `lyricsRequestSeq` 是同一个手法：
	 * 每次刷新自增，回来时若序号已变就丢弃结果。
	 */
	let refreshSeq = 0

	const TABS = [
		{ key: 'resume', label: '继续收听' },
		{ key: 'recent', label: '最近播放' },
		{ key: 'most', label: '最常播放' },
	]

	/**
	 * 把一行历史记录变成播放器能播的曲目对象。
	 *
	 * `bvid` 必须存在 —— 播放器靠它解析音频；历史里的曲目来自 `tracks`
	 * 表，而 `bilibili_metadata` 可能没有对应行（理论上不该，但外键允许
	 * `bvid` 为空）。缺了就跳过，不要渲染出点了没反应的行。
	 */
	function toTrack(row) {
		if (!row.bvid) return null
		return {
			bvid: row.bvid,
			title: row.title,
			artist: row.artist_name ?? null,
			duration: row.duration,
			cover: row.cover_url,
			// 「继续收听」带上上次的位置，双击时用它 seek
			resumeAt: row.last_position_seconds ?? null,
		}
	}

	// ---------------------------------------------------------------
	// 渲染
	// ---------------------------------------------------------------

	function renderTabs(container) {
		const tabs = document.createElement('div')
		tabs.className = 'tabs tabs--sub'
		tabs.dataset.testid = 'history-tabs'
		for (const tab of TABS) {
			const button = document.createElement('button')
			button.className = `tab${tab.key === activeTab ? ' is-active' : ''}`
			button.dataset.historyTab = tab.key
			button.dataset.testid = `history-tab-${tab.key}`
			button.textContent = tab.label
			button.addEventListener('click', () => {
				// 点页签 = 退出"某一天"的视图（见 pickedDate 的注释）
				pickedDate = null
				activeTab = tab.key
				void refresh()
			})
			tabs.appendChild(button)
		}
		container.appendChild(tabs)
	}

	function renderTable(container, rows, { showCount, showPosition }) {
		const tracks = rows.map(toTrack).filter(Boolean)
		if (tracks.length === 0) {
			container.appendChild(
				window.bbComponents.empty({
					testid: 'history-empty',
					iconName: activeTab === 'resume' ? 'play_circle' : 'history',
					title: activeTab === 'resume' ? '没有未听完的曲目' : '还没有播放记录',
					hint:
						activeTab === 'resume'
							? '听到一半切走的歌会出现在这里，方便接着听。'
							: '播放任意一首歌之后，这里会记下你听了什么。',
				}),
			)
			return
		}

		const actions = document.createElement('div')
		actions.className = 'row-actions'
		const playAll = document.createElement('button')
		playAll.dataset.testid = 'history-play-all'
		playAll.innerHTML = '<span class="icon icon--sm">play_arrow</span> 播放全部'
		playAll.addEventListener('click', () => {
			window.bbPlayer.setQueue(tracks, 0)
			window.bbPlayer.playAt(0)
			void window.bbPlayer.play()
		})
		actions.appendChild(playAll)
		container.appendChild(actions)

		const table = document.createElement('table')
		table.className = 'track-table'
		table.dataset.testid = 'history-table'

		const thead = document.createElement('thead')
		const headRow = document.createElement('tr')
		const columns = [
			['#', 'col-index'],
			['标题', 'col-title'],
			['作者', 'col-artist'],
			showCount ? ['播放次数', 'col-count'] : null,
			showPosition ? ['上次听到', 'col-position'] : null,
			['时长', 'col-duration'],
			['最近播放', 'col-when'],
		].filter(Boolean)
		for (const [label, cls] of columns) {
			const th = document.createElement('th')
			th.className = cls
			th.textContent = label
			headRow.appendChild(th)
		}
		thead.appendChild(headRow)
		table.appendChild(thead)

		const tbody = document.createElement('tbody')
		rows.forEach((row, index) => {
			const track = toTrack(row)
			if (!track) return
			const tr = document.createElement('tr')
			tr.dataset.testid = `history-row-${index}`
			tr.dataset.bvid = track.bvid
			if (window.bbPlayer.getCurrent()?.bvid === track.bvid) {
				tr.classList.add('is-playing')
			}

			const cells = [
				[String(index + 1), 'col-index'],
				[track.title || '(无标题)', 'col-title'],
				[track.artist || '—', 'col-artist'],
				showCount ? [String(row.play_count ?? 0), 'col-count'] : null,
				showPosition
					? [formatDuration(row.last_position_seconds), 'col-position']
					: null,
				[formatDuration(track.duration), 'col-duration'],
				[formatRelative(row.last_played_at), 'col-when'],
			].filter(Boolean)

			for (const [text, cls] of cells) {
				const td = document.createElement('td')
				td.className = cls
				td.textContent = text
				td.title = text
				tr.appendChild(td)
			}

			tr.addEventListener('dblclick', () => {
				const queueIndex = tracks.indexOf(track)
				window.bbPlayer.setQueue(tracks, queueIndex)
				window.bbPlayer.playAt(queueIndex)
				// 「继续收听」要从上次的位置接着播
				if (track.resumeAt && track.resumeAt > 5) {
					// seek 必须在元数据就绪后才有意义；播放器会在 loadedmetadata 后
					// 应用 pendingSeek（见 player.js），所以这里直接调即可
					window.bbPlayer.seekTo(track.resumeAt)
				}
				void window.bbPlayer.play()
			})
			tr.addEventListener('click', () => {
				for (const other of tbody.querySelectorAll('tr')) {
					other.classList.remove('is-selected')
				}
				tr.classList.add('is-selected')
			})

			tbody.appendChild(tr)
		})
		table.appendChild(tbody)
		container.appendChild(table)
	}

	// ---------------------------------------------------------------
	// 主页的区块（阶段 6d）
	// ---------------------------------------------------------------

	/** 一个主页区块：标题 +（可选）说明 + 内容 */
	function homeSection(title, { hint, testid } = {}) {
		const section = document.createElement('section')
		section.className = 'home-section'
		if (testid) section.dataset.testid = testid
		const h3 = document.createElement('h2')
		h3.className = 'home-section__title'
		h3.textContent = title
		section.appendChild(h3)
		if (hint) {
			const note = document.createElement('p')
			note.className = 'home-section__hint'
			note.textContent = hint
			section.appendChild(note)
		}
		return section
	}

	/** 区块 1：听歌频率热力图（主题色） */
	function renderHeatmapSection() {
		const section = homeSection('听歌频率', {
			testid: 'home-heatmap',
			hint: '最近一年每天听了几次。点一格可以看那一天的记录。',
		})
		const box = document.createElement('div')
		box.className = 'heatmap-box'
		box.dataset.testid = 'heatmap-box'
		section.appendChild(box)

		// 数据要等 IPC，先把网格画出来（**有数据/没数据都画**，
		// 新用户看到的是一整片灰格子而不是空白 —— 与移动端一致）
		const draw = (byDate) => {
			window.bbHeatmap?.render(box, byDate ?? {}, {
				onPick: (date) => {
					// 与移动端同一个动作：点某天 → 看那天听了什么
					pickedDate = date
					void refresh()
				},
			})
		}
		/*
		 * ⚠️ 占位那一版必须**同步**画，不能放进 `requestAnimationFrame`。
		 *
		 * 第一版就是这么写的：`rAF(() => draw({}))` + IPC 的 `.then(draw(真实数据))`。
		 * 本地 SQLite 的 IPC 往往**比一帧还快**，于是真实数据先画上去，
		 * 一帧之后那个"空网格"再覆盖它 —— 表现是**数据已经到了、格子却全灰**
		 * （`history.heatmap()` 明明返回了 `{ '2026-09-19': 6 }`，界面上一个
		 * 非空档都没有）。是那条"数据真的走通 IPC 且界面上出现非空档"的断言抓到的。
		 *
		 * 代价：这一刻盒子可能还没挂进 `#content`，`clientWidth` 是 0，
		 * 格子会按兜底宽度算 —— 所以下面拿到真实数据时**再量一次**即可
		 * （宽度与数据都在这一版里修正）。
		 */
		draw({})
		window.bbplayer.history
			.heatmap()
			.then((result) => {
				if (result?.ok === true) draw(result.data ?? {})
			})
			.catch(() => {
				// 热力图拿不到数据不影响主页其它区块
			})
		return section
	}

	/** 区块 2：快捷入口（安卓端三张卡：那月今日 / 最近常听 / 稍后再看） */
	function renderQuickAccess() {
		const section = homeSection('快捷入口', { testid: 'home-quick' })
		const grid = document.createElement('div')
		grid.className = 'home-quick'
		section.appendChild(grid)

		/*
		 * ⚠️ 桌面端没有「稍后再看」（那是 B 站账号侧的列表，桌面端未接入），
		 * 所以第三张换成本地真实存在的入口，而不是摆一个点了没用的卡。
		 */
		const cards = [
			{
				testid: 'quick-recent',
				icon: 'history',
				label: '最近常听',
				run: () => gotoTab('recent'),
			},
			{
				testid: 'quick-resume',
				icon: 'play_circle',
				label: '继续收听',
				run: () => gotoTab('resume'),
			},
			{
				testid: 'quick-favorites',
				icon: 'star',
				label: '我的收藏夹',
				run: () => window.bbUI?.setLibraryTab?.('favorites'),
			},
		]
		for (const card of cards) {
			const button = document.createElement('button')
			button.className = 'home-quick__card'
			button.dataset.testid = card.testid
			const iconBox = document.createElement('span')
			iconBox.className = 'home-quick__icon'
			iconBox.appendChild(window.bbComponents.icon(card.icon))
			button.appendChild(iconBox)
			const label = document.createElement('span')
			label.className = 'home-quick__label'
			label.textContent = card.label
			button.appendChild(label)
			button.addEventListener('click', () => card.run())
			grid.appendChild(button)
		}
		return section
	}

	/** 切换历史子页签并把那一块滚进视野（快捷入口用） */
	async function gotoTab(key) {
		activeTab = key
		await refresh()
		document
			.querySelector('[data-testid="history-tabs"]')
			?.scrollIntoView({ block: 'start', behavior: 'smooth' })
	}

	/**
	 * 区块 3：最近更新（歌单）。
	 *
	 * 安卓端的「近期歌单」卡：`surfaceVariant` 底 + 1:1 封面 + 标题两行 + 「N 首」。
	 * 桌面端用的是**同一张卡**（`bbComponents.mediaCard`），
	 * 与音乐库 › 播放列表的卡片网格同源。
	 */
	async function renderRecentPlaylists(content) {
		const section = homeSection('最近更新', {
			testid: 'home-recent-playlists',
			hint: '按歌单最近一次修改排序（不是最近听过）。',
		})
		const grid = document.createElement('div')
		grid.className = 'media-grid'
		// ⚠️ 容器与子项的 testid **不能共享前缀**：卡片是 `home-playlist-<id>`，
		// 若容器也叫 `home-playlist-grid`，那么 `[data-testid^="home-playlist-"]`
		// 会先命中**容器**（DOM 顺序在前）—— 探针点它会点在一个没有监听器的
		// div 上（什么都发生不了），而读标题却能读到第一张卡的内容，
		// 于是表现为"功能坏了"（实际是选择器选错了对象）。
		grid.dataset.testid = 'home-recent-grid'
		section.appendChild(grid)

		let playlists = []
		try {
			const result = await window.bbplayer.listPlaylists()
			playlists = (result?.data ?? [])
				.filter((item) => item.type !== 'dynamic')
				.slice()
				.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
				.slice(0, 6)
		} catch {
			playlists = []
		}

		if (playlists.length === 0) {
			grid.appendChild(
				window.bbComponents.empty({
					testid: 'home-playlists-empty',
					iconName: 'library_music',
					title: '还没有歌单',
					hint: '去音乐库 › 播放列表新建一个，或从合集导入。',
				}),
			)
			content.appendChild(section)
			return
		}

		for (const playlist of playlists) {
			grid.appendChild(
				window.bbComponents.mediaCard({
					title: playlist.title,
					sub: `${playlist.item_count ?? 0} 首`,
					coverUrl: playlist.cover_url ?? null,
					badges: window.bbLibrary?.playlistBadges?.(playlist) ?? [],
					testid: `home-playlist-${playlist.id}`,
					onClick: () => {
						// 与音乐库里的卡片同一条路径：进歌单详情
						window.bbUI?.showContent?.()
						void window.bbLibrary?.openPlaylist?.(playlist.id)
					},
				}),
			)
		}
		content.appendChild(section)
	}

	// ---------------------------------------------------------------
	// 加载
	// ---------------------------------------------------------------

	async function refresh() {
		const content = els.content
		if (!content) return
		const seq = ++refreshSeq
		content.textContent = ''
		setStatus('读取播放历史…', 'busy')

		/** 每次 await 之后都要重新检查序号，避免把过期结果画上去 */
		const stale = () => seq !== refreshSeq

		try {
			const summary = unwrap(
				await window.bbplayer.history.summary(),
				'读取历史汇总',
			)
			if (stale()) return null

			// 读数据也在渲染之前完成 —— 否则「先画表头、再补数据」会在
			// 并发时留下半张表
			let rows = []
			let options = { showCount: false, showPosition: false }
			const tab = activeTab
			if (pickedDate) {
				// 热力图点进来的"某一天"：按**会话**列出（同一天听两遍就是两行），
				// 这样格子里的数字与表里的行数对得上
				rows = unwrap(
					await window.bbplayer.history.byDate(pickedDate, 200),
					'读取当天记录',
				)
				options = { showCount: false, showPosition: false }
			} else if (tab === 'resume') {
				rows = unwrap(await window.bbplayer.history.resume(50), '读取继续收听')
				options = { showCount: false, showPosition: true }
			} else if (tab === 'recent') {
				rows = unwrap(await window.bbplayer.history.recent(100), '读取最近播放')
				options = { showCount: true, showPosition: false }
			} else {
				rows = unwrap(
					await window.bbplayer.history.mostPlayed(100),
					'读取最常播放',
				)
				options = { showCount: true, showPosition: false }
			}
			if (stale()) return null

			const head = document.createElement('div')
			head.className = 'view-head'
			const h2 = document.createElement('h2')
			// ⚠️ 主页的第一个 `.view-head` 是**播放历史**（它在页面下半部分）。
			// 主页自己的标题由外壳的 `#page-title` 负责（「主页」）——
			// 见 README 的「标题只有一处」。
			h2.textContent = pickedDate ? `播放历史 · ${pickedDate}` : '播放历史'
			head.appendChild(h2)
			const meta = document.createElement('span')
			meta.className = 'muted'
			meta.dataset.testid = 'history-summary'
			meta.textContent = pickedDate
				? `${rows.length} 次播放`
				: summary.sessionCount === 0
					? '暂无记录'
					: `${summary.trackCount} 首 · ${summary.sessionCount} 次播放 · 累计 ${Math.round(summary.totalSeconds / 60)} 分钟`
			head.appendChild(meta)
			// 主页的四个区块顺序：热力图 → 快捷入口 → 最近更新 → 播放历史
			content.appendChild(renderHeatmapSection())
			content.appendChild(renderQuickAccess())
			await renderRecentPlaylists(content)
			if (stale()) return null
			content.appendChild(head)

			renderTabs(content)
			renderTable(content, rows, options)

			// 清空按钮（放在最后，避免误点）
			if (summary.sessionCount > 0) {
				const danger = document.createElement('div')
				danger.className = 'row-actions row-actions--end'
				const clear = document.createElement('button')
				clear.dataset.testid = 'history-clear'
				clear.textContent = '清空播放历史'
				clear.addEventListener(
					'click',
					() => void clearHistory(summary.sessionCount),
				)
				danger.appendChild(clear)
				content.appendChild(danger)
			}

			setStatus(`已加载 ${rows.length} 条`, 'ok')
			return { summary, rows }
		} catch (error) {
			if (stale()) return null
			setStatus(error.message, 'bad')
			return null
		}
	}

	async function clearHistory(count) {
		// 二次确认：清空是不可逆的
		const confirmed = window.confirm(
			`确定清空播放历史吗？\n\n将删除 ${count} 条播放记录。曲目与歌单不受影响。`,
		)
		if (!confirmed) return false
		try {
			const data = unwrap(await window.bbplayer.history.clear(), '清空播放历史')
			// ⚠️ 先 refresh 再写状态文案。
			// 反过来的话 `refresh()` 结尾的 `setStatus('已加载 N 条')` 会把
			// 「已清空 N 条」立刻覆盖掉，用户永远看不到清空的结果
			// （探针断言这条文案时抓到）。
			await refresh()
			setStatus(`已清空 ${data.removed} 条播放记录`, 'ok')
			return true
		} catch (error) {
			setStatus(error.message, 'bad')
			return false
		}
	}

	async function show() {
		activeTab = 'resume'
		return await refresh()
	}

	window.bbHistory = {
		show,
		refresh,
		clearHistory,
		/** 供自动化断言 */
		getActiveTab: () => activeTab,
		setActiveTab: (tab) => {
			activeTab = tab
		},
		/** 供自动化：直接读表格里的行数 */
		getRowCount: () =>
			document.querySelectorAll('[data-testid="history-table"] tbody tr')
				.length,
	}
})()
