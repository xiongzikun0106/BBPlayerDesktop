/**
 * 主进程侧的媒体集成：任务栏缩略图按钮 + 硬件媒体键兜底。
 *
 * ## 与渲染进程 MediaSession 的分工
 *
 * `navigator.mediaSession`（渲染进程，见 `renderer/media-session.js`）负责
 * **系统媒体面板与媒体键**，这是主路径。本文件只做两件它做不到的事：
 *
 * 1. **任务栏缩略图工具栏**（Windows 的 `setThumbarButtons`）——
 *    悬浮在任务栏图标上时出现的前一首/播放/下一首按钮。这是 Electron 的
 *    原生 API，渲染进程碰不到。
 * 2. **硬件媒体键兜底**（`globalShortcut`）—— 默认**不注册**。
 *    原因：它和 MediaSession 同时生效会让一次按键触发两次
 *    （播放→暂停→播放，表现为「按了没反应」）。而且 `globalShortcut`
 *    在 **Wayland 上通常无效**。因此只在显式要求时启用。
 *
 * ## 为什么要有窗口注册表
 *
 * 任务栏按钮挂在**具体某个 BrowserWindow** 上，而 IPC handler 只拿得到
 * `event.sender`（WebContents）。所以这里维护
 * `WebContents.id -> { window, state }` 的映射，由 `attach()` 在创建窗口时
 * 登记。`setThumbarPlaying(sender, playing)` 再按 sender 找到窗口。
 */
const { globalShortcut, nativeImage, BrowserWindow } = require('electron')

const { iconDataUrls } = require('./thumbar-icons.cjs')

/**
 * 任务栏按钮图标：由 `thumbar-icons.cjs` **运行时生成** 32×32 PNG。
 *
 * ⚠️ 第一版这里硬编码了四串 base64，结果全是同一串占位图（而且只有
 * 16×16，高 DPI 下模糊）。生成是零依赖的（Node 内置 zlib），不会写错。
 */
const ICON_DATA_URLS = iconDataUrls()

/**
 * 媒体键列表。
 *
 * 用 Electron 的 accelerator 名。`MediaPlayPause` / `MediaNextTrack` /
 * `MediaPreviousTrack` / `MediaStop` 是跨平台的；单独注册
 * `MediaPlay` 与 `MediaPause` 在部分系统上不存在，所以只注册
 * 「播放/暂停」二合一那个。
 */
const MEDIA_KEY_ACTIONS = [
	{ accelerator: 'MediaPlayPause', action: 'toggle' },
	{ accelerator: 'MediaNextTrack', action: 'next' },
	{ accelerator: 'MediaPreviousTrack', action: 'prev' },
	{ accelerator: 'MediaStop', action: 'stop' },
]

/** `nativeImage` 只接受位图，所以这里必须给 PNG 而不是 SVG */
const icon = (name) =>
	nativeImage.createFromDataURL(ICON_DATA_URLS[name] ?? ICON_DATA_URLS.play)

// ---------------------------------------------------------------
// 窗口注册表
// ---------------------------------------------------------------

/** @type {Map<number, {window: Electron.BrowserWindow, playing: boolean, buttonsInstalled: boolean}>} */
const registry = new Map()

/** 有多少个窗口成功装上了任务栏按钮（Linux 上通常是 0） */
let thumbarInstalledCount = 0

/** 当前已注册的媒体键（兜底路径） */
let registeredKeys = []

/**
 * 是否被要求启用 `globalShortcut` 兜底路径。
 *
 * 由 `main.cjs` 在解析启动参数后通过 {@link setHardwareKeysRequested} 设置，
 * 渲染进程读 `mediaInfo()` 后据此决定要不要真去注册。
 * 「被要求」与「已注册」是两件事，所以分开记录。
 */
let HARDWARE_KEYS_REQUESTED = false

function setHardwareKeysRequested(value) {
	HARDWARE_KEYS_REQUESTED = Boolean(value)
	return HARDWARE_KEYS_REQUESTED
}

function buttonsFor(playing, sendAction) {
	return [
		{ tooltip: '上一首', icon: icon('prev'), click: () => sendAction('prev') },
		{
			tooltip: playing ? '暂停' : '播放',
			icon: icon(playing ? 'pause' : 'play'),
			click: () => sendAction('toggle'),
		},
		{ tooltip: '下一首', icon: icon('next'), click: () => sendAction('next') },
	]
}

/**
 * 把一个窗口登记进媒体集成，并安装任务栏缩略图按钮。
 *
 * 必须在窗口创建后调用。非 Windows 平台上 `setThumbarButtons` 是 no-op
 * （不报错也不生效），所以不需要按平台分支 —— 但 `buttonsInstalled`
 * 会被如实标为「调用成功与否」，避免把 no-op 当成成功。（Electron 的
 * `setThumbarButtons` 返回 boolean，正好用得上。）
 *
 * @param {Electron.BrowserWindow} window
 * @param {(action: string) => void} sendAction 把动作名发回渲染进程
 */
