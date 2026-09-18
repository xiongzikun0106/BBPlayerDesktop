/**
 * 主题应用（阶段 1）。
 *
 * ## 职责只有两件
 *
 * 1. 把主进程下发的一段 CSS 变量塞进 `<style id="bb-theme-vars">`。
 * 2. 把解析后的模式写进 `documentElement.dataset.theme` 与 `color-scheme`
 *    （后者让原生滚动条、`<input>` 的自动填充、表单控件跟随深浅色）。
 *
 * ## 为什么变量由主进程算
 *
 * 令牌包是 TS，渲染进程没有 Node 能力也没有 bundler。主进程已经有
 * `build/tokens.cjs`（见 `scripts/build-core.mjs`），算好下发是最省事的做法，
 * 而且**只有一份真相** —— 第一版是把令牌手抄进 `style.css`，
 * 结果 34 个语义角色只抄了 6 个、10 级字阶一个都没用。
 *
 * ## 为什么要处理首屏闪烁
 *
 * `theme:describe` 是异步 IPC，页面首次绘制时变量还没到。所以
 * `style.css` 里保留了一组**暗色兜底值**（`color-scheme: dark` + 少数几个
 * 变量），并且在 HTML 上用内联脚本尽早把 `data-theme` 标上。
 * 拿到真实变量后覆盖即可。
 */

const STYLE_ID = 'bb-theme-vars'

;(function initTheme() {
	const state = {
		preference: null,
		mode: null,
		materialLevel: null,
		colors: null,
		/** 最近一次应用的完整描述，供自动化断言 */
		last: null,
	}

	function ensureStyleElement() {
		let node = document.getElementById(STYLE_ID)
		if (!node) {
			node = document.createElement('style')
			node.id = STYLE_ID
			node.dataset.testid = 'theme-vars'
			document.head.appendChild(node)
		}
		return node
	}

	/** 应用一份主进程下发的主题描述 */
	function apply(theme) {
		if (!theme || typeof theme.css !== 'string') return false

		ensureStyleElement().textContent = theme.css

		const root = document.documentElement
		root.dataset.theme = theme.mode
		// 材质强度：CSS 用 `[data-material='blur']` 之类的选择器切换
		if (theme.materialLevel) root.dataset.material = theme.materialLevel
		// 让原生控件（滚动条、表单、自动填充）跟着走
		root.style.colorScheme = theme.mode

		state.preference = theme.preference
		state.mode = theme.mode
		state.materialLevel = theme.materialLevel ?? null
		state.colors = theme.colors
		state.last = theme

		document.dispatchEvent(
			new CustomEvent('bb:theme-changed', { detail: theme }),
		)
		return true
	}

	async function refresh() {
		try {
			const result = await window.bbplayer.theme.describe()
			if (result?.ok === true) return apply(result.data)
			return false
		} catch {
			// 主题拿不到不该让界面起不来：CSS 里那组暗色兜底值仍然可用
			return false
		}
	}

	/** 主动改偏好（设置面板用；底层还是写设置，与其它设置一致） */
	async function setPreference(preference) {
		const result = await window.bbplayer.settings.update({ theme: preference })
		if (result?.ok === true) {
			// 设置写完后主进程会推 `theme:changed`，但不要依赖它 ——
			// 推送是"顺手做的好事"，不该成为正确性的前提。
			await refresh()
			return true
		}
		return false
	}

	window.bbTheme = {
		refresh,
		setPreference,
		/**
		 * 首屏应用完成的信号。
		 *
		 * `renderer.js` 的 boot() 会 await 它再置 `window.__bbReady` ——
		 * 否则探针（和用户）可能在变量还没落地时就去看界面，
		 * 「启动时已应用主题」这类断言会变成**看运气**。
		 */
		ready: null,
		/** 供探针断言：当前偏好、解析后的模式、以及是否拿到了完整变量 */
		describe: () => ({
			preference: state.preference,
			mode: state.mode,
			systemPrefersDark: state.last?.systemPrefersDark ?? null,
			materialLevel: state.materialLevel,
			materialBlur: state.last?.materialBlur ?? null,
			datasetMaterial: document.documentElement.dataset.material ?? null,
			hasVars: Boolean(document.getElementById(STYLE_ID)?.textContent),
			varCount: (document.getElementById(STYLE_ID)?.textContent ?? '').split(
				';',
			).length,
			datasetTheme: document.documentElement.dataset.theme,
			colorScheme: document.documentElement.style.colorScheme,
			primary: state.colors?.primary ?? null,
			surfaceContainer: state.colors?.surfaceContainer ?? null,
		}),
		/** 探针用：直接问主进程要一份，不依赖推送 */
		fromMain: refresh,
	}

	// 主进程推送（系统切换 / 改偏好）
	window.bbplayer.theme.onChanged(apply)

	// 首屏应用。把 Promise 暴露出去，让 boot() 能等它完成再宣布就绪。
	window.bbTheme.ready = refresh()
})()
