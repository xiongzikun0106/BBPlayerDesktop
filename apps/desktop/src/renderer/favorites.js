/**
 * 收藏夹视图（Phase 3）。
 *
 * ## 关键事实（实测，见 docs/DESKTOP_PLAN.md §3）
 *
 * `fav/folder/created/list-all` 与 `fav/resource/list` **匿名可读**，
 * 只要知道 UP 的 `mid`。所以：
 *   * 输入任意 UP 的 `mid` 就能列出并导入其**公开**收藏夹，无需登录；
 *   * 登录状态下，接口才会把自己的**私密**收藏夹一并返回
 *     （`attr !== 0`），因此这里也支持「用我的 UID」一键填入。
 *
 * ## 与「合集」的区别
 *
 * * **合集**（`seasons_series_list`）是 UP 自己组织的、有明确顺序的系列；
 * * **收藏夹**（`fav/folder`）是用户对任意视频的收藏，可以是别人的视频。
 *
 * 两者都是「远端歌单」，但接口不同、ID 空间不同，因此在 `db.cjs` 里用
 * `remote_sync_id` 的**命名空间**区分，避免 id 撞车互相认领。
 */
;(function () {
	'use strict'

	const els = {
		content: document.getElementById('content'),
		midInput: document.getElementById('favorite-mid'),
		useMine: document.getElementById('favorite-use-mine'),
		load: document.getElementById('favorite-load'),
		status: document.getElementById('favorite-status'),
	}

	const setStatus = (text, kind) => {
		if (!els.status) return
		els.status.textContent = text ?? ''
		els.status.className = `status status--${kind || 'idle'}`
	}

	function unwrap(result, what) {
		if (!result || result.ok !== true) {
			throw new Error(`${what}失败：${result?.error ?? '未知错误'}`)
		}
		return result.data
	}

	// ---------------------------------------------------------------
	// 渲染
	// ---------------------------------------------------------------

	/** 折叠/展开的曲目预览缓存：mediaId -> items */
	const resourceCache = new Map()

	/*
	 * 关于 UID 工具条（`#favorite-bar`）的位置：
	 *
	 * 它原本是 `#content` 的**兄弟节点**、排在内容区下面，于是提示写着
	 * "填入任意 B 站用户的 UID" 而输入框在整屏之外的底边 ——
	 * 这是截图巡检时**看**出来的（布局体检抓不到：不越界也不塌陷，
	 * 只是位置不合理）。
	 *
	 * 修法是在 **index.html 里把它挪到「页签条」与「内容区」之间**：
	 *   * 位置对了（就在收藏夹标题与提示的上方几像素处）；
	 *   * 它是**永久节点**，不会被 `#content` 的每次重渲染清掉 ——
	 *     一开始试过"在渲染时把它 append 进 #content"，结果点一次
	 *     文件夹预览就把 `#favorite-status` 连带清掉了，状态文案写不进去
	 *     （由 login 探针的「收藏夹导入为本地歌单成功」抓到）。
	 */
	function renderFolders(folders, mid) {
		const content = els.content
		if (!content) return
		content.textContent = ''

		const head = document.createElement('div')
		head.className = 'view-head'
		const h2 = document.createElement('h2')
		h2.textContent = '收藏夹'
		head.appendChild(h2)

		const right = document.createElement('div')
		right.className = 'view-head__actions'
		const meta = document.createElement('span')
		meta.className = 'muted'
		meta.dataset.testid = 'favorites-meta'
		meta.textContent = `UID ${mid} · ${folders.length} 个`
		right.appendChild(meta)

		/*
		 * 手动刷新。
		 *
		 * ⚠️ 有了这个按钮，切回页签就**不必**重新联网拉一次 —— `show()` 会直接用
		 * 缓存渲染（秒开、且不再重复弹「读到 N 个收藏夹」）。数据要更新时按这里，
		 * 那是用户主动的动作，所以刷完**照样告诉他结果**。
		 */
		const refresh = document.createElement('button')
		refresh.className = 'icon-only icon-button'
		refresh.dataset.testid = 'favorites-refresh'
		refresh.title = '重新读取'
		refresh.setAttribute('aria-label', '重新读取收藏夹')
		refresh.innerHTML = window.bbComponents.iconHtml('refresh', 'icon--md')
		refresh.addEventListener('click', () => {
			void loadFolders(String(mid), { force: true, button: refresh })
		})
		right.appendChild(refresh)
		head.appendChild(right)
		content.appendChild(head)

		if (folders.length === 0) {
			content.appendChild(
				window.bbComponents.empty({
					testid: 'favorites-empty',
					iconName: 'star',
					title: '没有读到收藏夹',
					hint: '确认这个用户有收藏夹的话，可能是**私密收藏夹** —— 需要先登录 B 站账号。',
				}),
			)
			return
		}

		const list = document.createElement('ul')
		list.className = 'favorite-list'
		list.dataset.testid = 'favorite-list'

		for (const folder of folders) {
			const item = document.createElement('li')
			item.className = 'favorite-list__item'
			item.dataset.testid = `favorite-${folder.mediaId}`
			item.dataset.mediaId = String(folder.mediaId)

			const main = document.createElement('div')
			main.className = 'favorite-list__main'

			const title = document.createElement('div')
			title.className = 'favorite-list__title'
			title.textContent = folder.title
			main.appendChild(title)

			const sub = document.createElement('div')
			sub.className = 'favorite-list__sub muted'
			const badges = [`${folder.mediaCount} 个视频`]
			if (folder.isPrivate) badges.push('私密')
			sub.textContent = badges.join(' · ')
			main.appendChild(sub)

			item.appendChild(main)

			const actions = document.createElement('div')
			actions.className = 'favorite-list__actions'

			const preview = document.createElement('button')
			preview.dataset.testid = `favorite-preview-${folder.mediaId}`
			preview.textContent = '预览'
			preview.addEventListener(
				'click',
				() => void togglePreview(folder, item, preview),
			)
			actions.appendChild(preview)

			const sync = document.createElement('button')
			sync.dataset.testid = `favorite-sync-${folder.mediaId}`
			sync.textContent = '导入为歌单'
			sync.addEventListener('click', () => void syncFolder(folder, sync))
			actions.appendChild(sync)

			item.appendChild(actions)

			// 预览容器（懒加载）
			const previewBox = document.createElement('div')
			previewBox.className = 'favorite-list__preview'
			previewBox.dataset.testid = `favorite-preview-box-${folder.mediaId}`
			previewBox.hidden = true
			item.appendChild(previewBox)

			list.appendChild(item)
		}

		content.appendChild(list)
	}

	async function togglePreview(folder, item, button) {
		const box = item.querySelector('.favorite-list__preview')
		if (!box) return

		if (!box.hidden) {
			box.hidden = true
			button.textContent = '预览'
			return
		}

		box.hidden = false
		button.textContent = '收起'

		let items = resourceCache.get(folder.mediaId)
		if (!items) {
			box.textContent = '加载中…'
			try {
				items = unwrap(
					await window.bbplayer.favoriteResources(folder.mediaId),
					'读取收藏夹内容',
				)
				resourceCache.set(folder.mediaId, items)
			} catch (error) {
				box.textContent = error.message
				return
			}
		}

		box.textContent = ''
		if (items.length === 0) {
			const p = document.createElement('p')
			p.className = 'muted'
			p.textContent = '没有可播放的条目（可能全是已失效视频）。'
			box.appendChild(p)
			return
		}

		const table = document.createElement('table')
		table.className = 'track-table'
		table.dataset.testid = `favorite-table-${folder.mediaId}`
		const tbody = document.createElement('tbody')
		for (const [index, entry] of items.slice(0, 50).entries()) {
			const tr = document.createElement('tr')
			for (const [text, cls] of [
				[String(index + 1), 'col-index'],
				[entry.title || '(无标题)', 'col-title'],
				// 与 library.js 的曲目表一样同时认两套字段名
				[
					entry.upperName || entry.artist || entry.artist_name || '—',
					'col-artist',
				],
				[window.bbPlayer.formatTime(entry.duration), 'col-duration'],
			]) {
				const td = document.createElement('td')
				td.className = cls
				td.textContent = text
				td.title = text
				tr.appendChild(td)
			}
			tbody.appendChild(tr)
		}
		table.appendChild(tbody)
		box.appendChild(table)

		if (items.length > 50) {
			const more = document.createElement('p')
			more.className = 'muted'
			more.textContent = `仅预览前 50 条（共 ${items.length} 条）`
			box.appendChild(more)
		}
	}

	async function syncFolder(folder, button) {
		const original = button.textContent
		button.disabled = true
		button.textContent = '导入中…'
		setStatus(`正在导入「${folder.title}」…`, 'busy')

		try {
			const data = unwrap(
				await window.bbplayer.syncFavoriteToPlaylist({
					mediaId: folder.mediaId,
					title: folder.title,
					cover: folder.cover,
					maxItems: 200,
				}),
				'导入收藏夹',
			)

			await window.bbLibrary.refreshPlaylists()
			await window.bbLibrary.openPlaylist(data.playlistId)

			const failureNote =
				data.failures.length > 0
					? `，${data.failures.length} 条失败（多为已失效视频）`
					: ''
			setStatus(
				`已导入「${data.title}」：新增 ${data.added}，跳过 ${data.skipped}，共 ${data.itemCount} 首${failureNote}`,
				data.failures.length > 0 ? 'busy' : 'ok',
			)
		} catch (error) {
			setStatus(error.message, 'bad')
		} finally {
			button.disabled = false
			button.textContent = original
		}
	}

	// ---------------------------------------------------------------
	// 加载
	// ---------------------------------------------------------------

	/*
	 * 收藏夹列表的缓存。
	 *
	 * ⚠️ 为什么要有：`show()` 每次切回「收藏夹」页签都会走到 `loadFolders`。
	 * 原来是**无条件重新联网**拉一遍，并再弹一次「正在读取…」→「读到 N 个收藏夹」。
	 * 数据没变，用户却每次都要等网络、还要再看一遍同一条提示。
	 *
	 * 现在：同一个 UID 命中缓存就直接渲染（秒开、**完全不碰状态胶囊**）；
	 * 想更新时按页头那个刷新按钮（`force`）。
	 */
	let foldersCache = null
	let cacheMid = null
	/** 已经"报过数量"的 UID —— 同一个 UID 只报一次，换了人或主动刷新才再报 */
	let announcedMid = null

	async function loadFolders(mid, { force = false, button = null } = {}) {
		if (!mid) {
			setStatus('请填写 UID', 'bad')
			return []
		}

		const key = String(mid)
		if (!force && foldersCache && cacheMid === key) {
			// 缓存命中：只重画界面，不联网、不提示
			renderFolders(foldersCache, mid)
			return foldersCache
		}

		if (button) button.disabled = true
		setStatus(`正在读取 UID ${mid} 的收藏夹…`, 'busy')
		try {
			const folders = unwrap(
				await window.bbplayer.favoriteFolders(mid),
				'读取收藏夹列表',
			)
			resourceCache.clear()
			foldersCache = folders
			cacheMid = key
			renderFolders(folders, mid)

			// 同一个 UID **只报一次**：切回页签不该再弹一遍。
			// 换了 UID、或用户自己点了刷新，才报（那时数字是新信息）。
			if (announcedMid !== key || force) {
				announcedMid = key
				const privateCount = folders.filter((f) => f.isPrivate).length
				setStatus(
					`读到 ${folders.length} 个收藏夹${privateCount > 0 ? `（含 ${privateCount} 个私密）` : ''}`,
					'ok',
				)
			}
			return folders
		} catch (error) {
			setStatus(error.message, 'bad')
			return []
		} finally {
			if (button?.isConnected) button.disabled = false
		}
	}

	/** 主入口：切到收藏夹视图 */
	async function show() {
		const content = els.content
		if (!content) return

		// 已登录则预填自己的 UID，省一步输入
		let mid = els.midInput?.value?.trim() ?? ''
		if (!mid) {
			try {
				const status = unwrap(await window.bbplayer.loginStatus(), '读取登录态')
				if (status?.user?.mid) {
					mid = String(status.user.mid)
					if (els.midInput) els.midInput.value = mid
				}
			} catch {
				// 拿不到登录态就留空，走手填
			}
		}

		if (mid) {
			await loadFolders(mid)
			return
		}

		// 无 UID：给一个示例（B 站官方 UP，公开收藏夹实测可读）
		content.textContent = ''
		const head = document.createElement('div')
		head.className = 'view-head'
		const h2 = document.createElement('h2')
		h2.textContent = '收藏夹'
		head.appendChild(h2)
		content.appendChild(head)

		const intro = document.createElement('p')
		intro.className = 'muted'
		intro.style.marginBottom = '16px'
		intro.textContent =
			'填入任意 B 站用户的 UID 即可读取其公开收藏夹（无需登录）。登录后还能读到自己的私密收藏夹。'
		content.appendChild(intro)

		/*
		 * ⚠️ UID 工具条要**紧贴提示**，不能留在页面最底部。
		 *
		 * `#favorite-bar` 原本是 `#content` 的**兄弟节点**（历史结构），
		 * 于是提示写着"填入任意 B 站用户的 UID"，而输入框在整屏之外的底边 ——
		 * 用户得自己去找。这是截图巡检时**看**出来的：
		 * 布局体检抓不到它（不越界、不塌陷，只是位置不合理）。
		 *
		 * 现在把它搬进 `#content`。用**搬运**而不是复制 —— `#favorite-bar`
		 * 只有一份，探针按 id 找不会找到两个。别的视图渲染时会
		 * `clear(#content)` 把它一起带走，切回本页签时这里会重新挂上。
		 */

		const actions = document.createElement('div')
		actions.className = 'row-actions'
		const demo = document.createElement('button')
		demo.dataset.testid = 'favorite-load-demo'
		demo.textContent = '加载示例（UID 8047632）'
		demo.addEventListener('click', () => {
			if (els.midInput) els.midInput.value = '8047632'
			void loadFolders('8047632')
		})
		actions.appendChild(demo)
		content.appendChild(actions)
	}

	if (els.load) {
		els.load.addEventListener(
			'click',
			() => void loadFolders(els.midInput?.value?.trim()),
		)
	}
	if (els.midInput) {
		els.midInput.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') void loadFolders(els.midInput.value.trim())
		})
	}
	if (els.useMine) {
		els.useMine.addEventListener('click', () => {
			void (async () => {
				try {
					const status = unwrap(
						await window.bbplayer.loginStatus(),
						'读取登录态',
					)
					if (!status?.user?.mid) {
						setStatus('尚未登录，无法使用「我的 UID」', 'bad')
						return
					}
					const mid = String(status.user.mid)
					if (els.midInput) els.midInput.value = mid
					await loadFolders(mid)
				} catch (error) {
					setStatus(error.message, 'bad')
				}
			})()
		})
	}

	window.bbFavorites = {
		show,
		loadFolders,
		syncFolder,
		renderFolders,
		/** 供自动化断言 */
		getFolders: () =>
			Array.from(document.querySelectorAll('.favorite-list__item')).map(
				(item) => ({
					mediaId: Number(item.dataset.mediaId),
					title: item.querySelector('.favorite-list__title')?.textContent,
				}),
			),
	}
})()
