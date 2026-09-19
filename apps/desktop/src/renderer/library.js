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
			// 已共享的歌单按钮显示「同步」：用户的意图是同一个 —— 让云端与本地一致
			//
			// ⚠️ 原来是**文字按钮**（「分享」/「同步」），在 240px 宽的行里吃掉
			// 40 多像素，把歌单名挤成「合集·BILIB…」（§1.5 的第 3 个缺陷）。
			// 改成图标按钮：语义靠图标 + `title`/`aria-label`，把宽度还给标题。
			const shared = Boolean(playlist.share_id)
			const shareButton = document.createElement('button')
			shareButton.className = 'icon-only playlist-list__share'
			shareButton.dataset.testid = `playlist-share-${playlist.id}`
			// `data-action` 比 testid 稳定（testid 里带歌单 id，值每次都可能不同），
			// 探针与未来的快捷键都靠它定位
			shareButton.dataset.action = 'share'
			shareButton.title = shared
				? `已共享（${playlist.share_role ?? '成员'}）· 点一下同步云端改动`
				: '把这个歌单分享到云端（共享歌单）'
			shareButton.setAttribute('aria-label', shared ? '同步到云端' : '分享歌单')
			// 图标形状本身也表达状态：未共享是 share，已共享是 sync
			shareButton.innerHTML = window.bbComponents.iconHtml(
				shared ? 'sync' : 'share',
				'icon--sm',
			)
			shareButton.addEventListener('click', (event) => {
				// 否则会顺带触发行上的「打开歌单」
				event.stopPropagation()
				void sharePlaylist(playlist, shareButton)
			})

			// 用组件层的 `.list-row`（封面/首字方块 + 主标题 + 副标题 + 尾部动作），
			// 不再手搓一套行样式 —— 这正是"同类东西在四个面板里长得都不一样"的根源。
			//
			// 收藏夹没有封面，走**首字 + 渐变底色**（移动端的招牌样式，
			// 也是 BBPlayer 一眼可辨的身份），色相由名字哈希决定、稳定不变。
			//
			// 直接生成 `<li>`（保留列表语义），而不是先建 div 再搬节点。
			const li = window.bbComponents.listRow({
				title: playlist.title,
				sub: `${playlist.item_count ?? 0} 首`,
				coverUrl: playlist.cover_url ?? null,
				trailing: [shareButton],
				tag: 'li',
			})
			if (playlist.id === selectedId) li.classList.add('is-active')
			li.dataset.playlistId = String(playlist.id)
			li.dataset.testid = `playlist-${playlist.id}`
			li.dataset.shared = String(Boolean(playlist.share_id))

			li.addEventListener('click', () => {
				void openPlaylist(playlist.id)
			})
			els.playlistList.appendChild(li)
		}
	}

	/**
	 * 分享成功后的结果块（挂在中栏 #content 的底部）。
	 *
	 * 单独放一块 DOM 而不是只写状态栏：分享链接需要能被**选中复制**，而状态栏
	 * 是一行会被后续操作覆盖的文本。里面的只读输入框同时是剪贴板不可用时的退路。
	 */
	function renderShareResult({
		title,
		link,
		uploaded,
		skipped,
		alreadyShared,
	}) {
		const old = document.getElementById('share-result')
		if (old) old.remove()

		const box = document.createElement('div')
		box.id = 'share-result'
		box.className = 'share-result'
		box.dataset.testid = 'share-result'

		const heading = document.createElement('div')
		heading.className = 'share-result__title'
		heading.textContent = `已分享「${title}」`
		box.appendChild(heading)

		const detail = document.createElement('div')
		detail.className = 'muted share-result__meta'
		detail.textContent =
			(alreadyShared ? '此前已共享' : `上传 ${uploaded ?? 0} 首`) +
			(Number(skipped ?? 0) > 0 ? ` · ${skipped} 首没有 B 站 bvid、未上传` : '')
		box.appendChild(detail)

		if (link) {
			// ⚠️ 链接必须是**可见文本**（而不是只塞进 input 的 value）：
			// 1) `innerText` 才包含它，读 DOM 的探针/辅助技术才看得到；
			// 2) 剪贴板不可用时用户能直接选中复制（`user-select: all` 一次点全选）。
			const line = document.createElement('div')
			line.className = 'share-result__link mono'
			line.dataset.testid = 'share-link'
			line.textContent = link
			box.appendChild(line)

			const actions = document.createElement('div')
			actions.className = 'row-actions'
			const copy = document.createElement('button')
			copy.dataset.testid = 'share-copy'
			copy.dataset.action = 'copy'
			copy.textContent = '复制链接'
			copy.addEventListener('click', () => void copyShareLink(link))
			actions.appendChild(copy)
			box.appendChild(actions)
		} else {
			const missing = document.createElement('div')
			missing.className = 'share-result__meta'
			missing.textContent = '后端没有返回分享链接（响应结构不符）'
			box.appendChild(missing)
		}

		els.content.appendChild(box)
		return box
	}

	/** 复制分享链接；剪贴板不可用时就地选中链接文本让人 Ctrl+C */
	async function copyShareLink(link) {
		let copied = false
		try {
			await navigator.clipboard?.writeText?.(link)
			copied = true
		} catch {
			copied = false
		}
		if (!copied) selectNodeText(document.getElementById('share-link'))
		setStatus(
			copied ? `已复制分享链接：${link}` : `剪贴板不可用，请手动复制：${link}`,
			copied ? 'ok' : 'busy',
		)
	}

	/** 选中一个元素的文本（配合 `user-select: all` 的链接行） */
	function selectNodeText(node) {
		if (!node) return false
		try {
			const range = document.createRange()
			range.selectNodeContents(node)
			const selection = window.getSelection()
			selection.removeAllRanges()
			selection.addRange(range)
			return true
		} catch {
			return false
		}
	}

	/**
	 * 左栏歌单行上的「分享 / 同步」（Phase 3.4）。
	 *
	 * 分享是幂等的（已共享时主进程直接返回 `alreadyShared`），所以这里不担心
	 * 重复点；同步则是「先推本地改动、再拉远端改动」。
	 *
	 * ⚠️ `skipped > 0` 必须如实说出来：只有带 B 站 bvid 的曲目能被共享，
	 * 纯本地文件会**静默**上传不了 —— 不说的话用户会对着一个缺歌的云歌单发呆。
	 */
	async function sharePlaylist(playlist, button) {
		const shared = Boolean(playlist.share_id)
		button.disabled = true
		const original = button.textContent
		button.textContent = shared ? '同步中…' : '分享中…'
		setStatus(
			shared ? `同步中…（${playlist.title}）` : `分享中…（${playlist.title}）`,
			'busy',
		)

		try {
			if (shared) {
				const data = unwrap(
					await window.bbplayer.share.sync(playlist.id),
					'同步共享歌单',
				)
				await refreshPlaylists()
				setStatus(
					`「${playlist.title}」同步完成：推送 ${data.pushed} · 丢弃 ${data.dropped} · 失败 ${data.failed} · 应用 ${data.applied}`,
					data.failed > 0 ? 'bad' : 'ok',
				)
				return
			}

			const data = unwrap(
				await window.bbplayer.share.share(playlist.id),
				'分享歌单',
			)
			// 复制分享链接（剪贴板可能不可用 —— 那就把链接留在状态栏里让人手工复制）
			let copied = false
			const link = data.shareLink ?? ''
			if (link) {
				try {
					await navigator.clipboard?.writeText?.(link)
					copied = true
				} catch {
					copied = false
				}
			}

			await refreshPlaylists()

			const uploaded = data.alreadyShared
				? '此前已共享'
				: `上传 ${data.uploaded ?? 0} 首`
			const skipped =
				Number(data.skipped ?? 0) > 0
					? `；${data.skipped} 首没有 B 站 bvid、未上传`
					: ''
			const linkNote = link
				? `；链接${copied ? '（已复制）' : '（复制失败，请手动复制）'}：${link}`
				: ''
			// 链接同时落到 #content 上的结果块里：状态栏是一行会被后续操作覆盖的
			// 文本，而分享链接需要能被**选中复制**
			renderShareResult({
				title: playlist.title,
				link,
				uploaded: data.uploaded ?? 0,
				skipped: data.skipped ?? 0,
				alreadyShared: Boolean(data.alreadyShared),
			})
			setStatus(
				`已分享「${playlist.title}」：${uploaded}${skipped}${linkNote}`,
				Number(data.skipped ?? 0) > 0 ? 'busy' : 'ok',
			)
		} catch (error) {
			setStatus(error.message, 'bad')
		} finally {
			// 重绘会换掉按钮节点，所以先确认它还在文档里
			if (button.isConnected) {
				button.disabled = false
				button.textContent = original
			}
		}
	}

	// ---------------------------------------------------------------
	// 中栏：曲目表
	// ---------------------------------------------------------------

	/**
	 * 当前表格是不是「某个本地歌单」的曲目表（决定能不能移除曲目）。
	 *
	 * 搜索结果 / 合集 / 欢迎视图都不是歌单，没有可移除的目标。共享歌单里
	 * `share_role === 'subscriber'` 的角色是**只读**的：服务端会 403，但界面
	 * 更不该先给出一个点了必然失败的按钮，所以直接不渲染这一列。
	 */
	function removalContext(trackCount) {
		const state = window.bbState.get()
		if (
			state.view !== 'playlist' ||
			!state.selectedPlaylistId ||
			trackCount === 0
		) {
			return { playlistId: null, canRemove: false, readOnly: false }
		}
		const playlist = cachedPlaylists.find(
			(item) => item.id === state.selectedPlaylistId,
		)
		return {
			playlistId: state.selectedPlaylistId,
			canRemove: playlist?.share_role !== 'subscriber',
			readOnly: playlist?.share_role === 'subscriber',
		}
	}

	// ---------------------------------------------------------------
	// 多选（阶段 6d-2）
	// ---------------------------------------------------------------

	/**
	 * 曲目的**稳定选中键**。
	 *
	 * ⚠️ 不能用 `track.id`：同一个 id 在不同列表里指的是完全不同的东西 ——
	 * 搜索结果里是 `aid`、收藏夹里是 `bv2av(bvid)`、分P 里是 `cid`、
	 * 本地库里是 DB 的 `trackId`。跨列表用同一个键会**串味**
	 * （安卓端因此统一用 `uniqueKey`，这里照做）。
	 */
	function trackKey(track) {
		if (!track) return null
		if (track.uniqueKey) return track.uniqueKey
		if (track.unique_key) return track.unique_key
		if (track.bvid) return `bilibili::${track.bvid}`
		if (track.aid != null) return `bilibili::av${track.aid}`
		if (track.id != null) return `local::${track.id}`
		return null
	}

	let selectMode = false
	let selectedKeys = new Set()
	/** Shift 连选的锚点 */
	let lastClickedKey = null
	/** 当前曲目表对应的 DOM 引用（多选状态只改类名/文案，不重渲染） */
	let selectionUi = null

	function currentTracks() {
		return window.bbState.get().tracks ?? []
	}

	/** 选中的曲目对象（按当前列表的顺序） */
	function selectedTracks() {
		return currentTracks().filter((track) => selectedKeys.has(trackKey(track)))
	}

	function onSelectKeydown(event) {
		if (event.key !== 'Escape') return
		event.stopPropagation()
		exitSelectMode()
	}

	function clearSelection() {
		selectMode = false
		selectedKeys = new Set()
		lastClickedKey = null
		window.removeEventListener('keydown', onSelectKeydown)
		syncSelectionUi()
	}

	function enterSelectMode(key) {
		lastClickedKey = key ?? null
		enterSelectModeWith(key ? [key] : [])
	}

	/** 用一组键进入多选（全选 / 反选也走它，语义一致） */
	function enterSelectModeWith(keys) {
		selectMode = true
		selectedKeys = new Set(keys)
		// 同一个函数引用重复 add 不会重复触发；退出时统一 remove
		window.addEventListener('keydown', onSelectKeydown)
		syncSelectionUi()
	}

	function exitSelectMode() {
		clearSelection()
	}

	function toggleKey(key) {
		if (!key) return
		if (selectedKeys.has(key)) selectedKeys.delete(key)
		else selectedKeys.add(key)
		syncSelectionUi()
	}

	/** Shift 连选：从锚点到目标之间的**当前列表顺序**全部选中 */
	function selectRangeTo(key) {
		const keys = currentTracks().map(trackKey)
		const from = keys.indexOf(lastClickedKey)
		const to = keys.indexOf(key)
		if (from < 0 || to < 0) {
			toggleKey(key)
			return
		}
		const [start, end] = from <= to ? [from, to] : [to, from]
		selectedKeys = new Set(keys.slice(start, end + 1).filter(Boolean))
		syncSelectionUi()
	}

	/**
	 * 把多选状态同步到界面。
	 *
	 * ⚠️ 这里**不重渲染整张表**：多选是高频操作，重建 24 行的 DOM 会丢滚动位置、
	 * 也会把拖拽等监听器重绑一遍。只改类名与文案就够了。
	 */
	function syncSelectionUi() {
		const ui = selectionUi
		if (!ui) return
		ui.table.classList.toggle('is-select-mode', selectMode)
		// 多选时关掉行拖拽：拖动与"点一下选中"会互相打架
		// （安卓端在本地列表里也是把「⋮」换成拖拽把手，不会同时给两个手势）
		for (const row of ui.table.querySelectorAll('tbody tr')) {
			const key = row.dataset.trackKey
			row.classList.toggle(
				'is-checked',
				selectMode && key != null && selectedKeys.has(key),
			)
			if (row.dataset.draggable === 'true') row.draggable = !selectMode
		}
		ui.bar.hidden = !selectMode
		ui.actions.hidden = selectMode
		const count = selectedKeys.size
		ui.count.textContent = `已选择 ${count} 首`
		ui.addButton.disabled = count === 0
		for (const button of ui.batchButtons) button.disabled = count === 0
		ui.selectButton.classList.toggle('is-active', selectMode)
	}

	/*
	 * 后台补封面（阶段 C-2c）。
	 *
	 * 用户的原话：「没有做拉取视频封面作为歌曲封面的功能（正方形），导致左侧歌曲
	 * 预览全部是标题第一个字」。真根因有**两层**：
	 *   1. `db.upsertTrack` 命中已有行就直接 return —— 首次以"没封面"落库的曲目
	 *      永远不会被补上（已在 `db.cjs` 修）；
	 *   2. **没有任何回填路径** —— 库里已经存在的那些无封面曲目不会自己好。
	 * 这里补的是第二层：列表渲染完，把**这一屏里缺封面**的 bvid 交给主进程
	 * （串行 + 间隔拉 `pic`、写库），拿到之后就地把首字方块换成图片。
	 *
	 * ⚠️ 就地替换而不是重渲染整张表：重渲染会丢掉滚动位置与**多选状态**，
	 * 而用户可能正一边选歌一边等封面。
	 */
	let coverBackfillRunning = false
	const coverBackfillTried = new Set()

	async function backfillCovers(tracks, table) {
		if (coverBackfillRunning) return
		const missing = []
		for (const track of tracks) {
			const bvid = track?.bvid
			if (!bvid || coverBackfillTried.has(bvid)) continue
			if (track.cover || track.coverUrl || track.cover_url) continue
			coverBackfillTried.add(bvid)
			missing.push(bvid)
		}
		if (missing.length === 0) return

		coverBackfillRunning = true
		try {
			const result = await window.bbplayer.backfillCovers(missing.slice(0, 60))
			const updated = result?.data?.updated ?? []
			if (updated.length === 0) return
			const byBvid = new Map(updated.map((item) => [item.bvid, item.cover]))
			for (const row of table.querySelectorAll('tbody tr')) {
				const cover = byBvid.get(row.dataset.bvid)
				if (!cover) continue
				const art = row.querySelector('.list-row__art')
				if (!art) continue
				art.textContent = ''
				const img = document.createElement('img')
				img.src = cover
				img.alt = ''
				img.loading = 'lazy'
				// 加载失败仍退回首字方块（而不是留一个破图图标）
				img.addEventListener('error', () => {
					const fallback = window.bbComponents.art({
						title: row.querySelector('.col-title__text')?.textContent ?? '',
					})
					art.replaceChildren(...fallback.childNodes)
				})
				art.appendChild(img)
			}
		} catch {
			// 补封面是"尽力而为"：失败不影响列表本身
		} finally {
			coverBackfillRunning = false
		}
	}

	/**
	 * 渲染一张曲目表。
	 *
	 * ## 两种形态（同一份实现）
	 *
	 * * **整页**：`into` 不传 → 渲染进 `#content`，带页面级标题、返回按钮、
	 *   「N 首」计数、只读提示；
	 * * **内嵌**：传 `into`（一个容器）→ 只渲染**表格本体**（动作条 + 多选工具条
	 *   + 表格），不碰页面标题，也不清空 `#content`。
	 *
	 * ⚠️ 为什么要有内嵌形态：收藏夹的展开预览原来**自己手搓了第二张表**
	 * （`favorites.js`，只有 序号/标题/作者/时长 四列），于是那一屏
	 * **不能播放、没有「⋮」、不能多选** —— 用户的原话是"没有和正式歌单一样的
	 * 操作按钮，同时也无法多选添加进歌单"。
	 * 修法不是给预览再补一套按钮（那是第三套），而是**把整页那个渲染器参数化**：
	 * 预览一旦走同一条路径，行内动作、多选、双击播放、批量添加到歌单
	 * **自动全都有**，以后新增行能力两处一起生效。
	 *
	 * @param {object[]} tracks
	 * @param {object} [options]
	 * @param {string} [options.title] 整页形态的标题
	 * @param {string} [options.query] 搜索关键词（决定空状态文案）
	 * @param {HTMLElement|null} [options.into] 内嵌形态的目标容器
	 * @param {string} [options.tableTestid] 表格的 testid（探针按它定位）
	 */
	function renderTrackTable(
		tracks,
		{ title, query, into = null, tableTestid = 'track-table' } = {},
	) {
		const embedded = Boolean(into)
		const container = into ?? els.content
		if (!embedded) clear(els.content)
		// 换了列表就把多选清掉 —— 否则在 A 歌单选中的曲子会"跟到" B 歌单
		// （这也是为什么清空放在**渲染入口**而不是各个调用点）
		clearSelection()
		selectionUi = null
		// 共享视图是常驻节点，从它切回来（例如直接搜索、点左栏歌单）时要显式让位
		if (!embedded) window.bbUI?.showContent?.()

		if (!embedded) {
			const head = document.createElement('div')
			head.className = 'view-head'
			const lead = document.createElement('div')
			lead.className = 'view-head__lead'

			// 歌单详情是从「播放列表」卡片进来的，所以要有一条**明确的回路**。
			// 安卓端这是路由自带的返回；桌面端没有导航栈，得自己给。
			if (window.bbState.get().view === 'playlist') {
				const back = document.createElement('button')
				back.className = 'text-button view-head__back'
				back.dataset.testid = 'playlist-back'
				back.innerHTML = `${window.bbComponents.iconHtml('arrow_back', 'icon--sm')} 播放列表`
				back.addEventListener('click', () => void showPlaylistsTab())
				lead.appendChild(back)
			}

			const h2 = document.createElement('h2')
			h2.textContent = title || '音乐库'
			lead.appendChild(h2)
			head.appendChild(lead)

			const meta = document.createElement('span')
			meta.className = 'muted'
			meta.textContent = `${tracks.length} 首`
			head.appendChild(meta)
			container.appendChild(head)
		}

		const removal = removalContext(tracks.length)
		if (!embedded && removal.readOnly) {
			const note = document.createElement('p')
			note.className = 'muted share-hint'
			note.dataset.testid = 'playlist-readonly-note'
			note.textContent =
				'这是订阅来的共享歌单（只读）：可以播放与同步，但不能增删曲目。'
			container.appendChild(note)
		}

		if (tracks.length === 0) {
			container.appendChild(
				window.bbComponents.empty({
					testid: embedded ? 'embedded-empty' : 'content-empty',
					iconName: query ? 'search_off' : 'library_music',
					title: query ? `没有与「${query}」相关的结果` : '这里还没有内容',
					hint: query
						? '换个关键词，或者直接用 BV 号搜索。'
						: '用上方搜索框找歌，或从左栏选一个歌单。',
				}),
			)
			return
		}

		// 批量操作
		const actions = document.createElement('div')
		actions.className = 'row-actions'
		const playAll = document.createElement('button')
		playAll.dataset.testid = 'btn-play-all'
		playAll.innerHTML = '<span class="icon icon--sm">play_arrow</span> 播放全部'
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

		/*
		 * 「多选」的**入口**。
		 *
		 * 安卓端靠长按 500ms 进多选 —— 桌面上没有长按这个手势，所以要有
		 * 一个看得见的入口。Ctrl / Shift 点选是桌面惯例（保留），但**发现性**
		 * 只能靠一个按钮给（用户明确要求过"不要自己发明桌面惯例，但也不该
		 * 让功能不可发现"）。
		 */
		const selectButton = document.createElement('button')
		selectButton.dataset.testid = 'btn-select-mode'
		selectButton.textContent = '多选'
		selectButton.addEventListener('click', () => {
			if (selectMode) exitSelectMode()
			else enterSelectMode(null)
		})
		actions.appendChild(selectButton)
		container.appendChild(actions)

		// 多选工具条：与安卓端一样，进多选后**替换掉**上面那排动作
		// （安卓端是 Appbar 的 action 组整体替换掉返回按钮）。
		const bar = document.createElement('div')
		bar.className = 'selection-bar'
		bar.dataset.testid = 'selection-bar'
		bar.hidden = true

		const count = document.createElement('span')
		count.className = 'selection-bar__count'
		count.dataset.testid = 'selection-count'
		count.textContent = '已选择 0 首'
		bar.appendChild(count)

		const batchButtons = []
		const makeBatch = (testid, label, className, handler, options = {}) => {
			const button = document.createElement('button')
			button.dataset.testid = testid
			if (className) button.className = className
			button.textContent = label
			button.disabled = options.needsSelection === true
			button.addEventListener('click', () => handler(button))
			bar.appendChild(button)
			// ⚠️ 只有**需要选中项**的动作才归 `batchButtons`（选中为 0 时禁用）。
			// 全选 / 反选**不能**被禁用：反选之后恰好选中 0 首，若把全选也一起
			// 禁用，用户就再也点不回来了 —— 只能退出多选重进（实测踩到）。
			if (options.needsSelection) batchButtons.push(button)
			return button
		}

		makeBatch('selection-all', '全选', null, () =>
			enterSelectModeWith(new Set(tracks.map(trackKey).filter(Boolean))),
		)
		makeBatch('selection-invert', '反选', null, () => {
			const inverted = new Set(
				tracks.map(trackKey).filter((key) => key && !selectedKeys.has(key)),
			)
			enterSelectModeWith(inverted)
		})
		const addButton = makeBatch(
			'selection-add',
			'添加到歌单',
			'btn--filled',
			() => openAddToPlaylistDialog(selectedTracks()),
			{ needsSelection: true },
		)
		// 批量移除与安卓端的本地歌单批量矩阵一致（收藏夹/搜索结果没有"移除"）
		const removeButton = makeBatch(
			'selection-remove',
			'从歌单移除',
			'btn--tonal',
			() => void removeSelectedTracks(removeButton),
			{ needsSelection: true },
		)
		removeButton.hidden = !removal.canRemove

		/*
		 * ⚠️ 「清除选择」是**桌面端必须补的**：安卓端把返回按钮整组换掉之后，
		 * 屏幕上没有任何退出多选的入口（只能靠系统返回键）——
		 * `useTrackSelection` 的注释里也承认了这一点。
		 * 桌面上没有系统返回键，所以这里必须给一个，并且 Esc 也能退出。
		 */
		const spacer = document.createElement('span')
		spacer.className = 'modal__actions-spacer'
		bar.appendChild(spacer)
		const clearButton = document.createElement('button')
		clearButton.className = 'text-button'
		clearButton.dataset.testid = 'selection-clear'
		clearButton.textContent = '清除选择（Esc）'
		clearButton.addEventListener('click', () => exitSelectMode())
		bar.appendChild(clearButton)
		container.appendChild(bar)

		const table = document.createElement('table')
		table.className = 'track-table'
		table.dataset.testid = tableTestid

		const thead = document.createElement('thead')
		const headRow = document.createElement('tr')
		const columns = [
			['#', 'col-index'],
			['标题', 'col-title'],
			['作者', 'col-artist'],
			['时长', 'col-duration'],
		]
		// 「操作」列**永远存在**：每行至少有一个「下一首播放」。
		// 只有「移除」是可选的（只对可写的本地歌单开放，见 removalContext）。
		//
		// ⚠️ 表头与行体的列数必须一致，否则整张表错位。
		columns.push(['操作', 'col-actions'])
		for (const [label, cls] of columns) {
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
			// 多选的**稳定键**（`uniqueKey` 语义，见 trackKey 的注释）
			const key = trackKey(track)
			if (key) tr.dataset.trackKey = key
			if (window.bbPlayer.getCurrent()?.bvid === track.bvid) {
				tr.classList.add('is-playing')
			}

			// 序号 / 复选框：同一格。
			// 安卓端也是这个做法（`selectMode` 时序号淡出、复选框淡入），
			// 而不是**多插一列** —— 多一列会让整张表在进多选时横向跳一下。
			const indexCell = document.createElement('td')
			indexCell.className = 'col-index'
			const indexText = document.createElement('span')
			indexText.className = 'track-index'
			indexText.textContent = String(index + 1)
			indexCell.appendChild(indexText)
			const check = document.createElement('span')
			check.className = 'track-check'
			check.dataset.testid = `track-check-${index}`
			check.appendChild(window.bbComponents.icon('check', 'track-check__tick'))
			indexCell.appendChild(check)
			tr.appendChild(indexCell)

			// 标题单元格特殊处理：**曲绘封面 + 标题**。
			//
			// 阶段 2 之前这里只有文字，一整屏看下来是"文件名列表"。
			// 移动端每一行都有封面，那才是"在选歌"而不是"在读表格"。
			//
			// 封面统一是**圆角正方形**（见 components.css 的 .list-row__art）——
			// 不用圆形：圆形是"头像"的语言，方形才像唱片/视频封面。
			//
			// ⚠️ flex 必须加在**单元格里的一层 div** 上，不能加在 `<td>` 上。
			// 给 `td` 设 `display: flex` 会让它不再生成 table-cell 盒，
			// 表格布局当场崩掉：封面被压成一条细竖线、标题整段消失
			// （第一版就是这么写的，截图里一眼可见）。
			const titleCell = document.createElement('td')
			titleCell.className = 'col-title'
			titleCell.title = track.title || '(无标题)'
			const titleWrap = document.createElement('div')
			titleWrap.className = 'col-title__wrap'
			titleWrap.appendChild(
				window.bbComponents.art({
					title: track.title,
					coverUrl: track.cover ?? track.coverUrl ?? track.cover_url ?? null,
				}),
			)
			const titleText = document.createElement('span')
			titleText.className = 'col-title__text'
			titleText.textContent = track.title || '(无标题)'
			titleWrap.appendChild(titleText)
			titleCell.appendChild(titleWrap)
			tr.appendChild(titleCell)

			for (const [text, cls] of [
				/*
				 * ⚠️ 字段名要**同时认两套**。
				 *
				 * 走数据库的曲目带 `artist` / `artist_name`；
				 * 而直接从 B 站接口来的条目（收藏夹预览、搜索结果）带的是
				 * **`upperName`** —— 那是 `bilibili-api.cjs:405` 从
				 * `media.upper.name` 映射来的。
				 *
				 * 原来只认前两个，于是收藏夹预览的「作者」列**永远是「—」**
				 * （用了真实接口验证过：`/x/v3/fav/resource/list` 返回的
				 * media 10/10 条都带 `upper`，所以不是接口的问题，
				 * 是本渲染器不认这个字段名）。
				 */
				[
					track.artist ||
						track.artist_name ||
						track.upperName ||
						track.author ||
						'—',
					'col-artist',
				],
				[window.bbPlayer.formatTime(track.duration), 'col-duration'],
			]) {
				const td = document.createElement('td')
				td.className = cls
				td.textContent = text
				td.title = text
				tr.appendChild(td)
			}

			// 行内动作：**永远有**「下一首播放」，可移除的歌单再加「移除」。
			//
			// ⚠️ 原来只有「移除」才给一个操作列，于是搜索结果 / 收藏夹里的曲目
			// **完全没有行内动作** —— 想"下一首就听这首"只能先整单加进队列再拖，
			// 而拖拽当时还不存在。用户明确要求了「下一首播放」。
			//
			// 阶段 6c：这两个图标合成**一个「⋯」**，点开弹出菜单。
			// 安卓端就是这么做的（远程列表 4 项、本地歌单 7 项），
			// 理由见 `components.js` 里 `menu()` 的注释。
			const actionsCell = document.createElement('td')
			actionsCell.className = 'col-actions'

			const moreButton = document.createElement('button')
			moreButton.className = 'track-action'
			moreButton.dataset.testid = `track-more-${index}`
			moreButton.dataset.action = 'more'
			moreButton.innerHTML = window.bbComponents.iconHtml(
				'more_vert',
				'icon--sm',
			)
			moreButton.title = '更多操作'
			moreButton.setAttribute('aria-label', '更多操作')
			moreButton.addEventListener('click', (event) => {
				// 不要让单击冒泡到行的「选中」逻辑上
				event.stopPropagation()
				/*
				 * 菜单项与安卓端对齐，但**按上下文裁剪**：
				 *   * 「下一首播放」—— 任何列表都成立（远程列表的第一项就是它）；
				 *   * 「从歌单移除」—— 只有可写的本地歌单才有（收藏夹/搜索结果
				 *     不是本地列表，移动端那边也没有删除）；
				 *   * 「查看 up 主作品」—— 需要 mid，当前曲目对象不一定有，
				 *     有才放进去（移动端同样有这个前置条件）。
				 */
				const items = [
					{
						label: '下一首播放',
						icon: 'queue_play_next',
						testid: `menu-play-next-${index}`,
						onSelect: () => {
							const result = window.bbPlayer.playNextInsert(track)
							setStatus(
								result.ok ? `「${track.title}」将在下一首播放` : '没能加入队列',
								result.ok ? 'ok' : 'bad',
							)
						},
					},
					{
						// 安卓端远程列表的第 3 项就是它（顺序也照抄：
						// 下一首播放 → … → 添加到歌单 → …）
						label: '添加到歌单',
						icon: 'playlist_add',
						testid: `menu-add-to-playlist-${index}`,
						onSelect: () => openAddToPlaylistDialog([track]),
					},
				]
				if (removal.canRemove) {
					items.push({
						label: '从歌单移除',
						icon: 'delete',
						danger: true,
						testid: `menu-remove-${index}`,
						onSelect: () => void removeTrackFromPlaylist(track, moreButton),
					})
				}
				window.bbComponents.menu(moreButton, items)
			})
			actionsCell.appendChild(moreButton)

			// ⚠️ 列数必须与表头一致，否则表格会错位。
			// 表头在下面按同样的条件决定要不要加「操作」列。
			tr.appendChild(actionsCell)

			// 拖拽重排（只在可写的歌单里开启 —— 搜索结果 / 收藏夹不是本地列表，
			// 拖了也没地方存）
			if (removal.canRemove) {
				wireRowDrag(tr, index, tbody, (from, to) => {
					const playlistId = window.bbState.get().selectedPlaylistId
					if (!playlistId) return
					void moveTrackInPlaylist(playlistId, from, to)
				})
			}

			tr.addEventListener('dblclick', () => {
				// 多选态下双击不播放（否则"点两下选中两首"会变成开始播放）
				if (selectMode) return
				window.bbPlayer.setQueue(tracks, index)
				window.bbPlayer.playAt(index)
				void window.bbPlayer.play()
			})
			tr.addEventListener('click', (event) => {
				// `⋮` 自己 stopPropagation 了，但其它行内交互也一并放行
				if (event.target.closest?.('.track-action')) return

				// Ctrl / Cmd：切换这一首的选中；Shift：从锚点连选。
				// 这是桌面端的"多选手势"，与安卓端的"长按"对应。
				if (event.shiftKey && selectMode && lastClickedKey) {
					selectRangeTo(key)
					lastClickedKey = key
					return
				}
				if (event.ctrlKey || event.metaKey) {
					if (selectMode) toggleKey(key)
					else enterSelectMode(key)
					lastClickedKey = key
					return
				}
				if (selectMode) {
					toggleKey(key)
					lastClickedKey = key
					return
				}

				// 单击只选中（高亮），双击才播放 —— 桌面上避免误触
				for (const other of tbody.querySelectorAll('tr')) {
					other.classList.remove('is-selected')
				}
				tr.classList.add('is-selected')
			})

			tbody.appendChild(tr)
		})
		table.appendChild(tbody)
		container.appendChild(table)

		// 多选只改类名/文案，不重渲染（见 syncSelectionUi 的注释）
		selectionUi = {
			table,
			bar,
			actions,
			count,
			addButton,
			batchButtons,
			selectButton,
		}
		syncSelectionUi()

		// 缺封面的行交给主进程后台补（拿到后就地替换，见 backfillCovers 的注释）
		void backfillCovers(tracks, table)
	}

	/**
	 * 批量从歌单移除选中的曲目（安卓端本地歌单的批量矩阵里有「删除」）。
	 *
	 * 只确认**一次**：逐首确认会让批量操作变成 N 次点击。
	 */
	async function removeSelectedTracks(button) {
		const tracks = selectedTracks()
		const playlistId = window.bbState.get().selectedPlaylistId
		if (!playlistId || tracks.length === 0) return
		const ok =
			typeof window.bbProbe !== 'undefined' ||
			window.confirm(`确定从歌单里移除选中的 ${tracks.length} 首吗？`)
		if (!ok) return
		button.disabled = true
		let removed = 0
		try {
			for (const track of tracks) {
				if (track?.id == null) continue
				const result = await window.bbplayer.playlist.removeTrack({
					playlistId,
					trackId: track.id,
				})
				if (result?.ok) removed += 1
			}
			setStatus(`已移除 ${removed} 首`, 'ok')
			exitSelectMode()
			// ⚠️ 移除后必须重渲染：`sort_key` 与序号都变了
			await openPlaylist(playlistId)
		} catch (error) {
			setStatus(error.message, 'bad')
		} finally {
			if (button.isConnected) button.disabled = false
		}
	}

	/**
	 * 从当前歌单移除一首曲目（Phase 3.4）。
	 *
	 * 走 `window.bbplayer.playlist.removeTrack`：主进程删行之后会把删除写进
	 * 共享 outbox 并在后台推给协作者，所以这里**不需要**自己调 `share.sync`。
	 *
	 * 只读角色（`share_role === 'subscriber'`）在 `removalContext` 里就已经
	 * 被挡掉了，所以这个函数只可能在可写歌单上被调用。
	 */
	/**
	 * 「添加到歌单」对话框（阶段 6c）。
	 *
	 * ## 对齐安卓端
	 *
	 * * **居中 Dialog**（不是底部弹层）；
	 * * 歌单列表 + **单选**（语义是"选一个目的地"，不是多选）；
	 * * 左侧「创建歌单」、右侧「取消 / 确认」；
	 * * 脚注解释为什么不显示某些歌单。
	 *
	 * ## ⚠️ 这里**主动修掉**移动端的一个断点
	 *
	 * 安卓端从本弹层点「创建歌单」，创建成功后会 `closeAll()` 关闭**所有**弹层 ——
	 * 既不把用户刚选中的歌加进新歌单，也不回到这个弹层。**用户白选一场。**
	 *
	 * 桌面端改成**内联新建**：在同一个对话框里输入名字 → 创建 → **自动选中
	 * 新歌单并保留已选曲目**，用户再点「确认」即可。少一次往返，也不丢选择。
	 */
	function openAddToPlaylistDialog(tracks) {
		const items = (tracks ?? []).filter((t) => t?.bvid)
		if (items.length === 0) {
			setStatus('这些曲目没有可加入的 BV 号', 'bad')
			return
		}
		let selectedId = null
		let playlists = []

		const view = window.bbComponents.dialog({
			testid: 'add-to-playlist',
			title: '添加到歌单',
		})

		const listBox = document.createElement('ul')
		listBox.className = 'dialog-list'
		listBox.dataset.testid = 'add-to-playlist-list'
		view.body.appendChild(listBox)

		const note = document.createElement('p')
		note.className = 'dialog-note'
		/*
		 * 与安卓端同一句意思，但换成桌面端更清楚的措辞 ——
		 * 安卓端写「与远程同步或订阅的共享歌单不会显示」，用户不知道**为什么**。
		 */
		note.textContent =
			'只显示你自己的本地歌单。与 B 站同步的歌单、以及订阅来的共享歌单不可写入，所以不在这里。'
		view.body.appendChild(note)

		const newRow = document.createElement('div')
		newRow.className = 'dialog-new-row'
		newRow.hidden = true
		const newInput = document.createElement('input')
		newInput.type = 'text'
		newInput.placeholder = '新歌单名字'
		newInput.dataset.testid = 'add-to-playlist-new-name'
		const newConfirm = document.createElement('button')
		newConfirm.className = 'btn--filled'
		newConfirm.dataset.testid = 'add-to-playlist-new-confirm'
		newConfirm.textContent = '创建'
		newRow.append(newInput, newConfirm)
		view.body.appendChild(newRow)

		const createButton = document.createElement('button')
		createButton.className = 'text-button'
		createButton.dataset.testid = 'add-to-playlist-create'
		createButton.textContent = '创建歌单'
		const spacer = document.createElement('span')
		spacer.className = 'modal__actions-spacer'
		const cancelButton = document.createElement('button')
		cancelButton.className = 'text-button'
		cancelButton.dataset.testid = 'add-to-playlist-cancel'
		cancelButton.textContent = '取消'
		const okButton = document.createElement('button')
		okButton.className = 'btn--filled'
		okButton.dataset.testid = 'add-to-playlist-ok'
		okButton.textContent = '确认'
		okButton.disabled = true
		view.actions.append(createButton, spacer, cancelButton, okButton)

		/** 与安卓端同一个过滤：只有自己的本地歌单可写 */
		const writable = (playlist) => playlist?.type === 'local'

		function render() {
			listBox.textContent = ''
			if (playlists.length === 0) {
				listBox.appendChild(
					window.bbComponents.empty({
						testid: 'add-to-playlist-empty',
						iconName: 'playlist_add',
						title: '还没有本地歌单',
						hint: '点左下角「创建歌单」新建一个。',
					}),
				)
			}
			for (const playlist of playlists) {
				const li = document.createElement('li')
				const button = document.createElement('button')
				button.className = 'dialog-option'
				button.dataset.testid = `add-to-playlist-option-${playlist.id}`
				button.dataset.playlistId = String(playlist.id)
				if (playlist.id === selectedId) button.classList.add('is-selected')
				const mark = document.createElement('span')
				mark.className = 'dialog-option__mark'
				const main = document.createElement('span')
				main.className = 'dialog-option__main'
				const title = document.createElement('span')
				title.className = 'dialog-option__title'
				title.textContent = playlist.title ?? '(未命名)'
				const sub = document.createElement('span')
				sub.className = 'dialog-option__sub'
				sub.textContent = `${playlist.itemCount ?? 0} 首`
				main.append(title, sub)
				button.append(mark, main)
				button.addEventListener('click', () => {
					selectedId = playlist.id
					for (const other of listBox.querySelectorAll('.dialog-option')) {
						other.classList.toggle(
							'is-selected',
							Number(other.dataset.playlistId) === selectedId,
						)
					}
					okButton.disabled = false
				})
				li.appendChild(button)
				listBox.appendChild(li)
			}
			okButton.disabled = selectedId == null
		}

		async function refreshList() {
			try {
				const result = await window.bbplayer.listPlaylists()
				playlists = (result?.data ?? []).filter(writable)
			} catch {
				playlists = []
			}
			render()
		}

		createButton.addEventListener('click', () => {
			newRow.hidden = !newRow.hidden
			if (!newRow.hidden) newInput.focus()
		})

		async function createInline() {
			const title = newInput.value.trim()
			if (!title) {
				setStatus('歌单名字不能为空', 'bad')
				return
			}
			const created = await window.bbplayer.createPlaylist({ title })
			if (created?.ok === false) {
				setStatus(`创建失败：${created.error}`, 'bad')
				return
			}
			// ⚠️ 这两步就是"修断点"的关键：**重新拉列表 + 自动选中新歌单**。
			// 安卓端在这里直接 closeAll()，用户选中的曲目就丢了。
			await refreshList()
			const newId = created?.data?.id ?? created?.data?.playlist?.id ?? null
			if (newId != null) {
				selectedId = newId
				newRow.hidden = true
				newInput.value = ''
				render()
			}
			setStatus(`已创建「${title}」，已为你选中`, 'ok')
		}
		newConfirm.addEventListener('click', () => void createInline())
		newInput.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault()
				void createInline()
			}
		})

		cancelButton.addEventListener('click', () => view.close())
		okButton.addEventListener('click', () => {
			void (async () => {
				if (selectedId == null) return
				const result = await window.bbplayer.addTracksToPlaylist({
					playlistId: selectedId,
					tracks: items.map((t) => ({
						bvid: t.bvid,
						title: t.title,
						artist: t.artist ?? t.artist_name ?? t.upperName ?? null,
						cover: t.cover ?? t.coverUrl ?? null,
						duration: t.duration ?? 0,
					})),
				})
				if (result?.ok === false) {
					setStatus(`加入歌单失败：${result.error}`, 'bad')
					return
				}
				const { added = 0, skipped = 0 } = result?.data ?? {}
				// 分开报「新增」与「已在歌单里」—— 安卓端只 toast 一句"添加成功"，
				// 用户不知道有几首没进去。
				setStatus(
					skipped > 0
						? `已加入 ${added} 首，${skipped} 首本来就在这个歌单里`
						: `已加入 ${added} 首`,
					'ok',
				)
				view.close()
				void refreshPlaylists()
			})()
		})

		void refreshList()
	}

	async function removeTrackFromPlaylist(track, button) {
		const playlistId = window.bbState.get().selectedPlaylistId
		if (!playlistId || track?.id == null) {
			setStatus('无法确定要移除的曲目（缺少 trackId）', 'bad')
			return
		}

		const title = track.title || '(无标题)'
		const playlist = cachedPlaylists.find((item) => item.id === playlistId)
		const sharedNote = playlist?.share_id
			? '\n\n这是共享歌单：移除会同步给其他协作者。'
			: ''
		// ⚠️ 探针模式下直接放行：`executeJavaScript` 点出来的 click 没有人能去点
		// 那个原生确认框（探针驱动里对历史「清空」是显式覆盖 window.confirm 的，
		// 这里让应用自己识别探针模式，省掉那个易忘的步骤）
		const confirmed =
			typeof window.bbProbe !== 'undefined' ||
			window.confirm(`确定从歌单里移除「${title}」吗？${sharedNote}`)
		if (!confirmed) return

		button.disabled = true
		const original = button.textContent
		button.textContent = '移除中…'
		setStatus(`正在移除「${title}」…`, 'busy')

		try {
			const data = unwrap(
				await window.bbplayer.playlist.removeTrack({
					playlistId,
					trackId: track.id,
				}),
				'移除曲目',
			)
			// ⚠️ 先刷新与重载（`openPlaylist` 结尾会写「已加载 N 首」），
			// 最后才写结果文案，否则结果会被它立刻覆盖
			await refreshPlaylists()
			await openPlaylist(playlistId)
			setStatus(
				data.removed
					? `已从歌单移除「${title}」`
					: `「${title}」不在这个歌单里（可能已被移除）`,
				data.removed ? 'ok' : 'busy',
			)
		} catch (error) {
			setStatus(error.message, 'bad')
		} finally {
			if (button.isConnected) {
				button.disabled = false
				button.textContent = original
			}
		}
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
		window.bbUI?.showContent?.()

		// 它本质就是一个**空状态**，所以用组件层的 `.empty`
		// （淡图标 + 标题 + 一句说明 + 动作），而不是自己拼
		// 「h2 + 一段灰字 + 一排按钮」—— 后者会在同一个应用里造出第二套空状态样式。
		//
		// 文案只说**用户能做什么**，不说"本地库"这类实现词。
		const seed = document.createElement('button')
		seed.className = 'btn--filled'
		seed.dataset.testid = 'btn-seed-demo'
		seed.textContent = '导入示例合集'
		seed.addEventListener('click', () => void importDemoCollection(seed))

		const toSearch = document.createElement('button')
		toSearch.className = 'btn--tonal'
		toSearch.dataset.testid = 'btn-goto-search'
		toSearch.textContent = '去搜索'
		toSearch.addEventListener('click', () => {
			document.querySelector('[data-view="search"]')?.click()
		})

		els.content.appendChild(
			window.bbComponents.empty({
				testid: 'welcome',
				iconName: 'library_music',
				title: '这里还没有歌',
				hint: '搜索 B 站的视频直接播放，或者从任意 UP 的公开合集导入一整个歌单。',
				actions: [seed, toSearch],
			}),
		)
	}

	/**
	 * 让一行可以**拖拽重排**（用户明确要求的功能：更改列表顺序）。
	 *
	 * 用原生 HTML5 拖放而不是引入库：只有"行内上下移动"这一个场景，
	 * 而 `dragover` + `drop` 两个事件就够了。
	 *
	 * ⚠️ 落点判断要按**鼠标在行的上半/下半**决定插到前面还是后面 ——
	 * 只按"拖到了哪一行"的话，往下拖永远只能落到那一行的前面，
	 * 拖到最后一行的后面就永远做不到。
	 *
	 * @param {HTMLElement} row 被拖的行
	 * @param {number} index 它的下标
	 * @param {HTMLElement} container 行容器（用于清除其它行的样式）
	 * @param {(from: number, to: number) => void} onDrop
	 */
	function wireRowDrag(row, index, container, onDrop) {
		row.draggable = true
		// 多选时要把拖拽关掉（见 syncSelectionUi）—— 记在 dataset 上，
		// 免得靠"读 draggable 当前值"反推它本来该不该可拖
		row.dataset.draggable = 'true'
		row.dataset.dragIndex = String(index)

		row.addEventListener('dragstart', (event) => {
			event.dataTransfer.effectAllowed = 'move'
			// Firefox 要求必须 setData 才会真的开始拖
			event.dataTransfer.setData('text/plain', String(index))
			row.classList.add('is-dragging')
		})

		row.addEventListener('dragend', () => {
			row.classList.remove('is-dragging')
			for (const other of container.querySelectorAll(
				'.is-drop-before, .is-drop-after',
			)) {
				other.classList.remove('is-drop-before', 'is-drop-after')
			}
		})

		row.addEventListener('dragover', (event) => {
			event.preventDefault()
			event.dataTransfer.dropEffect = 'move'
			const rect = row.getBoundingClientRect()
			const after = event.clientY > rect.top + rect.height / 2
			row.classList.toggle('is-drop-before', !after)
			row.classList.toggle('is-drop-after', after)
		})

		row.addEventListener('dragleave', () => {
			row.classList.remove('is-drop-before', 'is-drop-after')
		})

		row.addEventListener('drop', (event) => {
			event.preventDefault()
			const from = Number(
				event.dataTransfer.getData('text/plain') || row.dataset.dragIndex,
			)
			const rect = row.getBoundingClientRect()
			const after = event.clientY > rect.top + rect.height / 2
			// 目标位置是"插到这一行之前/之后"换算成的最终下标
			let to = index + (after ? 1 : 0)
			// 从前面往后拖时，移走自己会让后面的下标整体前移一格
			if (from < to) to -= 1
			if (!Number.isInteger(from) || from < 0 || from === to) return
			row.classList.remove('is-drop-before', 'is-drop-after')
			onDrop(from, to)
		})
	}

	/** 歌单内重排并刷新（走 db 的 fractional indexing，见 db.cjs） */
	async function moveTrackInPlaylist(playlistId, from, to) {
		try {
			const result = await window.bbplayer.movePlaylistTrack({
				playlistId,
				from,
				to,
			})
			if (result?.ok === false) throw new Error(result.error ?? '重排失败')
			await openPlaylist(playlistId)
			setStatus('已调整播放顺序', 'ok')
		} catch (error) {
			setStatus(error.message, 'bad')
		}
	}

	/** 示例合集：B 站官方 UP 的公开合集（无需登录即可拉取） */
	const DEMO_MID = 8047632

	/** 歌单卡片上的状态图标（与安卓端 `LocalPlaylistItem` 的副标题图标同义） */
	function playlistBadges(playlist) {
		const badges = []
		if (playlist?.share_id) badges.push('group')
		else if (playlist?.type && playlist.type !== 'local') badges.push('sync')
		return badges
	}

	/**
	 * 新建歌单（页签头部的 `+` 菜单第一项）。
	 *
	 * ⚠️ 复用与「添加到歌单」弹层里**同一套**内联创建语义：
	 * 建完立刻刷新列表并打开它。区别只是这里没有「已选曲目」要保留。
	 */
	function openCreatePlaylistDialog() {
		const view = window.bbComponents.dialog({
			testid: 'create-playlist',
			title: '新建播放列表',
		})

		const input = document.createElement('input')
		input.type = 'text'
		input.placeholder = '歌单名字'
		input.dataset.testid = 'create-playlist-name'
		input.maxLength = 60
		view.body.appendChild(input)

		const cancelButton = document.createElement('button')
		cancelButton.className = 'text-button'
		cancelButton.dataset.testid = 'create-playlist-cancel'
		cancelButton.textContent = '取消'
		const okButton = document.createElement('button')
		okButton.className = 'btn--filled'
		okButton.dataset.testid = 'create-playlist-ok'
		okButton.textContent = '创建'
		view.actions.append(cancelButton, okButton)

		async function create() {
			const title = input.value.trim()
			if (!title) {
				setStatus('歌单名字不能为空', 'bad')
				input.focus()
				return
			}
			okButton.disabled = true
			const created = await window.bbplayer.createPlaylist({ title })
			if (created?.ok === false) {
				okButton.disabled = false
				setStatus(`创建失败：${created.error}`, 'bad')
				return
			}
			view.close()
			await refreshPlaylists()
			const newId = created?.data?.id ?? created?.data?.playlist?.id ?? null
			setStatus(`已创建「${title}」`, 'ok')
			// 建完直接进去 —— 空歌单里下一步必然是加歌，站在列表上没意义
			if (newId != null) await openPlaylist(newId)
			else await showPlaylistsTab()
		}

		okButton.addEventListener('click', () => void create())
		cancelButton.addEventListener('click', () => view.close())
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault()
				void create()
			}
		})
		input.focus()
	}

	/**
	 * 音乐库 › 播放列表 页签（阶段 6d）。
	 *
	 * ## 安卓端怎么做 → 桌面端怎么做
	 *
	 * 安卓端这个页签的内容是**歌单列表**（`LocalPlaylistList.tsx`）：
	 * 头部一行「播放列表 / N 个播放列表 / ＋菜单」，下面一个圆角搜索框，
	 * 然后是一列歌单；点一个进详情（有返回）。**页签的内容从来不是曲目表。**
	 *
	 * ⚠️ 桌面端原来错在这里：这个页签渲染的是"当前选中歌单的曲目表"，
	 * 而歌单列表挂在左栏 —— 于是用户点「播放列表」看到的是一堆歌曲，
	 * 想换个歌单得去左栏找；歌单的**新建入口则完全不存在**。
	 * 这正是用户说的「音乐库这里…应该是卡片样式展示歌单列表」和
	 * 「我没有看到任何新建本地歌单的按钮」。
	 *
	 * 保留 / 改变：
	 *   * **保留**：页签内容 = 歌单列表；头部标题 + 计数 + `＋` 菜单；
	 *     页内搜索；点卡片进详情。
	 *   * **改变（因宽屏）**：竖排单列 → **卡片网格**（`mediaCard`，
	 *     与安卓端「近期歌单」的卡是同一张）。理由见 components.css。
	 *   * **改变（桌面端没有的能力）**：安卓端 `＋` 菜单有 4 项，最后一项是
	 *     「动态合并歌单」。桌面端**没有**动态歌单（`type: 'dynamic'`）
	 *     的实现，所以只放 3 项 —— 不做一个点了没用的菜单项。
	 */
	async function showPlaylistsTab() {
		clear(els.content)
		window.bbUI?.showContent?.()

		let playlists = []
		try {
			playlists = await refreshPlaylists()
		} catch (error) {
			setStatus(error.message, 'bad')
			els.content.appendChild(
				window.bbComponents.empty({
					iconName: 'error',
					title: '读取歌单失败',
					hint: error.message,
				}),
			)
			return
		}

		// 空库：欢迎视图（带「导入示例合集」）比一张空网格有用得多
		if (playlists.length === 0) {
			renderWelcome()
			return
		}

		const head = document.createElement('div')
		head.className = 'view-head'
		const title = document.createElement('h2')
		title.textContent = '播放列表'
		head.appendChild(title)

		const actions = document.createElement('div')
		actions.className = 'view-head__actions'
		const count = document.createElement('span')
		count.className = 'muted'
		count.dataset.testid = 'playlist-tab-count'
		actions.appendChild(count)

		const addButton = document.createElement('button')
		addButton.className = 'icon-only icon-button'
		addButton.dataset.testid = 'playlist-new'
		addButton.title = '新建播放列表'
		addButton.setAttribute('aria-label', '新建播放列表')
		addButton.innerHTML = window.bbComponents.iconHtml('add', 'icon--md')
		addButton.addEventListener('click', () => {
			// ⚠️ 菜单项复用**已有的入口**，不另起一套：
			// 「导入」是音乐库自己的页签，「订阅共享歌单」是共享面板。
			window.bbComponents.menu(addButton, [
				{
					label: '新建播放列表',
					icon: 'add',
					testid: 'playlist-new-local',
					onSelect: () => openCreatePlaylistDialog(),
				},
				{
					label: '导入外部歌单',
					icon: 'playlist_add',
					testid: 'playlist-new-import',
					onSelect: () => window.bbUI?.setLibraryTab?.('import'),
				},
				{
					label: '订阅共享歌单',
					icon: 'group',
					testid: 'playlist-new-share',
					onSelect: () => window.bbUI?.openView?.('share'),
				},
			])
		})
		actions.appendChild(addButton)
		head.appendChild(actions)
		els.content.appendChild(head)

		const filter = document.createElement('div')
		filter.className = 'filter-field'
		const filterInput = document.createElement('input')
		filterInput.type = 'search'
		filterInput.placeholder = '搜索播放列表'
		filterInput.dataset.testid = 'playlist-filter'
		filterInput.spellcheck = false
		filterInput.setAttribute('aria-label', '搜索播放列表')
		filter.appendChild(filterInput)
		els.content.appendChild(filter)

		const grid = document.createElement('div')
		grid.className = 'media-grid'
		grid.dataset.testid = 'playlist-grid'
		els.content.appendChild(grid)

		const selectedId = window.bbState.get().selectedPlaylistId

		function render() {
			const keyword = filterInput.value.trim().toLowerCase()
			const shown = playlists.filter((playlist) =>
				keyword
					? String(playlist.title ?? '')
							.toLowerCase()
							.includes(keyword)
					: true,
			)
			count.textContent = `${playlists.length} 个播放列表`
			clear(grid)
			if (shown.length === 0) {
				grid.appendChild(
					window.bbComponents.empty({
						testid: 'playlist-grid-empty',
						iconName: 'search_off',
						title: `没有与「${filterInput.value.trim()}」匹配的播放列表`,
						hint: '换个关键词试试。',
					}),
				)
				return
			}
			for (const playlist of shown) {
				grid.appendChild(
					window.bbComponents.mediaCard({
						title: playlist.title,
						sub: `${playlist.item_count ?? 0} 首`,
						coverUrl: playlist.cover_url ?? null,
						badges: playlistBadges(playlist),
						testid: `playlist-card-${playlist.id}`,
						active: playlist.id === selectedId,
						onClick: () => void openPlaylist(playlist.id),
					}),
				)
			}
		}

		filterInput.addEventListener('input', render)
		render()
	}

	/**
	 * 音乐库 › 合集 页签（阶段 2b）。
	 *
	 * 读某个 UP 的公开合集列表，一行一个，点「导入」变成本地歌单。
	 * 默认读**登录用户自己**的合集（登录了就用自己的，否则用示例 UP）——
	 * 这是"合集"这个页签最自然的默认值。
	 */
	async function showCollectionTab() {
		clear(els.content)
		window.bbUI?.showContent?.()

		// ⚠️ 这里**不再**自己渲染一个「合集」标题：页面大标题写的是目的地
		//（音乐库），页签写的是「合集」，再来一个同名 h2 就是三重重复。
		// 直接进工具条。

		// 工具条：UP 的 UID + 读取
		const bar = document.createElement('div')
		bar.className = 'row-actions'

		const label = document.createElement('label')
		label.className = 'visually-hidden'
		label.setAttribute('for', 'collection-mid')
		label.textContent = 'UP 的 UID'
		bar.appendChild(label)

		const midInput = document.createElement('input')
		midInput.id = 'collection-mid'
		midInput.dataset.testid = 'collection-mid'
		midInput.type = 'text'
		midInput.inputMode = 'numeric'
		midInput.placeholder = 'UP 的 UID'
		midInput.spellcheck = false
		bar.appendChild(midInput)

		const load = document.createElement('button')
		load.id = 'collection-load'
		load.dataset.testid = 'collection-load'
		load.className = 'btn--filled'
		load.textContent = '读取合集'
		bar.appendChild(load)

		const list = document.createElement('div')
		list.dataset.testid = 'collection-list'

		/** 拉取并渲染某个 UP 的合集 */
		async function loadSeasons(mid) {
			clear(list)
			list.appendChild(
				window.bbComponents.empty({
					iconName: 'hourglass_empty',
					title: '正在读取合集…',
				}),
			)
			try {
				const seasons = unwrap(
					await window.bbplayer.userSeasons(mid),
					'读取合集',
				)
				clear(list)
				if (seasons.length === 0) {
					list.appendChild(
						window.bbComponents.empty({
							iconName: 'video_library',
							title: '这个 UP 没有公开合集',
							hint: '换个 UID 试试，或者用「导入」页签从别处导入歌单。',
						}),
					)
					return
				}
				for (const season of seasons) {
					const importButton = document.createElement('button')
					importButton.className = 'btn--tonal'
					importButton.dataset.testid = `season-import-${season.seasonId}`
					importButton.textContent = '导入'
					importButton.addEventListener('click', () => {
						void importSeason(mid, season, importButton)
					})
					list.appendChild(
						window.bbComponents.listRow({
							title: season.title,
							sub: `${season.total ?? 0} 个视频`,
							coverUrl: season.cover ?? null,
							trailing: [importButton],
							testid: `season-${season.seasonId}`,
						}),
					)
				}
				setStatus(`读到 ${seasons.length} 个合集`, 'ok')
			} catch (error) {
				clear(list)
				list.appendChild(
					window.bbComponents.empty({
						iconName: 'error',
						title: '读取失败',
						hint: error.message,
					}),
				)
				setStatus(error.message, 'bad')
			}
		}

		async function importSeason(mid, season, button) {
			button.disabled = true
			button.textContent = '导入中…'
			setStatus(`正在导入「${season.title}」…`, 'busy')
			try {
				const result = unwrap(
					await window.bbplayer.importSeasonToPlaylist({
						mid,
						seasonId: season.seasonId,
						title: season.title,
					}),
					'导入合集',
				)
				await refreshPlaylists()
				setStatus(
					`已导入 ${result.added}/${result.total} 首`,
					result.failures.length > 0 ? 'busy' : 'ok',
				)
			} catch (error) {
				setStatus(error.message, 'bad')
			} finally {
				button.disabled = false
				button.textContent = '导入'
			}
		}

		load.addEventListener('click', () => {
			const mid = midInput.value.trim()
			if (!/^\d+$/.test(mid)) {
				setStatus('UID 应该是纯数字', 'bad')
				return
			}
			void loadSeasons(mid)
		})

		els.content.appendChild(bar)
		els.content.appendChild(list)

		// 默认值：登录用户自己的 UID（拿不到就用示例 UP，保证页签不是空的）
		let mid = String(DEMO_MID)
		try {
			const status = unwrap(await window.bbplayer.loginStatus(), '读取登录状态')
			if (status?.user?.mid) mid = String(status.user.mid)
		} catch {
			// 读不到登录状态不影响用示例 UP
		}
		midInput.value = mid
		await loadSeasons(mid)
	}

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
		/**
		 * 音乐库的「合集」页签（阶段 2b）。
		 *
		 * ⚠️ 原来「合集」是一个**一级导航目的地**，点开却只是一张空表格
		 * （`renderTrackTable([], { title: '合集' })`）—— 用户点进去什么都看不到，
		 * 而真正能用的"导入公开合集"藏在空库的欢迎视图里。
		 *
		 * 现在它是一张**真的能用的页面**：读某个 UP 的公开合集列表，
		 * 一行一个（组件层的 .list-row），点「导入」把它变成一个本地歌单。
		 * 默认读登录用户自己的合集，没登录就退回示例 UP。
		 */
		showCollectionTab,
		/**
		 * 音乐库 › 播放列表（阶段 6d）：**歌单列表**（卡片网格），
		 * 不是"当前歌单的曲目表"。点卡片才进曲目表。
		 */
		showPlaylistsTab,
		openCreatePlaylistDialog,
		/** 歌单卡片上的状态图标（主页的「最近更新」用同一套判断） */
		playlistBadges,
		openPlaylist,
		runSearch,
		renderTrackTable,
		renderPlaylists,
		renderWelcome,
		/**
		 * 切到「搜索」目的地时渲染什么。
		 *
		 * 搜索页要有"还没搜"的状态（而不是留着上一个视图的残影），
		 * 同时不能把已经搜出来的结果擦掉 —— 用户点左栏再点回来时
		 * 期待结果还在。
		 */
		renderWelcomeOrLast() {
			const tracks = window.bbState.get().tracks ?? []
			const lastQuery = window.bbState.get().lastQuery
			if (lastQuery && tracks.length > 0) {
				renderTrackTable(tracks, {
					title: `搜索：${lastQuery}`,
					query: lastQuery,
				})
				return
			}
			renderWelcome()
		},
		importDemoCollection,
		/** 共享：左栏歌单行的「分享 / 同步」（Phase 3.4） */
		sharePlaylist,
		/** 共享：从当前歌单移除一首曲目（Phase 3.4） */
		removeTrackFromPlaylist,
		getTracks: () => window.bbState.get().tracks,
	}
})()
