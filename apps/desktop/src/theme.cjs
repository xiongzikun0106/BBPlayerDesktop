/**
 * 主题：把 `packages/design-tokens` 的语义值变成一组 CSS 变量。
 *
 * ## 为什么要有这个模块
 *
 * `style.css` 第一版**手抄**了设计令牌：`packages/design-tokens` 里明明有完整的
 * MD3 亮/暗 34 个语义角色、10 级字阶、8 级圆角，而 CSS 里只硬编码了**暗色 6 个
 * 变量**，圆角用了 4 个，字阶**一个都没用**（全站字号压在 11–13px，
 * `font-size:12px` 出现 28 次）。
 *
 * 手抄必然漂移，所以改成**构建期打包令牌包、运行期生成 CSS 变量**：
 * 令牌改了，界面跟着改，没有第二份真相。
 *
 * ## 为什么在**主进程**做
 *
 * 渲染进程没有 Node 能力（`contextIsolation` 开着、没有 bundler），
 * 拿不到 TS 源码。而主进程已经有 `build-core.mjs` 产出的 `build/tokens.cjs`
 * （与 core / splash-merge 同一手法），`require` 即可。
 *
 * ## 「跟随系统」怎么实现
 *
 * Electron 的 `nativeTheme.shouldUseDarkColors` 就是系统级深浅色事实，
 * `nativeTheme.on('updated')` 会在系统切换时触发。偏好存的是
 * `'system' | 'light' | 'dark'`，解析后的**实际**模式是 `'light' | 'dark'`。
 *
 * 渲染进程只需要两样东西：解析后的变量表，和解析后的模式（写进
 * `documentElement.dataset.theme` 与 `color-scheme`）。
 */

const fs = require('node:fs')
const path = require('node:path')

const TOKENS_BUNDLE = path.resolve(__dirname, '..', 'build', 'tokens.cjs')
const TOKENS_ENTRY = path.resolve(
	__dirname,
	'..',
	'..',
	'..',
	'packages',
	'design-tokens',
	'src',
	'index.ts',
)

/** 主题偏好：`system` 表示跟随系统 */
const THEME_PREFERENCES = ['system', 'light', 'dark']
const DEFAULT_PREFERENCE = 'system'

/**
 * 加载令牌包。
 *
 * 优先用构建期产出的 bundle（生产路径）；开发期没跑过 `build:bundle` 时
 * 退回 jiti 直接读 TS（与 `core-loader.cjs` 同样的两级策略）。
 */
let cached = null
function loadTokens() {
	if (cached) return cached

	if (fs.existsSync(TOKENS_BUNDLE)) {
		cached = require(TOKENS_BUNDLE)
		return cached
	}

	if (!fs.existsSync(TOKENS_ENTRY)) {
		throw new Error(
			`既没有令牌 bundle 也没有源码：\n  bundle: ${TOKENS_BUNDLE}\n  源码:   ${TOKENS_ENTRY}\n` +
				'（打包后请确认该模块在 scripts/build-core.mjs 的 ENTRIES 列表里）',
		)
	}

	// 惰性 require 避免纯 Node 验证脚本被迫走 jiti
	const { loadTsFile } = require('./core-loader.cjs')
	cached = loadTsFile(TOKENS_ENTRY)
	return cached
}

