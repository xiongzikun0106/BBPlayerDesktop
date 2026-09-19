/**
 * 组件工具（阶段 1c）。
 *
 * 与 `components.css` 配套：CSS 定义外观，这里负责**按同样的结构生成 DOM**，
 * 免得每个面板又各自拼一套。
 *
 * 暴露 `window.bbComponents` 供面板使用，也供探针断言"用的是组件而不是手搓的"。
 */
;(function () {
	'use strict'

	/**
	 * 生成 Material Symbols 图标。
	 *
	 * 名字是字体的**合字**，所以 HTML 里写的是 `library_music` 这样的语义名字，
	 * 而不是一个看不出含义的符号。字体见 `scripts/build-icon-font.mjs`。
	 */
	function icon(name, extraClass = '') {
		const span = document.createElement('span')
		span.className = extraClass ? `icon ${extraClass}` : 'icon'
		span.textContent = name
		return span
	}

	/** HTML 字符串版本（面板里常有 innerHTML 的写法） */
	function iconHtml(name, extraClass = '') {
		return `<span class="icon${extraClass ? ` ${extraClass}` : ''}">${name}</span>`
	}

	/**
	 * 按名字算一个稳定的色相（0–359）。
	 *
	 * 收藏夹没有封面，移动端的做法是**首字 + 渐变底色**。颜色必须**稳定**：
	 * 同一个歌单每次打开都得是同一个颜色，否则用户会以为歌单变了。
	 * 所以用名字做哈希，而不是随机。
	 *
	 * 用 FNV-1a 而不是简单的 `charCodeAt` 求和：求和会让「abc」与「cba」
	 * 撞成同一个颜色，而中文标题里字序变化很常见。
	 */
	function hueOf(text) {
		let hash = 0x811c9dc5
		const value = String(text ?? '')
		for (let i = 0; i < value.length; i++) {
			hash ^= value.codePointAt(i)
			hash = Math.imul(hash, 0x01000193)
		}
		return Math.abs(hash) % 360
	}

	/**
	 * 封面位：有封面用封面，否则用**首字 + 渐变**。
	 *
	 * @param {object} input
	 * @param {string} [input.title]
	 * @param {string|null} [input.coverUrl]
	 * @param {string} [input.iconName]
	 * @param {keyof HTMLElementTagNameMap} [input.tag] 默认 `div`；
	 *   卡片是 `<button>`，里面只能放**短语内容**，所以那里要传 `span`
	 * @param {string} [input.extraClass]
	 */
	function art({
		title,
		coverUrl,
		iconName,
		tag = 'div',
		extraClass = '',
	} = {}) {
		const box = document.createElement(tag)
		box.className = extraClass ? `list-row__art ${extraClass}` : 'list-row__art'

		if (coverUrl) {
			const img = document.createElement('img')
			img.src = coverUrl
			img.alt = ''
			img.loading = 'lazy'
			// 封面加载失败时**退回首字**，而不是留一个破图图标
			img.addEventListener('error', () => {
				box.textContent = ''
				box.classList.remove('list-row__art--plain')
				renderInitial(box, title, iconName)
			})
			box.appendChild(img)
			return box
		}

		renderInitial(box, title, iconName)
		return box
	}

	function renderInitial(box, title, iconName) {
		const text = String(title ?? '').trim()
		if (!text && !iconName) {
			box.classList.add('list-row__art--plain')
			box.appendChild(icon('album', 'icon--md'))
			return
		}
		box.style.setProperty('--art-hue', String(hueOf(text || iconName)))
		// 首字：中文取第一个字，英文取首字母大写 —— 与移动端一致
		//
		// ⚠️ 这里**故意**用 `[...text][0]` 而不是 `text[0]`：展开按**码点**切分，
		// emoji / 增补平面字符会被完整取到，而 `text[0]` 只取半个代理对
		// （界面上是"半个乱码字"）。lint 的 no-misused-spread 建议改用
		// `Intl.Segmenter` 做字素簇切分 —— 对"歌单名首字"这个用途是过度设计，
		// 所以**就地豁免并写明理由**，而不是关掉整条规则。
		// oxlint-disable-next-line typescript/no-misused-spread
		box.textContent = text ? [...text][0].toUpperCase() : ''
		if (!text) box.appendChild(icon(iconName, 'icon--md'))
	}

	/**
	 * 列表行。
	 *
	 * @param {object} options
	 * @param {string} [options.title]
	 * @param {string} [options.sub]
	 * @param {string|null} [options.coverUrl]
	 * @param {HTMLElement[]} [options.trailing]
	 * @param {string} [options.testid]
	 * @param {boolean} [options.active]
	 * @param {() => void} [options.onClick]
	 * @param {keyof HTMLElementTagNameMap} [options.tag] 默认 `div`
	 */
	function listRow({
		title,
		sub,
		coverUrl = null,
		trailing = [],
		testid,
		active = false,
		onClick,
		tag = 'div',
	} = {}) {
		const row = document.createElement(tag)
		row.className = 'list-row'
		if (active) row.classList.add('is-active')
		if (testid) row.dataset.testid = testid
		if (onClick) row.addEventListener('click', onClick)

		row.appendChild(art({ title, coverUrl }))

		const main = document.createElement('div')
		main.className = 'list-row__main'
		const titleNode = document.createElement('div')
		titleNode.className = 'list-row__title'
		titleNode.textContent = title ?? ''
		main.appendChild(titleNode)
		if (sub) {
			const subNode = document.createElement('div')
			subNode.className = 'list-row__sub'
			subNode.textContent = sub
			main.appendChild(subNode)
		}
		row.appendChild(main)

		if (trailing.length > 0) {
			const box = document.createElement('div')
			box.className = 'list-row__trailing'
			for (const node of trailing) box.appendChild(node)
			row.appendChild(box)
		}

		return row
	}

	/**
	 * 媒体卡（阶段 6d）。
	 *
	 * 安卓端「近期歌单」的单条目就是这张卡（`index.tsx:549-586` 的
	 * `playlistCard`）：`surfaceVariant` 底 + 圆角 12 + **1:1 封面** +
	 * 标题（最多 2 行）+ 副标题「N 首」。音乐库 › 播放列表的卡片网格
	 * 用的是同一张卡 —— 同一个东西在两处必须是同一套样式。
	 *
	 * ⚠️ 外层是 `<button>`，所以内部**只能用短语内容**（`span`），
	 * 不能放 `div` —— 见 components.css 里 `.list-row__main` 那条注释
	 * （设置分类行踩过同一个坑）。
	 *
	 * @param {object} options
	 * @param {string} [options.title]
	 * @param {string} [options.sub]
	 * @param {string|null} [options.coverUrl]
	 * @param {string[]} [options.badges] 副标题旁的**状态图标名**（如 `group`）
	 * @param {string} [options.testid]
	 * @param {boolean} [options.active]
	 * @param {() => void} [options.onClick]
	 */
	function mediaCard({
		title,
		sub,
		coverUrl = null,
		badges = [],
		testid,
		active = false,
		onClick,
	} = {}) {
		const card = document.createElement('button')
		card.className = 'media-card'
		if (active) card.classList.add('is-active')
		if (testid) card.dataset.testid = testid
		if (onClick) card.addEventListener('click', onClick)

		card.appendChild(
			art({ title, coverUrl, tag: 'span', extraClass: 'list-row__art--card' }),
		)

		const titleNode = document.createElement('span')
		titleNode.className = 'media-card__title'
		titleNode.textContent = title ?? ''
		card.appendChild(titleNode)

		const subNode = document.createElement('span')
		subNode.className = 'media-card__sub'
		const subText = document.createElement('span')
		subText.textContent = sub ?? ''
		subNode.appendChild(subText)
		for (const name of badges) subNode.appendChild(icon(name))
		card.appendChild(subNode)

		return card
	}

	/**
	 * 空状态：淡图标 + 标题 + 一句说明 +（可选）动作。
	 *
	 * @param {object} options
	 * @param {string} options.title
	 * @param {string} [options.hint]
	 * @param {string} [options.iconName]
	 * @param {HTMLElement[]} [options.actions]
	 * @param {string} [options.testid]
	 */
	function empty({
		title,
		hint,
		iconName = 'library_music',
		actions = [],
		testid,
	} = {}) {
		const box = document.createElement('div')
		box.className = 'empty'
		if (testid) box.dataset.testid = testid

		box.appendChild(icon(iconName))
		const heading = document.createElement('div')
		heading.className = 'empty__title'
		heading.textContent = title ?? ''
		box.appendChild(heading)

		if (hint) {
			const line = document.createElement('div')
			line.className = 'empty__hint'
			line.textContent = hint
			box.appendChild(line)
		}

		if (actions.length > 0) {
			const row = document.createElement('div')
			row.className = 'row-actions'
			for (const node of actions) row.appendChild(node)
			box.appendChild(row)
		}

		return box
	}

	/**
	 * 短暂提示（M3 snackbar）。
	 *
	 * 只用于**成功/中性**的短反馈。错误与需要用户处理的信息仍然留在原地
	 * （内联状态行）—— 会自己消失的提示不适合承载"你需要做点什么"。
	 */
	let toastHost = null
	function ensureToastHost() {
		if (toastHost && document.body.contains(toastHost)) return toastHost
		toastHost = document.createElement('div')
		toastHost.className = 'toast-host'
		toastHost.dataset.testid = 'toast-host'
		document.body.appendChild(toastHost)
		return toastHost
	}

	function toast(message, { kind = 'ok', timeout = 4000 } = {}) {
		const host = ensureToastHost()
		const node = document.createElement('div')
		node.className = kind === 'bad' ? 'toast toast--bad' : 'toast'
		node.dataset.testid = 'toast'
		node.appendChild(icon(kind === 'bad' ? 'error' : 'check_circle'))
		const text = document.createElement('span')
		text.textContent = message
		node.appendChild(text)
		host.appendChild(node)

		const remove = () => {
			node.classList.add('is-leaving')
			setTimeout(() => node.remove(), 250)
		}
		const timer = setTimeout(remove, timeout)
		// 点掉也算关闭（别让用户等 4 秒）
		node.style.pointerEvents = 'auto'
		node.addEventListener('click', () => {
			clearTimeout(timer)
			remove()
		})

		return node
	}

	/**
	 * 锚定在某个元素上的**弹出菜单**（阶段 6c）。
	 *
	 * 安卓端曲目行右侧那个「⋮」点开的就是这个：一个挨着按钮弹出的短菜单，
	 * 而不是把两个图标并排摊在行里。
	 *
	 * 为什么并排图标不好（用户复审时点名了）：
	 *   * 每多一个操作就多一个图标，列会越来越宽、越来越吵；
	 *   * 行里放不下之后只能把低频操作藏起来，而"藏哪了"又成了新问题；
	 *   * 危险操作（删除）与高频操作（下一首）并排，很容易点错。
	 *
	 * 菜单项结构（与安卓端 `TrackMenuItem` 对齐）：
	 *   `{ label, icon, danger, testid, onSelect }`
	 *
	 * ⚠️ 关闭时机有三条，缺一条都会"菜单关不掉"：
	 *   1. 选中某一项之后；
	 *   2. 点菜单外面（用一次性的 `pointerdown` 捕获监听）；
	 *   3. 按 Esc。
	 *
	 * ⚠️ 同一时刻**只允许一个**菜单：新菜单打开前先关掉旧的，
	 * 否则连点几个「…」会叠出好几层。
	 */
	let openMenu = null

	function closeMenu() {
		if (!openMenu) return
		openMenu.remove()
		openMenu = null
		document.removeEventListener('pointerdown', onMenuOutside, true)
		document.removeEventListener('keydown', onMenuKey, true)
	}

	function onMenuOutside(event) {
		if (openMenu && !openMenu.contains(event.target)) closeMenu()
	}

	function onMenuKey(event) {
		if (event.key === 'Escape') {
			event.stopPropagation()
			closeMenu()
		}
	}

	function menu(anchor, items) {
		if (!anchor) return null
		closeMenu()
		const list = (items ?? []).filter(Boolean)
		if (list.length === 0) return null

		const box = document.createElement('div')
		box.className = 'menu'
		box.dataset.testid = 'track-menu'

		for (const item of list) {
			const button = document.createElement('button')
			button.className = 'menu__item'
			if (item.danger) button.classList.add('menu__item--danger')
			if (item.testid) button.dataset.testid = item.testid
			if (item.icon) button.appendChild(icon(item.icon, 'icon--sm'))
			const label = document.createElement('span')
			label.textContent = item.label
			button.appendChild(label)
			button.addEventListener('click', (event) => {
				event.stopPropagation()
				closeMenu()
				item.onSelect?.()
			})
			box.appendChild(button)
		}

		// 先挂到 body 再量尺寸：隐藏元素量不出宽高，也就没法决定往哪翻
		document.body.appendChild(box)
		const rect = anchor.getBoundingClientRect()
		const size = box.getBoundingClientRect()
		const margin = 8
		// 默认贴着按钮右下；下方放不下就翻到上方；右边溢出就右对齐
		let top = rect.bottom + 4
		if (top + size.height > window.innerHeight - margin) {
			top = Math.max(margin, rect.top - size.height - 4)
		}
		let left = rect.right - size.width
		if (left < margin)
			left = Math.min(rect.left, window.innerWidth - size.width - margin)
		box.style.top = `${Math.round(top)}px`
		box.style.left = `${Math.round(left)}px`

		openMenu = box
		// `capture: true` —— 否则行自己的 click 会先把事件吃掉
		document.addEventListener('pointerdown', onMenuOutside, true)
		document.addEventListener('keydown', onMenuKey, true)
		return box
	}

	/**
	 * **居中的对话框**（阶段 6c）。
	 *
	 * 安卓端的「添加到歌单」用的是 `Dialog`（居中卡片），**不是**底部弹层 ——
	 * 它的 `AnimatedModalOverlay` 是 `justifyContent: center`。所以桌面端也居中，
	 * 只把宽度按宽屏放大。
	 *
	 * 返回 `{ root, body, actions, close }`，调用方自己往 `body` 放内容、
	 * 往 `actions` 放按钮 —— 组件只管框架与关闭语义。
	 *
	 * ⚠️ 关闭时机与 `menu()` 一样有三条（确认/取消、点遮罩、按 Esc）。
	 * 少一条就会"关不掉"，而**模态关不掉比菜单关不掉严重得多**。
	 */
	function dialog({ testid, title, onClose } = {}) {
		const root = document.createElement('div')
		root.className = 'modal is-open'
		if (testid) root.dataset.testid = testid

		const card = document.createElement('div')
		card.className = 'modal__card modal__card--dialog'

		const head = document.createElement('div')
		head.className = 'modal__head'
		const h2 = document.createElement('h2')
		h2.textContent = title ?? ''
		head.appendChild(h2)
		const closeButton = document.createElement('button')
		closeButton.className = 'icon-only modal__close'
		if (testid) closeButton.dataset.testid = `${testid}-close`
		closeButton.title = '关闭'
		closeButton.setAttribute('aria-label', '关闭')
		closeButton.appendChild(icon('close', 'icon--md'))
		head.appendChild(closeButton)
		card.appendChild(head)

		const body = document.createElement('div')
		body.className = 'modal__body'
		card.appendChild(body)

		const actions = document.createElement('div')
		actions.className = 'modal__actions'
		card.appendChild(actions)

		root.appendChild(card)
		document.body.appendChild(root)

		function onKey(event) {
			if (event.key === 'Escape') {
				event.stopPropagation()
				close()
			}
		}
		/** 只有点在遮罩本身（不是卡片内部）才关 */
		function onBackdrop(event) {
			if (event.target === root) close()
		}
		let closed = false
		function close() {
			if (closed) return
			closed = true
			root.remove()
			document.removeEventListener('keydown', onKey, true)
			document.removeEventListener('pointerdown', onBackdrop, true)
			onClose?.()
		}
		closeButton.addEventListener('click', close)
		document.addEventListener('keydown', onKey, true)
		document.addEventListener('pointerdown', onBackdrop, true)

		return { root, card, body, actions, close }
	}

	window.bbComponents = {
		icon,
		iconHtml,
		hueOf,
		art,
		listRow,
		mediaCard,
		empty,
		toast,
		menu,
		closeMenu,
		dialog,
	}
})()
