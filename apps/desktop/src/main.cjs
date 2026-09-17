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

/**
 * 设置应用名，**必须在任何 `app.getPath('userData')` 之前**。
 *
 * 不设的话 Electron 用 `package.json` 的 `name`，而我们是 pnpm 作用域包
 * `@bbplayer/desktop` —— 于是配置目录变成 `~/.config/@bbplayer/desktop`
 * （Windows 上是 `%APPDATA%\@bbplayer\desktop`）。带 `@` 与 `/` 的路径虽然能用，
 * 但对用户很不友好（在文件管理器里像个错误路径）。
 *
 * 在 Linux VPS 上跑打包产物时实测到（`userData=/root/.config/@bbplayer/desktop`）。
 * 注意 `getPath` 会在首次访问后缓存，所以这里必须排在最前面 ——
 * 早于 `ports.cjs`（它读 `getPath('userData')`）。
 */
app.setName('BBPlayer')

// 必须尽早执行：把 userData / sessionData 指到 BBPLAYER_DATA_DIR。
// 放在其他 require 之前，确保 Chromium 初始化缓存时路径已经正确
// （在 ready 之后改路径会导致 network service 崩溃，见 ports.cjs 的说明）。
require('./ports.cjs').configureElectronPaths()

const { handleAudioRequest } = require('./audio-proxy.cjs')
const mediaIntegration = require('./media-integration.cjs')

/** 自验证模式：跑完验证就退出，便于脚本化 */
const PROBE_MODE = process.argv.includes('--probe')
/** 方案对比模式：验证 webRequest 注入这条路（见 compare-driver.cjs） */
const COMPARE_MODE = process.argv.includes('--compare')
/** UI 验收模式：跑 Phase 2 的界面断言序列（见 ui-probe-driver.cjs） */
const UI_PROBE_MODE = process.argv.includes('--ui-probe')
/** 登录验收模式：跑 Phase 3 的登录/收藏夹断言序列（见 login-probe-driver.cjs） */
const LOGIN_PROBE_MODE = process.argv.includes('--login-probe')
/** 媒体集成验收模式：跑 Phase 4 的 MediaSession 断言序列（见 media-probe-driver.cjs） */
const MEDIA_PROBE_MODE = process.argv.includes('--media-probe')
/** 设置验收模式：跑 Phase 4 收尾的桌面特性断言序列（见 settings-probe-driver.cjs） */
const SETTINGS_PROBE_MODE = process.argv.includes('--settings-probe')
/**
 * 打包产物自检模式（见 selfcheck.cjs）。
 *
 * 用于在无 GUI 的 Linux VPS 上验证打包产物能跑，也是 Windows 上
 * 「产物能不能用」的第一道关卡。输出 JSON 后退出。
 */
const SELFCHECK_MODE = process.argv.includes('--selfcheck')
/**
 * headless 模式：**不创建窗口**。
 *
 * VPS 上没有 X server，创建 BrowserWindow 会直接失败
 * （`Missing X server or $DISPLAY`）。所以自检默认**建窗口** —— 这样能
 * 多验证「渲染进程 + preload 契约」那几项；只有在显式传 `--headless`
 * 时才跳过，由外层脚本按「有没有显示环境」决定。
 */
const HEADLESS = process.argv.includes('--headless')
/**
 * 自验证通道的**门控**验证模式。
 *
 * ⚠️ 这个模式**故意不**列进 `PROBE_ENABLED` —— 它要验证的正是
 * 「正常启动时 `window.bbProbe` 不存在」。所以由**主进程**自己用
 * `webContents.executeJavaScript` 去读渲染进程的全局对象
 * （主进程不受 preload 暴露与否的影响），再把结果打出来。
 *
 * 这是唯一能真正验证门控的办法：如果它自己是探针模式，就永远只会看到
 * 「已暴露」，测不出问题。
 */
const VERIFY_GATING_MODE = process.argv.includes('--verify-gating')

/** 对比模式的「不安全」变体：关掉 webSecurity，用于量化其代价 */
const INSECURE_MODE = process.argv.includes('--insecure')
/**
 * 硬件媒体键兜底模式（见 media-integration.cjs）。
 *
 * 默认**关闭**：`globalShortcut` 与渲染进程的 `navigator.mediaSession`
 * 同时生效会让一次按键触发两次。只在需要排查「MediaSession 收不到媒体键」
 * 时打开。
 */
const MEDIA_KEYS_MODE = process.argv.includes('--media-keys')
/**
 * 是否启用自验证通道（`window.bbProbe`）。
 *
 * 任何一个探针/诊断模式开启时都必须启用 —— 否则探针自己就跑不起来
 * （它们全依赖 `bbProbe.execute` / `screenshot`）。正常启动时**不启用**，
 * 按最小权限把 `execute`（在渲染进程里跑任意 JS）这类能力关掉。
 */