/** `onPrimaryContainer` → `on-primary-container` */
function kebab(name) {
	return name.replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/**
 * 规范偏好值。未知值一律当作 `system` —— **不要**在这里抛异常：
 * 设置文件被手改过、或将来删掉某个偏好时，界面应该照常起来。
 */
function normalizePreference(value) {
	return THEME_PREFERENCES.includes(value) ? value : DEFAULT_PREFERENCE
}

/**
 * 把偏好解析成**实际**模式。
 *
 * @param {string} preference `'system' | 'light' | 'dark'`
 * @param {boolean} systemPrefersDark 系统的深浅色事实
 */
function resolveMode(preference, systemPrefersDark) {
	const normalized = normalizePreference(preference)
	if (normalized === 'light' || normalized === 'dark') return normalized
	return systemPrefersDark ? 'dark' : 'light'
}

/**
 * 生成一段 CSS 变量声明。
 *
 * 除了 MD3 的语义角色，还输出两组：
 *   * **字阶 / 圆角 / 间距 / 动效**：把令牌包里的数值也变成变量，
 *     否则 CSS 里还是会出现手写的 `12px`。
 *   * **旧变量别名**（`--bg` / `--surface-2` / `--ok` …）：`style.css` 有
 *     1600 行、几百处引用，一次性改名风险太大。先加别名让新老并存，
 *     逐块迁移 —— 别名消失的那天就是迁移完成的标志。
 */
function buildCssVars(mode, tokens) {
	const colors = tokens.colorSchemes[mode]
	const status = tokens.statusColors[mode]
	const lines = []

	for (const [name, value] of Object.entries(colors)) {
		lines.push(`\t--${kebab(name)}: ${value};`)
	}
	lines.push(`\t--ok: ${status.ok};`)
	lines.push(`\t--warn: ${status.warn};`)
	lines.push(`\t--bad: ${colors.error};`)

	for (const [name, value] of Object.entries(tokens.spacing)) {
		lines.push(`\t--sp-${kebab(name)}: ${value}px;`)
	}
	for (const [name, value] of Object.entries(tokens.radius)) {
		lines.push(`\t--r-${kebab(name)}: ${value}px;`)
	}
	for (const [name, value] of Object.entries(tokens.typography)) {
		lines.push(`\t--fs-${kebab(name)}: ${value.fontSize}px;`)
		lines.push(`\t--lh-${kebab(name)}: ${value.lineHeight}px;`)
	}
	for (const [name, value] of Object.entries(tokens.motion)) {
		lines.push(`\t--motion-${kebab(name)}: ${value}ms;`)
	}

	// ── 旧变量别名（迁移期并存，逐块替换后删除）──
	//
	// ⚠️ 这几个别名**刻意映射到"看起来一样"的 M3 角色**，而不是同名角色：
	//
	//   --surface   → surfaceContainer         (#211F26，旧值就是它)
	//   --surface-2 → surfaceContainerHigh     (#2B2930)
	//   --surface-3 → surfaceContainerHighest  (#36343B)
	//
	// 直接映射同名的 `surface`（#1C1B1F）会把整个界面**压暗一档**，
	// 那是迁移过程中最不该顺手做的事：改结构的时候不要同时改观感，
	// 否则出问题分不清是哪一步造成的。
	lines.push(`\t--bg: ${colors.background};`)
	lines.push(`\t--surface: ${colors.surfaceContainer};`)
	lines.push(`\t--surface-2: ${colors.surfaceContainerHigh};`)
	lines.push(`\t--surface-3: ${colors.surfaceContainerHighest};`)
	lines.push(`\t--on-surface: ${colors.onSurface};`)
	lines.push(`\t--on-surface-variant: ${colors.onSurfaceVariant};`)
	lines.push(`\t--primary: ${colors.primary};`)
	lines.push(`\t--on-primary: ${colors.onPrimary};`)

	return `:root {\n${lines.join('\n')}\n}`
}

/**
 * 生成渲染进程需要的一切。
 *
 * @param {string} preference
 * @param {boolean} systemPrefersDark
 */
function describeTheme(preference, systemPrefersDark) {
	const tokens = loadTokens()
	const normalized = normalizePreference(preference)
	const mode = resolveMode(normalized, systemPrefersDark)

	return {
		preference: normalized,
		mode,
		systemPrefersDark,
		css: buildCssVars(mode, tokens),
		colors: tokens.colorSchemes[mode],
		status: tokens.statusColors[mode],
		typography: tokens.typography,
		radius: tokens.radius,
		spacing: tokens.spacing,
		preferences: THEME_PREFERENCES,
	}
}

/** 把材质强度也做成令牌（阶段 1 的「材质」层用；这里只定义档位） */
const MATERIAL_LEVELS = {
	none: null,
	blur: 'blur(18px)',
	gradient: 'blur(28px) saturate(140%)',
}

module.exports = {
	THEME_PREFERENCES,
	DEFAULT_PREFERENCE,
	MATERIAL_LEVELS,
	TOKENS_BUNDLE,
	TOKENS_ENTRY,
	loadTokens,
	normalizePreference,
	resolveMode,
	buildCssVars,
	describeTheme,
	kebab,
}
