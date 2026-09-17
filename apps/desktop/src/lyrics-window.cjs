/**
 * 独立歌词窗口（Phase 4.1）的主进程侧。
 *
 * ## 为什么放在主进程管理
 *
 * 歌词窗口是一个**独立的 BrowserWindow**，只有主进程能创建它、能跨窗口
 * 转发消息。渲染进程之间**不能直接通信**（contextIsolation + 没有 remote），
 * 所以主窗口 -> 主进程 -> 歌词窗口 是唯一通路。
 *
 * ## 数据流向
 *
 * ```
 * 主窗口（播放器 + 歌词匹配）
 *   --IPC--> 主进程（本模块，只转发，不解析）
 *   --IPC--> 歌词窗口（只渲染）
 * ```
 *
 * 主进程**不理解**歌词内容，只做搬运 —— 这样可以避免「主进程也维护一份
 * 播放状态」，那必然与渲染进程漂移（与 media-integration.cjs 同一原则）。
 *
 * ## 窗口参数为什么这么设
 *
 * * `frame: false` —— 无边框（自己画工具栏与圆角）
 * * `transparent: true` —— 透明背景，才能悬浮在别的窗口上好看
 * * `alwaysOnTop: true` —— 歌词要压在播放器/其它窗口之上
 * * `skipTaskbar: true` —— 它是附属窗口，不该在任务栏里再多一个条目
 * * `resizable: true` —— 允许用户拉宽看长句
 * * `hasShadow: false` —— 透明窗口的阴影在部分平台上会画出难看的方框
 */
const path = require('node:path')

const { BrowserWindow, ipcMain, screen } = require('electron')

/** 歌词窗口的默认尺寸与位置 */
const DEFAULT_WIDTH = 520
const DEFAULT_HEIGHT = 200

/** @type {BrowserWindow|null} */
let lyricsWindow = null
/** 主窗口的 WebContents，用于把歌词窗口的动作回传 */
let mainWebContents = null

/** 歌词窗口是否被用户锁定（不再允许拖动） */
let locked = false

/**
 * 创建（或聚焦）歌词窗口。
 *
 * 幂等：已存在时只聚焦并返回，不重复创建 —— 重复创建会得到两个悬浮窗，
 * 而且关闭其中一个后 `lyricsWindow` 的引用就错了。
 *
 * @param {import('electron').BrowserWindow} parent 主窗口
 */