function attach(window, sendAction) {
	const id = window.webContents.id
	const entry = { window, playing: false, buttonsInstalled: false }
	registry.set(id, entry)

	try {
		entry.buttonsInstalled = window.setThumbarButtons(
			buttonsFor(false, sendAction),
		)
		if (entry.buttonsInstalled) thumbarInstalledCount += 1
	} catch {
		// 部分 Linux 桌面环境没有实现，静默跳过（不要因此让窗口创建失败）
	}

	window.on('closed', () => {
		if (entry.buttonsInstalled) thumbarInstalledCount -= 1
		registry.delete(id)
	})

	return entry
}

/** 按 WebContents 找注册项；找不到返回 null（例如窗口已关） */
function entryFor(sender) {
	if (!sender) return null
	const id = typeof sender === 'number' ? sender : sender.id
	return registry.get(id) ?? null
}

/** 按 WebContents.id 找注册项（供 IPC handler 用） */
function entryForId(id) {
	return registry.get(id) ?? null
}

/**
 * 同步任务栏按钮的播放/暂停图标。
 *
 * @param {Electron.WebContents|number} sender
 * @param {boolean} playing
 */
function setThumbarPlaying(sender, playing) {
	const entry = entryFor(sender)
	if (!entry) {
		return { updated: false, reason: '窗口未登记或已关闭' }
	}
	if (entry.playing === playing) {
		return { updated: false, reason: '状态未变化', playing }
	}
	entry.playing = playing
	if (entry.window.isDestroyed()) {
		return { updated: false, reason: '窗口已销毁', playing }
	}
	try {
		entry.window.setThumbarButtons(
			buttonsFor(playing, (action) => sendMediaAction(entry.window, action)),
		)
		return { updated: true, playing }
	} catch (error) {
		return { updated: false, reason: error.message, playing }
	}
}

/**
 * 往某个窗口的渲染进程推进程内动作。
 *
 * 主进程**不判断**动作是什么意思（它不知道队列状态），只转发。
 */
function sendMediaAction(window, action) {
	if (!window || window.isDestroyed()) return false
	window.webContents.send('media:action', action)
	return true
}

/**
 * 注册硬件媒体键（**兜底路径，默认不调用**）。
 *
 * @param {(action: string) => void} sendAction
 * @returns {{registered: string[], failed: string[]}}
 */
function installMediaKeys(sendAction) {
	// 先清掉旧的，避免重复注册导致一次按键触发多次
	globalShortcut.unregisterAll()
	registeredKeys = []

	const registered = []
	const failed = []

	for (const { accelerator, action } of MEDIA_KEY_ACTIONS) {
		try {
			// 已被别的程序占用时 register 返回 false（**不抛错**），必须看返回值
			const ok = globalShortcut.register(accelerator, () => sendAction(action))
			if (ok) registered.push(accelerator)
			else failed.push(accelerator)
		} catch (error) {
			failed.push(`${accelerator}(${error.message})`)
		}
	}

	registeredKeys = registered
	return { registered, failed }
}

function uninstallMediaKeys() {
	globalShortcut.unregisterAll()
	registeredKeys = []
}

/** 诊断信息（验证脚本用） */
function describe() {
	return {
		registeredWindowCount: registry.size,
		thumbarInstalledCount,
		registeredMediaKeys: registeredKeys,
		mediaKeyAccelerators: MEDIA_KEY_ACTIONS.map((k) => k.accelerator),
		// 是否被要求启用硬件媒体键兜底（渲染进程据此决定要不要注册）
		hardwareKeysRequested: HARDWARE_KEYS_REQUESTED,
		// 图标自检：四张 PNG 是否都非空且互不相同
		iconCount: Object.keys(ICON_DATA_URLS).length,
		iconBytes: Object.fromEntries(
			Object.entries(ICON_DATA_URLS).map(([name, url]) => [
				name,
				Buffer.from(url.split(',')[1], 'base64').length,
			]),
		),
		// Windows 才有任务栏缩略图工具栏；Linux 桌面环境多为 no-op
		platform: process.platform,
		windowsCount: BrowserWindow.getAllWindows().length,
	}
}

module.exports = {
	attach,
	entryForId,
	setThumbarPlaying,
	sendMediaAction,
	installMediaKeys,
	uninstallMediaKeys,
	setHardwareKeysRequested,
	describe,
	MEDIA_KEY_ACTIONS,
	ICON_DATA_URLS,
}
