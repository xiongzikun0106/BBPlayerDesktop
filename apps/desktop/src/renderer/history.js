/**
 * 播放历史视图（Phase 3.5）。
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
			const empty = document.createElement('p')
			empty.className = 'empty muted'
			empty.dataset.testid = 'history-empty'
			empty.textContent =
				activeTab === 'resume'
					? '没有未听完的曲目。播放一些歌之后再回来看。'
					: '还没有播放记录。'
			container.appendChild(empty)
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
			if (tab === 'resume') {
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
			h2.textContent = '播放历史'
			head.appendChild(h2)
			const meta = document.createElement('span')
			meta.className = 'muted'
			meta.dataset.testid = 'history-summary'
			meta.textContent =
				summary.sessionCount === 0
					? '暂无记录'
					: `${summary.trackCount} 首 · ${summary.sessionCount} 次播放 · 累计 ${Math.round(summary.totalSeconds / 60)} 分钟`
			head.appendChild(meta)
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
