/**
 * 从**一个种子色**派生出整套 MD3 语义色板。
 *
 * ## 为什么要有这个
 *
 * 用户明确要求：配色**默认跟随系统主题色**（Windows 的强调色、
 * Electron 的 `systemPreferences.getAccentColor()`），另外提供自定义。
 * 那就必须能从"一个颜色"算出 34 个语义角色 —— 而且**成对**算出来，
 * 保证 `onXxx` 在 `xxx` 上可读。
 *
 * ## 为什么不用完整的 HCT 实现
 *
 * MD3 官方的动态取色走 HCT（色相 / 色度 / 色调）空间，实现量很大
 * （需要 CAM16 + 色调映射查找表）。这里用 HSL 近似，好处是：
 *   * **确定性**：同样的种子永远得到同样的色板，可断言；
 *   * **对比度可控**：每一对 `onX` / `X` 的明度差是**构造出来**的
 *     （浅色模式配深字、深色模式配浅字），不依赖后期校正；
 *   * 体量小、没有查找表，构建期跑得动。
 *
 * 代价是色相在感知上不完全均匀（HSL 的黄绿区偏亮）。对"跟随系统强调色"
 * 这个用途足够 —— 反正种子本身就是用户自己选的颜色。
 *
 * ## 明度/饱和度标定
 *
 * 目标明度直接借 M3 的色调值（tone）换算成 HSL 的 lightness：
 *   tone 40 ≈ HSL 40%、tone 80 ≈ HSL 80%。
 * 这样浅色模式的 primary 够深（在白底上可读），深色模式的 primary
 * 够浅（在深底上可读）。
 */

