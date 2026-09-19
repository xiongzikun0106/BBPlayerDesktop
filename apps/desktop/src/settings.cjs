/**
 * 设置：持久化 + 主题 + 定时关闭 + 响度均衡（Phase 4 收尾）。
 *
 * ## 持久化走 core 的 `StoragePort`
 *
 * 桌面端没有 MMKV，但 `ports.cjs` 提供了基于 JSON 文件的 KV 端口，
 * 而且**它已经注册进 core**。所以设置直接用它 —— 好处是键名与移动端的
 * `app-storage` 语义一致，将来备份互通时不用再搬一次。
 *
 * ## 定时关闭为什么不放进播放器
 *
 * 定时关闭是「到点暂停」，与播放器状态无耦合，放设置层更清楚。
 * 但它必须**能观察到播放器**（要知道现在是否在播，以及支持淡出），
 * 所以通过依赖注入拿播放器，而不是去 import 渲染进程的模块
 * （那会让设置层没法在纯 Node 下被测）。
 *
 * 移动端的实现（`SleepTimerModal.tsx`）是预设 15/30/45/60 分钟 + 自定义，
 * 配合原生 `Orpheus.setSleepTimer`。桌面端的对应物是这里的
 * `createSleepTimer`：同样的预设，但由渲染进程自己计时（桌面端没有需要
 * 后台保活的场景，窗口关了就退出）。
 */
const SETTINGS_KEY = 'desktop-settings'

/**
 * 主题偏好。
 *
 * `system` 是默认：跟随系统的深浅色。
 *
 * 第一版默认写死 `dark` —— 于是首次启动永远是一套暗色界面，而移动端是
 * **亮色为主**（截图里就是）。桌面端同样应该先尊重系统的选择，
 * 而不是替用户决定"音乐播放器就该是黑的"。
 */
const THEMES = ['system', 'light', 'dark']

/**
 * 材质强度档位（与 `theme.cjs` 的 `MATERIAL_LEVELS` 对应）。
 *
 * 放在这里只用于校验取值合法；具体的 CSS 由 `theme.cjs` 生成。
 */
const MATERIAL_LEVELS = ['none', 'blur', 'gradient']

/** 配色种子来源：跟随系统强调色 / 自定义 */
const ACCENT_MODES = ['system', 'custom']

/** 定时关闭的预设（分钟），与移动端 `PRESET_DURATIONS` 一致 */
const SLEEP_PRESETS_MINUTES = [15, 30, 45, 60]

/** 淡出时长：到点前这段时间内把音量线性降到 0，避免突然静音 */
const SLEEP_FADE_MS = 5000

const DEFAULT_SETTINGS = {
	theme: 'system',
	/** 定时关闭的结束时间戳；null 表示未启用 */
	sleepEndsAt: null,
	/** 响度均衡开关 */
	loudnessNormalization: false,
	/** 响度均衡的目标电平（dB），默认 -14（接近流媒体惯例） */
	loudnessTargetDb: -14,
	/** 均衡器的最大增益（dB），防止把小音量素材抬得过猛 */
	loudnessMaxGainDb: 12,
	/** 下载并发（1–6，与移动端同区间） */
	downloadMaxParallel: 2,
	/**
	 * 材质强度（阶段 1b，借鉴 Salt Player 的「材质」设置页）。
	 *
	 * `none` 不透明；`blur` 遮罩模糊；`gradient` 渐变模糊（更浓 + 提饱和）。
	 * 用在顶栏、弹窗、设置抽屉这些**盖在内容之上**的地方 ——
	 * 有东西可透才叫材质，纯色块上加模糊是看不见的。
	 */
	materialLevel: 'blur',
	/**
	 * 是否自动为每首歌匹配歌词（阶段 3 的「歌词」分类）。
	 *
	 * 关掉之后换曲不会自动请求歌词 —— 对流量敏感或不想被网络拖慢的用户有用；
	 * 需要时仍然可以在歌词面板里手动匹配。
	 */
	lyricsAutoMatch: true,
	/**
	 * 配色种子来源（阶段 4）：跟随系统强调色，或用自定义颜色。
	 *
	 * 与「显示模式」（浅色 / 深色 / 跟随系统）是**两个维度**：
	 * 模式决定亮暗，种子决定色相。混在一起的话「跟随系统」既指亮暗又指颜色，
	 * 用户就没法只改其中一个。
	 */
	accentMode: 'system',
	/** 自定义种子色（`accentMode` 为 `custom` 时使用） */
	accentColor: '#6750A4',
	/**
	 * 左栏宽度（阶段 6，用户要求"各功能区能左右拉动改大小"）。
	 *
	 * 用户确认了三条：**记住**（重启还原）、**双击分隔条还原默认**、
	 * **拖到极窄自动收起该栏**。收起状态用 0 表示（而不是另存一个布尔值：
	 * 两个字段描述同一件事，迟早会不一致）。
	 */
	sidebarWidth: 240,
}

/**
 * 创建设置门面。
 *
 * @param {object} options
 * @param {{getItem: Function, setItem: Function}} options.storage core 的 StoragePort
 * @param {(message: string) => void} [options.log]
 */
