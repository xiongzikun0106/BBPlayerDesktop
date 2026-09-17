/**
 * Electron 主进程（Phase 1 骨架）。
 *
 * 职责：
 *  - 注册 `bbplayer-audio://` 特权协议，把 B 站音频经主进程代理给渲染进程
 *    （防盗链 + CORS 的解法，见 audio-proxy.cjs 与 docs/DESKTOP_PLAN.md §2.3）
 *  - 提供最小 IPC：解析音轨、读取代理请求日志
 *  - 提供自验证通道（`--probe`）：截图 + 执行渲染进程脚本，便于自动化验证
 */
/* oxlint-disable no-console -- 探针模式需要向父进程输出状态 */
const { app, BrowserWindow, ipcMain, protocol } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// 必须尽早执行：把 userData / sessionData 指到 BBPLAYER_DATA_DIR。
// 放在其他 require 之前，确保 Chromium 初始化缓存时路径已经正确
// （在 ready 之后改路径会导致 network service 崩溃，见 ports.cjs 的说明）。
require('./ports.cjs').configureElectronPaths()

const { handleAudioRequest } = require('./audio-proxy.cjs')

/** 自验证模式：跑完验证就退出，便于脚本化 */
const PROBE_MODE = process.argv.includes('--probe')
/** 方案对比模式：验证 webRequest 注入这条路（见 compare-driver.cjs） */
const COMPARE_MODE = process.argv.includes('--compare')
/** UI 验收模式：跑 Phase 2 的界面断言序列（见 ui-probe-driver.cjs） */
const UI_PROBE_MODE = process.argv.includes('--ui-probe')
/** 登录验收模式：跑 Phase 3 的登录/收藏夹断言序列（见 login-probe-driver.cjs） */
const LOGIN_PROBE_MODE = process.argv.includes('--login-probe')
/** 对比模式的「不安全」变体：关掉 webSecurity，用于量化其代价 */
const INSECURE_MODE = process.argv.includes('--insecure')
const SHOT_DIR = path.join(__dirname, '..', 'probe-output')

// 自定义协议必须在 app ready 之前声明特权：
//  - standard: 让 URL 解析行为与 http 一致
//  - stream:   允许流式响应（音频必须）
//  - supportFetchAPI: 允许渲染进程用 fetch 访问（验证用）
protocol.registerSchemesAsPrivileged([
	{
		scheme: 'bbplayer-audio',
		privileges: {
			standard: true,
			secure: true,
			stream: true,
			supportFetchAPI: true,
			bypassCSP: true,
			corsEnabled: true,
		},
	},
])

let mainWindow = null

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1100,
		height: 760,
		backgroundColor: '#1C1B1F',
		show: true,
		webPreferences: {
			preload: path.join(__dirname, 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			// 生产路径**不需要** webSecurity:false —— 音频走自定义协议，CORS 由协议层解决。
			// 仅在 `--compare --insecure` 下才关闭，用来量化「方案 B 到底要付什么代价」。
			webSecurity: !INSECURE_MODE,
		},
	})

	void mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
	return mainWindow
}

/**
 * 方案 B（webRequest 注入）所需的头注入。
 *
 * 只在 `--compare` 模式下挂载；默认的生产路径不挂，因为音频走自定义协议，
 * 由 audio-proxy.cjs 自己带头发请求。
 */
function installWebRequestHeaderInjection() {
	const { session } = require('electron')
	const filter = { urls: ['*://*.bilivideo.com/*', '*://*.bilivideo.cn/*'] }
	session.defaultSession.webRequest.onBeforeSendHeaders(
		filter,
		(details, callback) => {
			const headers = { ...details.requestHeaders }
			headers.Referer = 'https://www.bilibili.com/'
			headers['User-Agent'] =
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
			callback({ requestHeaders: headers })
		},
	)
	console.log('[desktop] 已挂载 webRequest 头注入（对比模式）')
}

/**
 * 诊断模式：加载页面、收集控制台错误与失败请求，打印后退出。
 *
 * 用途：渲染进程脚本报错时，`window.__bbReady` 永远不会置位，探针只会说
 * 「未就绪」而看不到原因。这里把真实错误打出来。
 */
function installDiagnostics() {
	const errors = []
	const consoleMessages = []

	mainWindow.webContents.on(
		'console-message',
		(_event, level, message, line, source) => {
			consoleMessages.push({ level, message, line, source })
		},
	)
	mainWindow.webContents.on(
		'did-fail-load',
		(_event, errorCode, errorDescription, validatedURL) => {
			errors.push({
				type: 'did-fail-load',
				errorCode,
				errorDescription,
				validatedURL,
			})
		},
	)
	mainWindow.webContents.on('render-process-gone', (_event, details) => {
		errors.push({ type: 'render-process-gone', details })
	})

	return { errors, consoleMessages }
}

