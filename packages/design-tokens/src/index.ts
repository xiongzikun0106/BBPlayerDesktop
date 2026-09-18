/**
 * BBPlayer 设计 token（平台无关）。
 *
 * 移动端（React Native Paper / MD3）与桌面端（新 UI）共用同一套语义值，
 * 避免两端视觉长期漂移。
 *
 * 数值来源：审计现有移动端代码中实际高频使用的字面量，例如
 * `borderRadius: 24 | 20 | 12 | 8 | 4`、`fontSize: 16`、间距 4 的倍数。
 * 本包是**新增**的单一来源：移动端目前尚未改为消费它，改造放在桌面端 UI
 * 动工之前（见 docs/DESKTOP_PLAN.md Phase 2），以免在 Phase 0 引入视觉回归。
 */

// ============================================================
// 间距（4 的倍数）
// ============================================================

export const spacing = {
	none: 0,
	/** 4 — 图标与文字之间 */
	xxs: 4,
	/** 8 — 紧凑元素内边距 */
	xs: 8,
	/** 12 — 列表项内边距 */
	sm: 12,
	/** 16 — 标准内容边距 */
	md: 16,
	/** 20 — 卡片内边距 */
	lg: 20,
	/** 24 — 区块间距 */
	xl: 24,
	/** 32 — 大区块分隔 */
	xxl: 32,
} as const

// ============================================================
// 圆角
// ============================================================

export const radius = {
	/** 4 — 热力图格子等微元素 */
	xs: 4,
	/** 8 — 输入框、标签 */
	sm: 8,
	/** 12 — 列表项、卡片 */
	md: 12,
	/** 16 — 面板、底部抽屉上沿 */
	lg: 16,
	/** 20 — 大卡片 */
	xl: 20,
	/** 24 — 主卡片、播放器容器 */
	xxl: 24,
	/** 28 — 主要按钮 */
	button: 28,
	/** 完全圆角（胶囊 / 圆形） */
	full: 9999,
} as const

// ============================================================
// 字号 / 行高
// ============================================================

export const typography = {
	labelSmall: { fontSize: 11, lineHeight: 16 },
	labelMedium: { fontSize: 12, lineHeight: 16 },
	labelLarge: { fontSize: 14, lineHeight: 20 },
	bodySmall: { fontSize: 12, lineHeight: 16 },
	bodyMedium: { fontSize: 14, lineHeight: 20 },
	bodyLarge: { fontSize: 16, lineHeight: 24 },
	titleSmall: { fontSize: 14, lineHeight: 20 },
	titleMedium: { fontSize: 16, lineHeight: 24 },
	titleLarge: { fontSize: 22, lineHeight: 28 },
	headlineSmall: { fontSize: 24, lineHeight: 32 },
} as const

// ============================================================
// 动效
// ============================================================

export const motion = {
	/** 快速反馈：按压、勾选 */
	durationFast: 100,
	/** 标准过渡：展开、淡入 */
	durationNormal: 200,
	/** 强调过渡：页面切换、歌词滚动 */
	durationSlow: 300,
	durationEmphasized: 620,
} as const

// ============================================================
// 语义色板
// ============================================================

/**
 * 语义色。
 *
 * 照搬 Material Design 3 的语义命名，因为移动端已经基于 MD3
 * （`react-native-paper` 的 `MD3LightTheme` / `MD3DarkTheme`），
 * 桌面端沿用同一套语义即可保证配色一致。
 *
 * 实际主题会在运行时被「莫奈取色 / B 站装扮」覆盖；这里是**回退基线**。
 */
export interface SemanticColors {
	primary: string
	onPrimary: string
	primaryContainer: string
	onPrimaryContainer: string
	secondary: string
	onSecondary: string
	secondaryContainer: string
	onSecondaryContainer: string
	tertiary: string
	onTertiary: string
	tertiaryContainer: string
	onTertiaryContainer: string
	error: string
	onError: string
	errorContainer: string
	onErrorContainer: string
	background: string
	onBackground: string
	surface: string
	onSurface: string
	surfaceVariant: string
	onSurfaceVariant: string
	/**
	 * M3 的「surface 容器」五级。
	 *
	 * 桌面端特别需要这一组：抽屉、卡片、悬浮播放条、对话框都要靠**层级**区分，
	 * 而不是靠 1px 分隔线。第一版的做法是到处画边框（`.sidebar` / `.rightbar` /
	 * `.playbar` / `.status-bar` 都有 `border-*`），视觉上就成了"IDE 面板"。
	 */
	surfaceContainerLowest: string
	surfaceContainerLow: string
	surfaceContainer: string
	surfaceContainerHigh: string
	surfaceContainerHighest: string
	/** 主色的"染色"版本，用于把表面染上一层主题色 */
	surfaceTint: string
	outline: string
	outlineVariant: string
	inverseSurface: string
	inverseOnSurface: string
	shadow: string
	scrim: string
}

