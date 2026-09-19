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

	function renderTrackTable(tracks, { title, query } = {}) {
		clear(els.content)
		// 共享视图是常驻节点，从它切回来（例如直接搜索、点左栏歌单）时要显式让位
		window.bbUI?.showContent?.()

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

		const removal = removalContext(tracks.length)
		if (removal.readOnly) {
			const note = document.createElement('p')
			note.className = 'muted share-hint'
			note.dataset.testid = 'playlist-readonly-note'
			note.textContent =
				'这是订阅来的共享歌单（只读）：可以播放与同步，但不能增删曲目。'
			els.content.appendChild(note)
		}

		if (tracks.length === 0) {
			els.content.appendChild(
				window.bbComponents.empty({
					testid: 'content-empty',
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
		els.content.appendChild(actions)

		const table = document.createElement('table')
		table.className = 'track-table'
		table.dataset.testid = 'track-table'

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
			if (window.bbPlayer.getCurrent()?.bvid === track.bvid) {
				tr.classList.add('is-playing')
			}

			// 序号
			const indexCell = document.createElement('td')
			indexCell.className = 'col-index'
			indexCell.textContent = String(index + 1)
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
			const actionsCell = document.createElement('td')
			actionsCell.className = 'col-actions'

			const playNextButton = document.createElement('button')
			playNextButton.className = 'track-action'
			playNextButton.dataset.testid = `track-play-next-${index}`
			playNextButton.dataset.action = 'play-next'
			playNextButton.innerHTML = window.bbComponents.iconHtml(
				// ⚠️ 是 `queue_play_next`，**不是** `play_next` —— Material Symbols 里
				// 没有后者。名字写错时 Google Fonts **不报错**，只是把那个图标从
				// 子集里悄悄去掉；于是合字不生效，界面渲染出字面的 "play_next"
				// 九个字母（实测 144px 宽）压在时长列上。
				// 现在 build-icon-font.mjs 会逐个校验名字，见那里的注释。
				'queue_play_next',
				'icon--sm',
			)
			playNextButton.title = '下一首播放'
			playNextButton.setAttribute('aria-label', '下一首播放')
			playNextButton.addEventListener('click', (event) => {
				event.stopPropagation()
				const result = window.bbPlayer.playNextInsert(track)
				setStatus(
					result.ok ? `「${track.title}」将在下一首播放` : '没能加入队列',
					result.ok ? 'ok' : 'bad',
				)
			})
			actionsCell.appendChild(playNextButton)

			if (removal.canRemove) {
				const remove = document.createElement('button')
				remove.className = 'track-action track-action--danger'
				remove.dataset.testid = `track-remove-${index}`
				remove.dataset.action = 'remove'
				remove.innerHTML = window.bbComponents.iconHtml('delete', 'icon--sm')
				remove.title = '从这个歌单移除这首曲目'
				remove.setAttribute('aria-label', '从歌单移除')
				remove.addEventListener('click', (event) => {
					// 不要让单击冒泡到行的「选中」逻辑上
					event.stopPropagation()
					void removeTrackFromPlaylist(track, remove)
				})
				actionsCell.appendChild(remove)
			}

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

	/**
	 * 从当前歌单移除一首曲目（Phase 3.4）。
	 *
	 * 走 `window.bbplayer.playlist.removeTrack`：主进程删行之后会把删除写进
	 * 共享 outbox 并在后台推给协作者，所以这里**不需要**自己调 `share.sync`。
	 *
	 * 只读角色（`share_role === 'subscriber'`）在 `removalContext` 里就已经
	 * 被挡掉了，所以这个函数只可能在可写歌单上被调用。
	 */
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
