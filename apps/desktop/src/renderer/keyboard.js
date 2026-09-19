/**
 * 全局快捷键注册表。
 *
 * 为什么要中心化：plan §3.4 列了约 30 个快捷键，散在各处必然互相打架
 * （典型冲突：`Ctrl+F` 既要「聚焦搜索」又要「列表内搜索」）。
 *
 * 三级优先级，从高到低：
 *   1. `scope: 'input'` —— 仅在输入框内生效（例如 Esc 清空搜索框）
 *   2. `scope: 'context'` —— 有选中项时才生效（例如 Enter 播放选中项）
 *   3. `scope: 'global'` —— 全局生效
 *
 * 输入框内默认**不触发 global 快捷键**（否则打字时按空格会暂停播放）。
 * 需要覆盖时用 `options.allowInInput = true`（例如 Escape）。
 */
;(function () {
	'use strict'

	/** 规范化成 'ctrl+shift+f' 这种形式，便于比较 */
	function normalize(event) {
		const parts = []
		if (event.ctrlKey || event.metaKey) parts.push('ctrl')
		if (event.altKey) parts.push('alt')
		if (event.shiftKey) parts.push('shift')

		let key = event.key
		if (key === ' ') key = 'space'
		else if (key === 'Escape') key = 'escape'
		else if (key === 'Enter') key = 'enter'
		else if (key === 'ArrowLeft') key = 'arrowleft'
		else if (key === 'ArrowRight') key = 'arrowright'
		else if (key === 'ArrowUp') key = 'arrowup'
		else if (key === 'ArrowDown') key = 'arrowdown'
		else if (key === 'Delete' || key === 'Backspace') key = 'delete'
		else if (key.length === 1) key = key.toLowerCase()

		parts.push(key)
		return parts.join('+')
	}

	/** 是否正在输入框里打字 */
	function isTyping(target) {
		if (!target) return false
		const tag = target.tagName
		return (
			tag === 'INPUT' ||
			tag === 'TEXTAREA' ||
			tag === 'SELECT' ||
			target.isContentEditable === true
		)
	}

	const bindings = new Map()
	const log = []

	/**
	 * 注册一个快捷键。
	 * @param {string} combo  形如 'space' / 'ctrl+f' / 'shift+arrowleft'
	 * @param {object} options { description, scope, allowInInput }
	 * @param {(event: KeyboardEvent) => void} handler
	 */
	function register(combo, options, handler) {
		// 参数就是字符串（见 JSDoc），`String(combo)` 是多余的类型转换
		const key = combo.toLowerCase()
		if (typeof options === 'function') {
			handler = options
			options = {}
		}
		if (bindings.has(key)) {
			// 显式冲突检测：不静默覆盖，否则很难排查
			console.warn(`[keys] 快捷键 ${key} 已被占用，覆盖为新处理器`)
		}
		bindings.set(key, {
			combo: key,
			description: options.description || '',
			scope: options.scope || 'global',
			allowInInput: options.allowInInput === true,
			handler,
		})
	}

	/**
	 * **按组合键触发已注册的处理器**（阶段 6，顶部播放菜单用）。
	 *
	 * ⚠️ 存在的意义是**复用**，不是新增一套分发。
	 *
	 * 顶部菜单要能播放/暂停、上一首/下一首…… 而这些动作在
	 * `renderer.js` 里已经以 `keys.register('space', …, handler)` 的形式
	 * 注册过了 —— 但处理器是**匿名回调**，外面拿不到。
	 *
	 * 最省事也最不容易走样的做法是：菜单只发**组合键字符串**
	 * （`'space'` / `'shift+arrowleft'`…），由这里转交给**同一个**处理器。
	 * 于是菜单与快捷键**永远同源**，不会出现"菜单里的下一首和快捷键的
	 * 下一首行为不一致"这种双路径漂移。
	 *
	 * 与真实按键的区别：不做 `isTyping()` 检查（用户是**主动点菜单**，
	 * 不是在输入框里敲键盘），也不构造 KeyboardEvent。
	 *
	 * @param {string} combo 组合键字符串，例如 `'space'` / `'shift+arrowleft'`
	 * @returns {boolean} 有没有命中已注册的处理器
	 */
	function trigger(combo) {
		const key = combo.toLowerCase()
		const binding = bindings.get(key)
		if (!binding?.handler) return false
		try {
			binding.handler({ type: 'menu', key, preventDefault() {} })
		} catch (error) {
			console.warn(`[keys] 触发 ${key} 时抛错：`, error)
			return false
		}
		return true
	}

	function unregister(combo) {
		bindings.delete(String(combo).toLowerCase())
	}

	function handleKeydown(event) {
		const combo = normalize(event)
		const binding = bindings.get(combo)
		if (!binding) return

		const typing = isTyping(event.target)

		if (binding.scope === 'input' && !typing) return
		if (binding.scope !== 'input' && typing && !binding.allowInInput) return

		event.preventDefault()
		log.push({ combo, at: Date.now() })
		try {
			binding.handler(event)
		} catch (error) {
			console.error(`[keys] ${combo} 处理失败:`, error)
		}
	}

	function install() {
		window.addEventListener('keydown', handleKeydown)
	}

	/** 供 UI / 自动化断言 */
	function list() {
		return [...bindings.values()].map(({ combo, description, scope }) => ({
			combo,
			description,
			scope,
		}))
	}

	/**
	 * 快捷键帮助的开关。
	 *
	 * 说明文字原来是**常驻**在顶栏上的（「快捷键：Space 播放/暂停 · …」）——
	 * 那是把说明书贴在墙上：看过一遍之后每一屏都还要再看一遍，
	 * 还占掉了顶栏最值钱的位置。现在收进一个键盘图标按钮，点开才显示。
	 *
	 * 文案取自 `list()`（**实际注册**的快捷键表），而不是手写一份 ——
	 * 手写的说明会与真实键位漂移（这个仓库已经踩过一次）。
	 */
	function wireShortcutHelp() {
		const openButton = document.getElementById('shortcuts-open')
		const hint = document.getElementById('hint')
		if (!openButton || !hint) return

		const entries = list()
		if (entries.length > 0) {
			hint.textContent =
				'快捷键：' +
				entries
					.map((entry) => `${entry.combo} ${entry.description}`)
					.join(' · ')
		}

		const setOpen = (open) => {
			hint.hidden = !open
			openButton.classList.toggle('is-active', open)
			openButton.setAttribute('aria-expanded', String(open))
		}

		openButton.addEventListener('click', () => setOpen(hint.hidden))
		setOpen(false)

		window.bbShortcuts = {
			open: () => setOpen(true),
			close: () => setOpen(false),
			isOpen: () => !hint.hidden,
			text: () => hint.textContent ?? '',
		}
	}

	wireShortcutHelp()

	window.bbKeys = {
		register,
		unregister,
		trigger,
		install,
		list,
		normalize,
		isTyping,
		history: () => log.slice(),
	}
})()