const PROBE_ENABLED = [
	'--probe',
	'--ui-probe',
	'--login-probe',
	'--media-probe',
	'--settings-probe',
	'--compare',
	'--diagnose',
	'--selfcheck',
].some((flag) => process.argv.includes(flag))

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
			// 把「是否暴露 bbProbe」这个事实显式传给 preload。
			// 不在 preload 里推断（打包后 NODE_ENV 之类的信号都不可靠）。
			additionalArguments: PROBE_ENABLED ? ['--bb-probe-enabled'] : [],
		},
	})

	// 媒体键交给渲染进程的 `navigator.mediaSession`。
	// Electron 默认可能把媒体键吃在应用菜单的快捷键上，这会抢走 MediaSession
	// 的按键；打开这个开关把它们让出去（Windows 上尤其明显）。
	if (process.platform !== 'darwin') {
		mainWindow.webContents.setIgnoreMenuShortcuts(true)
	}

	// 任务栏缩略图按钮（Windows）：把动作发回本窗口的渲染进程
	mediaIntegration.attach(mainWindow, (action) => {
		mediaIntegration.sendMediaAction(mainWindow, action)
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

	// 媒体键兜底：默认关闭（与 MediaSession 并存会双触发）。
	// 这里只记录「是否被要求」，真正注册由渲染进程读 `mediaInfo()` 后发起 ——
	// 那才代表确实有窗口要这个能力。
	mediaIntegration.setHardwareKeysRequested(MEDIA_KEYS_MODE)
	if (MEDIA_KEYS_MODE) {
		console.log(
			'[desktop] 已要求启用硬件媒体键兜底（globalShortcut）；' +
				'它与 MediaSession 并存会双触发，仅用于排查',
		)
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

	// ---------- 自检模式：跑完输出 JSON 就退出 ----------
	//
	// 默认**建窗口**并等它加载完，这样能顺带验证「渲染进程 + preload 契约」；
	// 传 `--headless` 才跳过（VPS 上没有 X server，建窗口会直接失败）。
	if (SELFCHECK_MODE) {
		const { run: runSelfcheck } = require('./selfcheck.cjs')

		const emit = (result) => {
			console.log(`__SELFCHECK__${JSON.stringify(result)}`)
			// 给 stdout 一点刷新时间再退出
			setTimeout(() => app.exit(0), 300)
		}

		if (HEADLESS) {
			// 无窗口：selfcheck 会据此把渲染进程那几项记为「跳过」
			void runSelfcheck(null, { app })
				.catch((error) =>
					emit({
						ok: false,
						failures: [`自检崩溃：${error.message}`],
						stack: String(error.stack ?? '')
							.split('\n')
							.slice(0, 8),
					}),
				)
				.then(emit)
			return
		}

		// 有窗口：必须等 `did-finish-load`，否则渲染进程还没执行到
		// `window.__bbReady`，会误报「渲染进程未就绪」。
		createWindow()
		mainWindow.webContents.once('did-finish-load', () => {
			// 给渲染进程的 boot() 一点时间完成（它会读设置、建面板）
			setTimeout(() => {
				void runSelfcheck(mainWindow, { app })
					.catch((error) =>
						emit({
							ok: false,
							failures: [`自检崩溃：${error.message}`],
							stack: String(error.stack ?? '')
								.split('\n')
								.slice(0, 8),
						}),
					)
					.then(emit)
			}, 3000)
		})
		return
	}

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
	} else if (MEDIA_PROBE_MODE) {
		// 媒体集成验收：跑 Phase 4 的 MediaSession 断言序列
		mainWindow.webContents.once('did-finish-load', () => {
			const { run } = require('./media-probe-driver.cjs')
			void run(mainWindow)
				.catch((error) => {
					console.error('[desktop] 媒体探针执行失败:', error)
				})
				.finally(() => {
					setTimeout(() => app.exit(0), 500)
				})
		})
	} else if (SETTINGS_PROBE_MODE) {
		// 设置验收：跑 Phase 4 收尾的桌面特性断言序列
		mainWindow.webContents.once('did-finish-load', () => {
			const { run } = require('./settings-probe-driver.cjs')
			void run(mainWindow)
				.catch((error) => {
					console.error('[desktop] 设置探针执行失败:', error)
				})
				.finally(() => {
					setTimeout(() => app.exit(0), 500)
				})
		})
	} else if (VERIFY_GATING_MODE) {
		// 门控验证：本模式**不在** PROBE_ENABLED 里，所以 bbProbe **不应**暴露。
		// 主进程自己去渲染进程读全局对象（不受 preload 暴露与否影响）。
		//
		// ⚠️ 必须处理 headless：没有 X server 时创建窗口会**挂住**（实测在
		// Debian VPS 上 `--verify-gating` 一直不退出，探针等到 90s 超时，
		// 报「没有输出」）。headless 下改为只报主进程算出的 PROBE_ENABLED，
		// 并把渲染进程那项标为跳过 —— 少了最强的那条证据，但不能因此挂死。
		if (HEADLESS) {
			setTimeout(() => {
				console.log(
					`__GATING__${JSON.stringify({
						headless: true,
						probeEnabled: PROBE_ENABLED,
						note: 'headless：未创建窗口，无法读取渲染进程侧的 typeof window.bbProbe；完整门控验证需要显示环境（VPS 上可用 xvfb-run）',
					})}`,
				)
				setTimeout(() => app.exit(0), 200)
			}, 500)
			return
		}

		createWindow()
		mainWindow.webContents.once('did-finish-load', () => {
			setTimeout(async () => {
				try {
					const result = await mainWindow.webContents.executeJavaScript(
						`(() => ({
							probeEnabled: ${PROBE_ENABLED},
							hasBbProbe: typeof window.bbProbe,
							hasBbplayer: typeof window.bbplayer,
							hasSettings: typeof window.bbplayer?.settings,
							ready: Boolean(window.__bbReady),
						}))()`,
						true,
					)
					console.log(`__GATING__${JSON.stringify(result)}`)
				} catch (error) {
					console.log(
						`__GATING__${JSON.stringify({ error: String(error.message) })}`,
					)
				}
				setTimeout(() => app.exit(0), 300)
			}, 3000)
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