function createSettings({ storage, log = () => {} }) {
	/** 内存缓存，避免每次读都走一次文件 */
	let cache = null

	async function load() {
		if (cache) return cache
		let stored = null
		try {
			const raw = await storage.getItem(SETTINGS_KEY)
			if (raw) stored = JSON.parse(raw)
		} catch (error) {
			// 设置坏掉不该让应用起不来：落回默认值并如实记日志
			log(`设置读取失败，落回默认值：${error.message}`)
		}

		// 注意 `stored` 已在上面初始化成 null，展开 null 是合法的（null 展开为
		// 空对象），所以不需要 `?? {}` 这层多余兜底。
		cache = { ...DEFAULT_SETTINGS, ...stored }

		// 校正非法值（用户可能手改过文件，或旧版本写过别的取值）
		if (!THEMES.includes(cache.theme)) cache.theme = DEFAULT_SETTINGS.theme
		cache.sleepEndsAt =
			typeof cache.sleepEndsAt === 'number' && cache.sleepEndsAt > 0
				? cache.sleepEndsAt
				: null
		cache.loudnessNormalization = Boolean(cache.loudnessNormalization)
		cache.loudnessTargetDb = clamp(cache.loudnessTargetDb, -30, -5)
		cache.loudnessMaxGainDb = clamp(cache.loudnessMaxGainDb, 0, 24)
		cache.downloadMaxParallel = clamp(
			Math.trunc(cache.downloadMaxParallel),
			1,
			6,
		)
		if (!MATERIAL_LEVELS.includes(cache.materialLevel)) {
			cache.materialLevel = DEFAULT_SETTINGS.materialLevel
		}
		if (!ACCENT_MODES.includes(cache.accentMode)) {
			cache.accentMode = DEFAULT_SETTINGS.accentMode
		}
		// 只接受 #RRGGBB；给不出合法值就退回默认（派生函数也会兜底）
		if (!/^#[0-9a-fA-F]{6}$/.test(String(cache.accentColor ?? ''))) {
			cache.accentColor = DEFAULT_SETTINGS.accentColor
		}
		/*
		 * 左栏宽度：`0` 是合法值（表示"已收起"），所以要单独判 ——
		 * 用 `clamp` 会把 0 悄悄改成最小值，于是"拖窄自动收起"在重启后就失效了。
		 */
		cache.sidebarWidth = clamp(Math.round(Number(cache.sidebarWidth)), 0, 520)
		if (!Number.isFinite(cache.sidebarWidth)) {
			cache.sidebarWidth = DEFAULT_SETTINGS.sidebarWidth
		}

		return cache
	}

	async function persist() {
		await storage.setItem(SETTINGS_KEY, JSON.stringify(cache))
	}

	/** 合并式写入并落盘；返回写入后的完整设置 */
	async function update(patch) {
		await load()
		cache = { ...cache, ...patch }

		// 写完后再校正一次，保证**落盘的**一定是合法值
		if (!THEMES.includes(cache.theme)) cache.theme = DEFAULT_SETTINGS.theme
		cache.downloadMaxParallel = clamp(
			Math.trunc(cache.downloadMaxParallel),
			1,
			6,
		)
		cache.loudnessTargetDb = clamp(cache.loudnessTargetDb, -30, -5)
		cache.loudnessMaxGainDb = clamp(cache.loudnessMaxGainDb, 0, 24)
		// 左栏宽度：0 表示已收起，必须保留（见 load() 里的注释）
		cache.sidebarWidth = clamp(Math.round(Number(cache.sidebarWidth)), 0, 520)
		if (!Number.isFinite(cache.sidebarWidth)) {
			cache.sidebarWidth = DEFAULT_SETTINGS.sidebarWidth
		}

		await persist()
		return { ...cache }
	}

	/** 清掉定时关闭（到点或用户取消时调用） */
	async function clearSleepTimer() {
		return await update({ sleepEndsAt: null })
	}

	return {
		load,
		update,
		clearSleepTimer,
		/** 当前设置（只读副本） */
		async get() {
			return { ...(await load()) }
		},
		/** 诊断：把常量也报出去，便于 UI 与验证脚本对齐 */
		async describe() {
			return {
				settings: await load(),
				themes: THEMES,
				materialLevels: MATERIAL_LEVELS,
				accentModes: ACCENT_MODES,
				sleepPresets: SLEEP_PRESETS_MINUTES,
				sleepFadeMs: SLEEP_FADE_MS,
				defaults: DEFAULT_SETTINGS,
			}
		},
		THEMES,
		ACCENT_MODES,
		SLEEP_PRESETS_MINUTES,
		SLEEP_FADE_MS,
		DEFAULT_SETTINGS,
	}
}

/** 夹到 [min, max]；非数字落回 min */
function clamp(value, min, max) {
	const n = Number(value)
	if (!Number.isFinite(n)) return min
	return Math.min(max, Math.max(min, n))
}

module.exports = {
	createSettings,
	clamp,
	SETTINGS_KEY,
	THEMES,
	SLEEP_PRESETS_MINUTES,
	SLEEP_FADE_MS,
	DEFAULT_SETTINGS,
}