export type ColorScheme = 'light' | 'dark'

/**
 * 语义色板。
 *
 * 照搬 Material Design 3 的语义命名，因为移动端已经基于 MD3
 * （`react-native-paper` 的 `MD3LightTheme` / `MD3DarkTheme`），
 * 桌面端沿用同一套语义即可保证配色一致。
 *
 * 实际主题会在运行时被「莫奈取色 / B 站装扮 / 系统主题色」覆盖；
 * 这里是**回退基线**（M3 baseline 的标准取值）。
 */
export const colorSchemes: Record<ColorScheme, SemanticColors> = {
	light: {
		primary: '#6750A4',
		onPrimary: '#FFFFFF',
		primaryContainer: '#EADDFF',
		onPrimaryContainer: '#21005D',
		secondary: '#625B71',
		onSecondary: '#FFFFFF',
		secondaryContainer: '#E8DEF8',
		onSecondaryContainer: '#1D192B',
		tertiary: '#7D5260',
		onTertiary: '#FFFFFF',
		tertiaryContainer: '#FFD8E4',
		onTertiaryContainer: '#31111D',
		error: '#B3261E',
		onError: '#FFFFFF',
		errorContainer: '#F9DEDC',
		onErrorContainer: '#410E0B',
		background: '#FFFBFE',
		onBackground: '#1C1B1F',
		surface: '#FFFBFE',
		onSurface: '#1C1B1F',
		surfaceVariant: '#E7E0EC',
		onSurfaceVariant: '#49454F',
		surfaceContainerLowest: '#FFFFFF',
		surfaceContainerLow: '#F7F2FA',
		surfaceContainer: '#F3EDF7',
		surfaceContainerHigh: '#ECE6F0',
		surfaceContainerHighest: '#E6E0E9',
		surfaceTint: '#6750A4',
		outline: '#79747E',
		outlineVariant: '#CAC4D0',
		inverseSurface: '#313033',
		inverseOnSurface: '#F4EFF4',
		shadow: '#000000',
		scrim: '#000000',
	},
	dark: {
		primary: '#D0BCFF',
		onPrimary: '#381E72',
		primaryContainer: '#4F378B',
		onPrimaryContainer: '#EADDFF',
		secondary: '#CCC2DC',
		onSecondary: '#332D41',
		secondaryContainer: '#4A4458',
		onSecondaryContainer: '#E8DEF8',
		tertiary: '#EFB8C8',
		onTertiary: '#492532',
		tertiaryContainer: '#633B48',
		onTertiaryContainer: '#FFD8E4',
		error: '#F2B8B5',
		onError: '#601410',
		errorContainer: '#8C1D18',
		onErrorContainer: '#F9DEDC',
		background: '#1C1B1F',
		onBackground: '#E6E1E5',
		surface: '#1C1B1F',
		onSurface: '#E6E1E5',
		surfaceVariant: '#49454F',
		onSurfaceVariant: '#CAC4D0',
		surfaceContainerLowest: '#0F0D13',
		surfaceContainerLow: '#1D1B20',
		surfaceContainer: '#211F26',
		surfaceContainerHigh: '#2B2930',
		surfaceContainerHighest: '#36343B',
		surfaceTint: '#D0BCFF',
		outline: '#938F99',
		outlineVariant: '#49454F',
		inverseSurface: '#E6E1E5',
		inverseOnSurface: '#313033',
		shadow: '#000000',
		scrim: '#000000',
	},
}

export const getColors = (scheme: ColorScheme): SemanticColors =>
	colorSchemes[scheme]

// ============================================================
// 状态色（**不属于 MD3**，是 BBPlayer 自己的语义）
// ============================================================

/**
 * MD3 只有 `error` 一个状态语义，而播放器需要区分
 * 「好了 / 坏了 / 需要注意」三种。
 *
 * 刻意**不**塞进 `colorSchemes`：那样两个方案里都要重复维护，
 * 而且会让人以为它们是 M3 标准角色。它们是应用级语义，单独放。
 */
export const statusColors: Record<ColorScheme, { ok: string; warn: string }> = {
	light: { ok: '#2E7D32', warn: '#8F6C00' },
	dark: { ok: '#7DDC8A', warn: '#F5D67B' },
}

// ============================================================
// 主题偏好（含「跟随系统」）
// ============================================================

export type ThemePreference = 'system' | ColorScheme

export const themePreferences: ThemePreference[] = ['system', 'light', 'dark']
