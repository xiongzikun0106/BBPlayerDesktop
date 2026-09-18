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
				sleepPresets: SLEEP_PRESETS_MINUTES,
				sleepFadeMs: SLEEP_FADE_MS,
				defaults: DEFAULT_SETTINGS,
			}
		},
		THEMES,
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