// 显式 void：Electron 的 ready 回调是「即发即忘」，内部已有错误处理
void app.whenReady().then(() => {
	// 协议处理器：所有 bbplayer-audio:// 请求都走主进程代理。
	// ⚠️ 必须在 createWindow() 之前注册，否则会静默失效（实测）。
	protocol.handle('bbplayer-audio', handleAudioRequest)

	// 数据库：建库（幂等）
	const { registerIpcHandlers, ensureDatabase } = require('./ipc-handlers.cjs')
	const migration = ensureDatabase()
	if (migration.executed.length > 0) {
		console.log(`[desktop] 已应用迁移: ${migration.executed.join(', ')}`)
	}

	// 登录管理器：必须在 registerIpcHandlers() / createWindow() 之前注册，
	// 因为 IPC handler 与 core 的凭据端口都通过 holder 取它。
	// 也必须放在 app ready 之后 —— safeStorage 只有 ready 后才可用。
	const { createLoginManager } = require('./bilibili-login.cjs')
	const { setLoginManager } = require('./bilibili-login-holder.cjs')
	const ports = require('./ports.cjs')
	const loginManager = createLoginManager({
		cookieFile: path.join(ports.DATA_DIR, 'bilibili-cookie.json'),
		warn: (level, message) => {
			// 统一走 logger 端口：写文件 + 控制台（error 级别总输出）
			const log = ports.logger.extend('login')
			const write = log[level] ?? log.info
			write.call(log, message)
		},
	})
	setLoginManager(loginManager)
	if (!loginManager.describe().encrypted) {
		console.log('[desktop] 系统密钥环不可用，cookie 将以混淆方式（非加密）存储')
	}

	registerIpcHandlers()

	/** 截图到文件，供多模态核对 */
	ipcMain.handle('probe:screenshot', async (_event, name) => {
		if (!mainWindow) return { ok: false, error: 'no window' }
		const image = await mainWindow.webContents.capturePage()
		fs.mkdirSync(SHOT_DIR, { recursive: true })
		const file = path.join(SHOT_DIR, `${name || 'shot'}.png`)
		fs.writeFileSync(file, image.toPNG())
		return { ok: true, file }
	})

	/** 在渲染进程里执行脚本（自动化点击/断言用） */
	ipcMain.handle('probe:execute', async (_event, code) => {
		if (!mainWindow) return { ok: false, error: 'no window' }
		try {
			const result = await mainWindow.webContents.executeJavaScript(code, true)
			return { ok: true, result }
		} catch (error) {
			return { ok: false, error: String(error) }
		}
	})

	createWindow()

	if (process.argv.includes('--diagnose')) {
		const diagnostics = installDiagnostics()
		mainWindow.webContents.once('did-finish-load', () => {
			setTimeout(async () => {
				const state = await mainWindow.webContents
					.executeJavaScript(
						`JSON.stringify({
							ready: Boolean(window.__bbReady),
							hasState: typeof window.bbState,
							hasPlayer: typeof window.bbPlayer,
							hasLibrary: typeof window.bbLibrary,
							hasKeys: typeof window.bbKeys,
							hasUI: typeof window.bbUI,
							hasTest: typeof window.bbTest,
							bodyHtmlLength: document.body.innerHTML.length,
						})`,
						true,
					)
					.catch((error) => `{"probeError":"${error.message}"}`)

				console.log('=== 诊断 ===')
				console.log('渲染进程状态:', state)
				if (diagnostics.consoleMessages.length > 0) {
					console.log('\n控制台消息:')
					for (const message of diagnostics.consoleMessages) {
						console.log(
							`  [${message.level}] ${message.message}  (${message.source}:${message.line})`,
						)
					}
				}
				if (diagnostics.errors.length > 0) {
					console.log('\n加载错误:')
					for (const error of diagnostics.errors) {
						console.log(`  ${JSON.stringify(error)}`)
					}
				}
				app.exit(0)
			}, 3000)
		})
	} else if (UI_PROBE_MODE) {
		// UI 验收：跑界面断言序列（三栏 / 导入 / 播放 / 快捷键 / 搜索）
		mainWindow.webContents.once('did-finish-load', () => {
			const { run } = require('./ui-probe-driver.cjs')
			void run(mainWindow)
				.catch((error) => {
					console.error('[desktop] UI 探针执行失败:', error)
				})
				.finally(() => {
					setTimeout(() => app.exit(0), 500)
				})
		})
	} else if (LOGIN_PROBE_MODE) {
		// 登录验收：跑 Phase 3 的登录/收藏夹界面断言序列
		mainWindow.webContents.once('did-finish-load', () => {
			const { run } = require('./login-probe-driver.cjs')
			void run(mainWindow)
				.catch((error) => {
					console.error('[desktop] 登录探针执行失败:', error)
				})
				.finally(() => {
					setTimeout(() => app.exit(0), 500)
				})
		})
	} else if (COMPARE_MODE) {
		installWebRequestHeaderInjection()
		// 网络追踪必须在窗口发起任何请求之前挂上，否则会漏掉 <audio> 的早期请求
		require('./compare-driver.cjs').installNetworkTracer()
		mainWindow.webContents.once('did-finish-load', () => {
			const { run } = require('./compare-driver.cjs')
			void run(mainWindow)
				.catch((error) => {
					console.error('[desktop] 对比探针执行失败:', error)
				})
				.finally(() => {
					setTimeout(() => app.exit(0), 500)
				})
		})
	} else if (PROBE_MODE) {
		// 探针模式：等页面加载完，跑完整验证序列，然后退出
		mainWindow.webContents.once('did-finish-load', () => {
			const { run } = require('./probe-driver.cjs')
			// 显式 void：这是事件回调里的「即发即忘」调用；错误已在 catch 里
			// 处理并打过日志，不应再向事件循环抛出未处理的 rejection。
			void run(mainWindow)
				.catch((error) => {
					console.error('[desktop] 探针执行失败:', error)
				})
				.finally(() => {
					// 给报告与截图一点落盘时间
					setTimeout(() => app.exit(0), 500)
				})
		})
	}
})

app.on('window-all-closed', () => {
	app.quit()
})

// 供验证脚本判断「主进程已就绪」
if (PROBE_MODE) {
	console.log('[desktop] probe mode enabled')
}
