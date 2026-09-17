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

const {
	handleAudioRequest,
	requestLog,
	resolveAudio,
} = require('./audio-proxy.cjs')

/** 自验证模式：跑完验证就退出，便于脚本化 */
const PROBE_MODE = process.argv.includes('--probe')
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
			// 注意：不需要 webSecurity:false —— 音频走自定义协议，CORS 由协议层解决
		},
	})

	void mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
	return mainWindow
}

// 显式 void：Electron 的 ready 回调是「即发即忘」，内部已有错误处理
void app.whenReady().then(() => {
	// 协议处理器：所有 bbplayer-audio:// 请求都走主进程代理
	protocol.handle('bbplayer-audio', handleAudioRequest)

	ipcMain.handle('audio:resolve', async (_event, bvid) => {
		try {
			const info = await resolveAudio(bvid)
			return {
				ok: true,
				data: {
					bvid: info.bvid,
					cid: info.cid,
					title: info.title,
					duration: info.duration,
					quality: info.quality,
					bandwidth: info.bandwidth,
					proxyUrl: `bbplayer-audio://track/${encodeURIComponent(info.bvid)}`,
					upstreamHost: new URL(info.audioUrl).host,
					backupUrlCount: info.backupUrls.length,
				},
			}
		} catch (error) {
			return { ok: false, error: String(error) }
		}
	})

	ipcMain.handle('probe:request-log', () => requestLog)

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

	if (PROBE_MODE) {
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