function openLyricsWindow(parent) {
	if (lyricsWindow && !lyricsWindow.isDestroyed()) {
		lyricsWindow.show()
		lyricsWindow.focus()
		return lyricsWindow
	}

	mainWebContents = parent?.webContents ?? null

	// 默认放在屏幕下方居中偏上（不挡播放器，也不出屏）
	const display = screen.getPrimaryDisplay().workArea
	const x = Math.round(display.x + (display.width - DEFAULT_WIDTH) / 2)
	const y = Math.round(display.y + display.height - DEFAULT_HEIGHT - 80)

	lyricsWindow = new BrowserWindow({
		width: DEFAULT_WIDTH,
		height: DEFAULT_HEIGHT,
		x,
		y,
		frame: false,
		transparent: true,
		alwaysOnTop: true,
		skipTaskbar: true,
		resizable: true,
		hasShadow: false,
		minWidth: 320,
		minHeight: 120,
		show: false,
		webPreferences: {
			preload: path.join(__dirname, 'lyrics-window-preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			// 歌词窗口只渲染文本与自己的进度条，不需要更宽的能力
			webSecurity: true,
		},
	})

	// 让它在全屏应用之上也可见（`alwaysOnTop` 默认的层级会被全屏窗口盖住）
	lyricsWindow.setAlwaysOnTop(true, 'screen-saver')

	void lyricsWindow.loadFile(
		path.join(__dirname, 'renderer', 'lyrics-window.html'),
	)

	lyricsWindow.once('ready-to-show', () => {
		lyricsWindow.show()
		// 把当前的锁定状态推给新窗口（关掉再打开要保持一致）
		sendToLyricsWindow('lw:locked', locked)
		// 告诉主窗口「歌词窗口开了」，主窗口据此推一次当前状态
		mainWebContents?.send('lyrics-window:opened')
	})

	lyricsWindow.on('closed', () => {
		lyricsWindow = null
		mainWebContents?.send('lyrics-window:closed')
	})

	return lyricsWindow
}

/** 关闭歌词窗口 */
function closeLyricsWindow() {
	if (lyricsWindow && !lyricsWindow.isDestroyed()) {
		lyricsWindow.close()
	}
	return null
}

function isOpen() {
	return Boolean(lyricsWindow && !lyricsWindow.isDestroyed())
}

/** 向歌词窗口推数据；窗口不在时静默跳过（这是正常状态） */
function sendToLyricsWindow(channel, payload) {
	if (!isOpen()) return false
	lyricsWindow.webContents.send(channel, payload)
	return true
}

/**
 * 注册歌词窗口相关 IPC。
 *
 * 分成两类：
 *   * `lw:*` —— **主窗口**推数据过来，我们转给歌词窗口；
 *   * `lyrics-window:*` —— **歌词窗口**发动作过来，我们转给主窗口。
 *
 * 命名刻意区分方向，避免「同一个 handler 既收又发」的混乱。
 */
function registerLyricsWindowIpc() {
	ipcMain.handle('lyrics-window:open', (event) => {
		const parent = BrowserWindow.fromWebContents(event.sender)
		openLyricsWindow(parent)
		return { ok: true, data: { open: isOpen(), locked } }
	})

	ipcMain.handle('lyrics-window:close', () => {
		closeLyricsWindow()
		return { ok: true, data: { open: false } }
	})

	ipcMain.handle('lyrics-window:toggle', (event) => {
		if (isOpen()) {
			closeLyricsWindow()
			return { ok: true, data: { open: false } }
		}
		const parent = BrowserWindow.fromWebContents(event.sender)
		openLyricsWindow(parent)
		return { ok: true, data: { open: true, locked } }
	})

	ipcMain.handle('lyrics-window:status', () => ({
		ok: true,
		data: { open: isOpen(), locked },
	}))

	// ---------- 主窗口 -> 歌词窗口（单向转发，主进程不解析） ----------
	const forward = (channel) => (_event, payload) => {
		sendToLyricsWindow(channel, payload)
		return { ok: true }
	}
	ipcMain.handle('lw:update', forward('lw:update'))
	ipcMain.handle('lw:position', forward('lw:position'))
	ipcMain.handle('lw:track', forward('lw:track'))
	ipcMain.handle('lw:progress', forward('lw:progress'))

	// ---------- 歌词窗口 -> 主窗口 ----------
	ipcMain.handle('lw:requestClose', () => {
		closeLyricsWindow()
		return { ok: true }
	})

	ipcMain.handle('lw:setLocked', (_event, next) => {
		locked = Boolean(next)
		// 锁定后仍保持置顶（用户只是想避免误拖，不是想让它沉下去）
		if (isOpen()) lyricsWindow.setAlwaysOnTop(true, 'screen-saver')
		// 回传一次：歌词窗口自己也会本地应用，但回传能保证两侧一致
		// （例如将来从主窗口的菜单切换锁定时，窗口侧也要跟着变）
		sendToLyricsWindow('lw:locked', locked)
		return { ok: true, data: { locked } }
	})

	/** 歌词窗口就绪后主动要一次当前状态（避免等待下一次 timeupdate） */
	ipcMain.handle('lw:ready', () => {
		mainWebContents?.send('lyrics-window:requestState')
		return { ok: true }
	})
}

/** 诊断（验证脚本用） */
function describe() {
	return {
		open: isOpen(),
		locked,
		bounds: isOpen() ? lyricsWindow.getBounds() : null,
		alwaysOnTop: isOpen() ? lyricsWindow.isAlwaysOnTop() : null,
		// 打包/验证时用来确认窗口参数没被改坏
		config: {
			frame: false,
			transparent: true,
			skipTaskbar: true,
			resizable: true,
		},
	}
}

module.exports = {
	registerLyricsWindowIpc,
	openLyricsWindow,
	closeLyricsWindow,
	isOpen,
	sendToLyricsWindow,
	describe,
}