/** `#RRGGBB` / `RRGGBB` → `{r,g,b}`（0–255）；解析不了返回 null */
function parseHex(input: unknown): { r: number; g: number; b: number } | null {
	if (typeof input !== 'string') return null
	const text = input.trim().replace(/^#/, '')
	// Windows 的 `getAccentColor()` 给的是 8 位（带 alpha），取前 6 位
	const hex = text.length === 8 ? text.slice(0, 6) : text
	if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null
	return {
		r: Number.parseInt(hex.slice(0, 2), 16),
		g: Number.parseInt(hex.slice(2, 4), 16),
		b: Number.parseInt(hex.slice(4, 6), 16),
	}
}

function rgbToHsl({ r, g, b }: { r: number; g: number; b: number }) {
	const rn = r / 255
	const gn = g / 255
	const bn = b / 255
	const max = Math.max(rn, gn, bn)
	const min = Math.min(rn, gn, bn)
	const delta = max - min
	const l = (max + min) / 2
	if (delta === 0) return { h: 0, s: 0, l }
	const s = delta / (1 - Math.abs(2 * l - 1))
	let h
	if (max === rn) h = ((gn - bn) / delta) % 6
	else if (max === gn) h = (bn - rn) / delta + 2
	else h = (rn - gn) / delta + 4
	h *= 60
	if (h < 0) h += 360
	return { h, s, l }
}

function hslToHex({ h, s, l }: { h: number; s: number; l: number }) {
	const hn = ((h % 360) + 360) % 360
	const sn = Math.min(1, Math.max(0, s))
	const ln = Math.min(1, Math.max(0, l))
	const c = (1 - Math.abs(2 * ln - 1)) * sn
	const x = c * (1 - Math.abs(((hn / 60) % 2) - 1))
	const m = ln - c / 2
	let rgb
	if (hn < 60) rgb = [c, x, 0]
	else if (hn < 120) rgb = [x, c, 0]
	else if (hn < 180) rgb = [0, c, x]
	else if (hn < 240) rgb = [0, x, c]
	else if (hn < 300) rgb = [x, 0, c]
	else rgb = [c, 0, x]
	const to = (v: number) =>
		Math.round((v + m) * 255)
			.toString(16)
			.padStart(2, '0')
	return `#${rgb.map(to).join('')}`.toUpperCase()
}

/**
 * 把"色调（tone）"换算成 HSL 明度。
 *
 * 不是精确换算（那需要感知空间），但单调、够用：tone 0 → 0%、
 * tone 100 → 100%、中间近似线性。用它来给每个角色定亮度基准。
 */
function toneToLightness(tone: number) {
	return Math.min(1, Math.max(0, tone / 100))
}

/** 按 `{hueOffset, satScale, tone}` 生成一个颜色 */
type Mode = 'light' | 'dark'

/** 一组明度标定：每个角色在浅色 / 深色模式下各自的 tone */
interface ToneSpec {
	light: number
	dark: number
}

interface RoleSpec {
	hueOffset?: number
	satScale?: number
	tone?: ToneSpec
}

function role(
	seed: { h: number; s: number; l: number },
	mode: Mode,
	{ hueOffset = 0, satScale = 1, tone }: RoleSpec,
) {
	const spec = tone ?? { light: 50, dark: 50 }
	const lightness = toneToLightness(mode === 'light' ? spec.light : spec.dark)
	return hslToHex({
		h: seed.h + hueOffset,
		s: fitSaturation(seed.s * satScale, lightness),
		l: lightness,
	})
}

/**
 * 极端明度下收一点饱和度。
 *
 * HSL 在高明度/低明度时会把饱和色推成荧光色（`#00FFAA` 那种），
 * 这是 HSL 的固有毛病，不是种子的问题。
 */
function fitSaturation(saturation: number, lightness: number) {
	if (lightness > 0.85 || lightness < 0.15) return saturation * 0.55
	return saturation
}

/** 目标对比度：WCAG AA 的正文门槛 */
const CONTRAST_TARGET = 4.5

/**
 * 把背景色的明度挪到**前景色真的能读**为止。
 *
 * ## 为什么必须有这一步
 *
 * HSL 的 lightness **不是感知明度**：同样的 L=40%，
 * 青绿（`#00CCAA`）看起来比紫色亮得多 —— 白字压上去只有 **2.06:1**，
 * 远低于 WCAG 的 4.5。实测在 11 个种子 × 2 种模式下有 5 组不达标。
 *
 * 校正方向由模式决定：
 *   * 浅色模式：把背景**调暗**（前景是白/近白）；
 *   * 深色模式：把背景**调亮**（前景是深色）。
 * 每次挪 1% 明度，最多 60 次 —— 确定性、可断言，且保留色相。
 *
 * @param {string} backgroundHex
 * @param {string} foregroundHex
 * @param {'light'|'dark'} mode
 */
function ensureContrast(backgroundHex: string, foregroundHex: string) {
	if (contrastRatio(backgroundHex, foregroundHex) >= CONTRAST_TARGET) {
		return backgroundHex
	}
	const bgRgb = parseHex(backgroundHex)
	if (!bgRgb) return backgroundHex
	const bg = rgbToHsl(bgRgb)
	/*
	 * ⚠️ 方向要按**前景的明度**决定，不能按深浅模式决定。
	 *
	 * 第一版写的是"浅色模式调暗、深色模式调亮"，那对 `primary`/`onPrimary`
	 * 是对的（深色模式下 onPrimary 是深色），但对**容器**是反的：
	 * 深色模式的 `onPrimaryContainer` 是**亮**色，背景要往**暗**走才能拉开。
	 * 结果 `#00B294` 深色下 container 被越推越亮，最后和 onContainer
	 * 几乎同色（对比度 **1.16**，等于完全读不出来）。
	 *
	 * 正确规则很简单：**背景往远离前景明度的方向走**。
	 */
	const fgRgb = parseHex(foregroundHex)
	const fgLightness = fgRgb ? rgbToHsl(fgRgb).l : 0.5
	const direction = bg.l > fgLightness ? 1 : -1
	let lightness = bg.l
	for (let i = 0; i < 60; i++) {
		lightness += direction * 0.01
		if (lightness <= 0.02 || lightness >= 0.98) break
		const candidate = hslToHex({
			h: bg.h,
			s: fitSaturation(bg.s, lightness),
			l: lightness,
		})
		if (contrastRatio(candidate, foregroundHex) >= CONTRAST_TARGET) {
			return candidate
		}
	}
	// 挪到头还不达标（极少见）：退回纯黑/纯白，**能读**优先于好看
	return direction > 0 ? '#000000' : '#FFFFFF'
}

/**
 * 从种子色派生一整套语义角色。
 *
 * @param {string} accent `#RRGGBB` 或 Windows 的 8 位形式
 * @param {'light'|'dark'} mode
 * @returns {Record<string, string> | null} 只含"与种子相关"的角色
 */
export function deriveSchemeFromAccent(accent: string, mode: Mode) {
	const rgb = parseHex(accent)
	if (!rgb) return null
	const seed = rgbToHsl(rgb)
	// 饱和度太低的种子（灰、近黑近白）派生出来会是一片灰 ——
	// 给一个下限，至少还有点色相可分。调用方也可以据此决定退回基线。
	const usable = { h: seed.h, s: Math.max(seed.s, 0.18), l: seed.l }

	/** 一组"背景 + 它的前景"，生成后做对比度校正 */
	const family = ({
		hueOffset = 0,
		satScale = 1,
		tones,
	}: {
		hueOffset?: number
		satScale?: number
		tones: {
			base: ToneSpec
			on: ToneSpec
			container: ToneSpec
			onContainer: ToneSpec
		}
	}) => {
		const spec = { hueOffset, satScale }
		const on = role(usable, mode, {
			...spec,
			tone: tones.on,
		})
		const onContainer = role(usable, mode, {
			...spec,
			tone: tones.onContainer,
		})
		return {
			base: ensureContrast(
				role(usable, mode, { ...spec, tone: tones.base }),
				on,
			),
			on,
			container: ensureContrast(
				role(usable, mode, { ...spec, tone: tones.container }),
				onContainer,
			),
			onContainer,
		}
	}

	const primary = family({
		tones: {
			base: { light: 40, dark: 80 },
			on: { light: 100, dark: 20 },
			container: { light: 90, dark: 30 },
			onContainer: { light: 10, dark: 90 },
		},
	})
	// 次要色族：同色相、低饱和（M3 里 secondary 就是 primary 的"安静版"）
	const secondary = family({
		satScale: 0.34,
		tones: {
			base: { light: 40, dark: 80 },
			on: { light: 100, dark: 20 },
			container: { light: 90, dark: 30 },
			onContainer: { light: 10, dark: 90 },
		},
	})
	// 第三色族：色相偏 60°，用于"需要区分但不抢戏"的地方
	const tertiary = family({
		hueOffset: 60,
		satScale: 0.5,
		tones: {
			base: { light: 40, dark: 80 },
			on: { light: 100, dark: 20 },
			container: { light: 90, dark: 30 },
			onContainer: { light: 10, dark: 90 },
		},
	})

	return {
		primary: primary.base,
		onPrimary: primary.on,
		primaryContainer: primary.container,
		onPrimaryContainer: primary.onContainer,
		secondary: secondary.base,
		onSecondary: secondary.on,
		secondaryContainer: secondary.container,
		onSecondaryContainer: secondary.onContainer,
		tertiary: tertiary.base,
		onTertiary: tertiary.on,
		tertiaryContainer: tertiary.container,
		onTertiaryContainer: tertiary.onContainer,
		// MD3 的 surfaceTint 就是 primary
		surfaceTint: primary.base,
	}
}

/**
 * 相对亮度（WCAG 2.1），用于算对比度。
 * @param {string} hex
 */
/** sRGB 通道 → 线性光（WCAG 2.1 的公式），提到模块作用域以免每次调用重建 */
function linearizeChannel(value: number) {
	const v = value / 255
	return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(hex: string) {
	const rgb = parseHex(hex)
	if (!rgb) return 0
	return (
		0.2126 * linearizeChannel(rgb.r) +
		0.7152 * linearizeChannel(rgb.g) +
		0.0722 * linearizeChannel(rgb.b)
	)
}

/**
 * 两色的对比度（1–21）。WCAG 的正文门槛是 4.5，大字/图形是 3。
 *
 * ⚠️ 这个函数是给**断言**用的：派生出来的 `onX` / `X` 必须真的能读。
 * "配色好看"没法自动判，但"字看不清"可以。
 */
export function contrastRatio(a: string, b: string) {
	const la = relativeLuminance(a)
	const lb = relativeLuminance(b)
	const lighter = Math.max(la, lb)
	const darker = Math.min(la, lb)
	return (lighter + 0.05) / (darker + 0.05)
}
