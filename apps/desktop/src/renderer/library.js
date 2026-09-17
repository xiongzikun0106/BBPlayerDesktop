/**
 * 视图渲染：左栏歌单列表 + 中栏曲目表 + 右栏队列。
 *
 * 全部用原生 DOM，不引框架 —— 桌面端 UI 的重写成本主要在这里，保持轻量。
 * 只负责渲染与交互，数据获取统一走 `window.bbplayer`（preload 暴露的 IPC）。
 */
;(function () {
	'use strict'

	const els = {
		content: document.getElementById('content'),
		playlistList: document.getElementById('playlist-list'),
		playlistCount: document.getElementById('playlist-count'),
		searchInput: document.getElementById('search-input'),
		searchButton: document.getElementById('search-button'),
		status: document.getElementById('status'),
	}

	const setStatus = (text, kind) => {
		if (!els.status) return
		els.status.textContent = text
		els.status.className = `status status--${kind || 'idle'}`
	}

	const clear = (node) => {
		if (node) node.textContent = ''
	}

	/** 统一的响应解包：主进程返回 { ok, data } 或 { ok:false, error } */
	function unwrap(result, what) {
		if (!result || result.ok !== true) {
			throw new Error(`${what}失败：${result?.error ?? '未知错误'}`)
		}
		return result.data
	}

	// ---------------------------------------------------------------
	// 左栏
	// ---------------------------------------------------------------

	function renderPlaylists(playlists, selectedId) {
		clear(els.playlistList)
		if (els.playlistCount)
			els.playlistCount.textContent = String(playlists.length)

		for (const playlist of playlists) {
			const li = document.createElement('li')
			li.className = 'playlist-list__item'
			if (playlist.id === selectedId) li.classList.add('is-active')
			li.dataset.playlistId = String(playlist.id)
			li.dataset.testid = `playlist-${playlist.id}`

			const name = document.createElement('span')
			name.className = 'playlist-list__name'
			name.textContent = playlist.title
			li.appendChild(name)

			const count = document.createElement('span')
			count.className = 'muted mono'
			count.textContent = String(playlist.item_count ?? 0)
			li.appendChild(count)

			li.addEventListener('click', () => {
				void openPlaylist(playlist.id)
			})
			els.playlistList.appendChild(li)
		}
	}

	// ---------------------------------------------------------------
	// 中栏：曲目表
	// ---------------------------------------------------------------

	function renderTrackTable(tracks, { title, query } = {}) {
		clear(els.content)

		const head = document.createElement('div')
		head.className = 'view-head'
		const h2 = document.createElement('h2')
		h2.textContent = title || '音乐库'
		head.appendChild(h2)

		const meta = document.createElement('span')
		meta.className = 'muted'
		meta.textContent = `${tracks.length} 首`
		head.appendChild(meta)
		els.content.appendChild(head)

		if (tracks.length === 0) {
			const empty = document.createElement('p')
			empty.className = 'empty muted'
			empty.dataset.testid = 'content-empty'
			empty.textContent = query
				? `没有与「${query}」相关的结果`
				: '这里还没有内容。用上方搜索框试试，或从左栏选择歌单。'
			els.content.appendChild(empty)
			return
		}

		// 批量操作
		const actions = document.createElement('div')
		actions.className = 'row-actions'
		const playAll = document.createElement('button')
		playAll.dataset.testid = 'btn-play-all'
		playAll.textContent = '▶ 播放全部'
		playAll.addEventListener('click', () => {
			// ⚠️ 必须显式 playAt(0)：`setQueue` 只设置队列，不会载入曲目；
			// 直接 play() 对空 src 的 <audio> 是静默 no-op（实测踩过）。
			window.bbPlayer.setQueue(tracks, 0)
			window.bbPlayer.playAt(0)
			void window.bbPlayer.play()
		})
		actions.appendChild(playAll)

		const queueAll = document.createElement('button')
		queueAll.dataset.testid = 'btn-queue-all'
		queueAll.textContent = '加入队列'
		queueAll.addEventListener('click', () => {
			const current = window.bbPlayer.getQueue()
			const seen = new Set(current.map((track) => track.bvid))
			const merged = current.concat(
				tracks.filter((track) => !seen.has(track.bvid)),
			)
			window.bbPlayer.setQueue(merged, window.bbPlayer.getIndex())
		})
		actions.appendChild(queueAll)
		els.content.appendChild(actions)

		const table = document.createElement('table')
		table.className = 'track-table'
		table.dataset.testid = 'track-table'

		const thead = document.createElement('thead')
		const headRow = document.createElement('tr')
		for (const [label, cls] of [
			['#', 'col-index'],
			['标题', 'col-title'],
			['作者', 'col-artist'],
			['时长', 'col-duration'],
		]) {
			const th = document.createElement('th')
			th.className = cls
			th.textContent = label
			headRow.appendChild(th)
		}
		thead.appendChild(headRow)
		table.appendChild(thead)

		const tbody = document.createElement('tbody')
		tracks.forEach((track, index) => {
			const tr = document.createElement('tr')
			tr.dataset.testid = `track-row-${index}`
			tr.dataset.bvid = track.bvid
			if (window.bbPlayer.getCurrent()?.bvid === track.bvid) {
				tr.classList.add('is-playing')
			}

			const cells = [
				[String(index + 1), 'col-index'],
				[track.title || '(无标题)', 'col-title'],
				[track.artist || track.artist_name || '—', 'col-artist'],
				[window.bbPlayer.formatTime(track.duration), 'col-duration'],
			]
			for (const [text, cls] of cells) {
				const td = document.createElement('td')
				td.className = cls
				td.textContent = text
				td.title = text
				tr.appendChild(td)
			}

			tr.addEventListener('dblclick', () => {
				window.bbPlayer.setQueue(tracks, index)
				window.bbPlayer.playAt(index)
				void window.bbPlayer.play()
			})
			tr.addEventListener('click', () => {
				// 单击只选中（高亮），双击才播放 —— 桌面上避免误触
				for (const other of tbody.querySelectorAll('tr')) {
					other.classList.remove('is-selected')
				}
				tr.classList.add('is-selected')
			})

			tbody.appendChild(tr)
		})
		table.appendChild(tbody)
		els.content.appendChild(table)
	}

	// ---------------------------------------------------------------
	// 数据加载
	// ---------------------------------------------------------------

	let cachedPlaylists = []

	async function refreshPlaylists() {
		const data = unwrap(await window.bbplayer.listPlaylists(), '读取歌单')
		cachedPlaylists = data
		const selected = window.bbState.get().selectedPlaylistId
		renderPlaylists(data, selected)
		return data
	}

	async function openPlaylist(playlistId) {
		setStatus('读取歌单…', 'busy')
		try {
			const tracks = unwrap(
				await window.bbplayer.getPlaylistTracks(playlistId),
				'读取曲目',
			)
			const playlist = cachedPlaylists.find((item) => item.id === playlistId)
			window.bbState.set({
				view: 'playlist',
				selectedPlaylistId: playlistId,
				tracks,
				title: playlist ? playlist.title : `歌单 #${playlistId}`,
			})
			renderPlaylists(cachedPlaylists, playlistId)
			renderTrackTable(tracks, {
				title: playlist ? playlist.title : `歌单 #${playlistId}`,
			})
			setStatus(`已加载 ${tracks.length} 首`, 'ok')
		} catch (error) {
			setStatus(error.message, 'bad')
		}
	}

	async function runSearch(query) {
		const keyword = (query ?? '').trim()
		if (!keyword) return
		setStatus(`搜索「${keyword}」…`, 'busy')
		try {
			const items = unwrap(await window.bbplayer.search(keyword), '搜索')
			const tracks = items.map((item) => ({
				bvid: item.bvid,
				title: item.title,
				artist: item.author,
				duration: item.duration,
				cover: item.cover,
			}))
			window.bbState.set({
				view: 'search',
				lastQuery: keyword,
				tracks,
				title: `搜索：${keyword}`,
			})
			renderTrackTable(tracks, { title: `搜索：${keyword}`, query: keyword })
			setStatus(`找到 ${tracks.length} 个结果`, 'ok')
		} catch (error) {
			setStatus(error.message, 'bad')
		}
	}

	/**
	 * 空库时的欢迎视图。
	 *
	 * 会比「什么都没有」更有用：给出可立即执行的动作（导入一个公开合集），
	 * 这样能直接看到真实数据流（拉取 -> 落库 -> 播放）。
	 */
	function renderWelcome() {
		clear(els.content)

		const head = document.createElement('div')
		head.className = 'view-head'
		const h2 = document.createElement('h2')
		h2.textContent = '欢迎'
		head.appendChild(h2)
		els.content.appendChild(head)

		const intro = document.createElement('p')
		intro.className = 'muted'
		intro.style.marginBottom = '16px'
		intro.textContent =
			'本地库还是空的。可以搜索并播放，或从 B 站的公开合集导入一个歌单。'
		els.content.appendChild(intro)

		const actions = document.createElement('div')
		actions.className = 'row-actions'

		const seed = document.createElement('button')
		seed.dataset.testid = 'btn-seed-demo'
		seed.textContent = '导入示例合集'
		seed.addEventListener('click', () => void importDemoCollection(seed))
		actions.appendChild(seed)

		const toSearch = document.createElement('button')
		toSearch.dataset.testid = 'btn-goto-search'
		toSearch.textContent = '去搜索'
		toSearch.addEventListener('click', () => {
			document.querySelector('[data-view="search"]')?.click()
		})
		actions.appendChild(toSearch)

		els.content.appendChild(actions)
	}

	/** 示例合集：B 站官方 UP 的公开合集（无需登录即可拉取） */
	const DEMO_MID = 8047632

	async function importDemoCollection(button) {
		button.disabled = true
		const original = button.textContent
		button.textContent = '拉取中…'
		setStatus('正在拉取示例合集…', 'busy')
		try {
			const seasons = unwrap(
				await window.bbplayer.userSeasons(DEMO_MID),
				'读取合集',
			)
			if (seasons.length === 0) throw new Error('该 UP 没有公开合集')

			// 挑一个体量适中的，避免首次导入等太久
			const target =
				seasons.find((item) => item.total >= 5 && item.total <= 40) ??
				seasons[0]

			button.textContent = `导入「${target.title}」…`
			const result = unwrap(
				await window.bbplayer.importSeasonToPlaylist({
					mid: DEMO_MID,
					seasonId: target.seasonId,
					title: target.title,
				}),
				'导入合集',
			)

			await refreshPlaylists()
			await openPlaylist(result.playlistId)
			setStatus(
				`已导入 ${result.added}/${result.total} 首`,
				result.failures.length > 0 ? 'busy' : 'ok',
			)
		} catch (error) {
			setStatus(error.message, 'bad')
			button.disabled = false
			button.textContent = original
		}
	}

	/** 初始化：加载歌单列表并显示欢迎视图 */
	async function init() {
		try {
			const playlists = await refreshPlaylists()
			if (playlists.length > 0) {
				await openPlaylist(playlists[0].id)
			} else {
				renderWelcome()
			}
		} catch (error) {
			setStatus(error.message, 'bad')
		}
	}

	if (els.searchButton) {
		els.searchButton.addEventListener(
			'click',
			() => void runSearch(els.searchInput.value),
		)
	}
	if (els.searchInput) {
		els.searchInput.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') void runSearch(els.searchInput.value)
		})
	}

	window.bbLibrary = {
		init,
		refreshPlaylists,
		openPlaylist,
		runSearch,
		renderTrackTable,
		renderPlaylists,
		renderWelcome,
		importDemoCollection,
		getTracks: () => window.bbState.get().tracks,
	}
})()
