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
	 * @param {{ title?: string, coverUrl?: string|null, iconName?: string }} input
	 */
	function art({ title, coverUrl, iconName } = {}) {
		const box = document.createElement('div')
		box.className = 'list-row__art'

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

	window.bbComponents = {
		icon,
		iconHtml,
		hueOf,
		art,
		listRow,
		empty,
		toast,
	}
})()
