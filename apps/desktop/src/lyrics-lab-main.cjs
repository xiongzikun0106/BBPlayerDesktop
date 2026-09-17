/**
 * 歌词测试台（lyrics-lab.html）的**独立主进程入口**。
 *
 * 为什么要单独一个入口：`main.cjs` 正在被别人改，这里不去动它。
 * 这个文件只做三件事：
 *  1. `require('./ports.cjs')` —— 复用已注册好的 core 端口（http / logger / db…），
 *     这是取平台能力的唯一正确方式；
 *  2. 把 core 的歌词 API 通过 `contextBridge` 暴露给测试页；
 *  3. 提供 `capture()` 把窗口截图落盘，供 `read_image` 人眼核对。
 *
 * 用法：
 *   apps/desktop/node_modules/electron/dist/electron.exe apps/desktop/src/lyrics-lab-main.cjs
 * 环境变量：
 *   BBPLAYER_LYRICS_LAB_AUTOSHOT=1      加载完自动截一张 lab-auto.png
 *   BBPLAYER_LYRICS_LAB_SCRIPT=<file>   加载完后执行该文件里的 JS（用于驱动面板）
 */
/* oxlint-disable no-console -- 测试台入口，向终端输出诊断信息 */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { createJiti } = require('jiti')

// 加载 ports.cjs 的同时就完成了 registerCorePorts()，之后任何 core 调用都能拿到端口
const { core } = require('./ports.cjs')

const SHOT_DIR = path.join(__dirname, '..', 'probe-output', 'lyrics-lab')
const RENDERER_DIR = path.join(__dirname, 'renderer')

/**
 * 用 jiti 加载 `@bbplayer/splash`。
 *
 * 直接 `require('@bbplayer/splash')` 会拿到 `.ts` 入口，CJS 解析不了；
 * 而且**绝不能**从它的 barrel（`src/index.ts`）导入 —— 该包没有
 * `"type": "module"`，Node 会把 `export * from './parser/merge'` 当成 CJS
 * 再导出，ESM 侧只看得见 `default`，命名导入会直接报
 * “does not provide an export named ...”。所以按子路径精确加载。
 */
const splashJiti = createJiti(__filename, {
	interopDefault: true,
	moduleCache: true,
	fsCache: false,
})
const SPLASH_ROOT = path.resolve(
	__dirname,
	'..',
	'..',
	'..',
	'packages',
	'splash',
	'src',
)
const parseAndMergeLyrics = splashJiti(
	path.join(SPLASH_ROOT, 'parser', 'merge.ts'),
).parseAndMergeLyrics

let mainWindow = null

/** 统一把异常转成 `{ ok: false, error }`，避免渲染进程只看到 “Error invoking…” */
function toError(error) {
	return {
		ok: false,
		error: error instanceof Error ? error.message : String(error),
	}
}

/** 只保留面板需要的字段（IPC 通道要求可结构化克隆） */
function serializeLines(lines) {
	return (lines ?? []).map((line) => ({
		startTime: line.startTime,
		endTime: line.endTime,
		content: line.content,
		translation: line.translation ?? null,
		romaji: line.romaji ?? null,
	}))
}

function registerLyricsLabIpc() {
	ipcMain.handle('lyrics-lab:search', async (_event, payload) => {
		try {
			const keyword =
				typeof payload?.keyword === 'string' ? payload.keyword.trim() : ''
			if (!keyword) return { ok: false, error: '关键词为空' }
			const limit = Number.isFinite(payload?.limit) ? Number(payload.limit) : 10

			const search = await core.neteaseLyricsApiClient.searchLyrics(
				keyword,
				limit,
			)
			if (search.isErr()) return { ok: false, error: search.error.message }

			const candidates = core.toLyricsCandidates(search.value)
			// 若调用方给了目标歌曲元信息，就带上时长参与打分
			const song = payload?.song ?? { title: keyword }
			const ranked = core.rankLyricsCandidates(song, candidates)

			return {
				ok: true,
				keyword,
				rawCount: search.value.length,
				ranked: ranked.map((item) => ({
					score: item.score,
					titleScore: item.titleScore,
					artistScore: item.artistScore,
					durationScore: item.durationScore,
					candidate: {
						remoteId: item.candidate.remoteId,
						title: item.candidate.title,
						artist: item.candidate.artist,
						duration: item.candidate.duration ?? null,
						album: item.candidate.album ?? null,
					},
				})),
			}
		} catch (error) {
			return toError(error)
		}
	})

	ipcMain.handle('lyrics-lab:lyrics', async (_event, payload) => {
		try {
			const songId = Number(payload?.songId)
			const fetched = await core.neteaseLyricsApiClient.fetchLyricsById(songId)
			if (fetched.isErr()) return { ok: false, error: fetched.error.message }

			const { lrc, tlyric, romalrc, isInstrumental } = fetched.value
			if (isInstrumental || !lrc) {
				return {
					ok: true,
					songId,
					isInstrumental: true,
					lines: [],
					rawLrcLength: 0,
					hasTranslation: false,
				}
			}

			const merged = parseAndMergeLyrics({
				lrc,
				...(tlyric ? { tlyric } : {}),
				...(romalrc ? { romalrc } : {}),
			})

			return {
				ok: true,
				songId,
				isInstrumental: false,
				rawLrcLength: lrc.length,
				hasTranslation: Boolean(tlyric),
				hasRomaji: Boolean(romalrc),
				lines: serializeLines(merged),
			}
		} catch (error) {
			return toError(error)
		}
	})

	ipcMain.handle('lyrics-lab:capture', async (_event, name) => {
		try {
			if (!mainWindow) return { ok: false, error: '窗口不存在' }
			const image = await mainWindow.webContents.capturePage()
			fs.mkdirSync(SHOT_DIR, { recursive: true })
			const safe = String(name || 'shot').replace(/[^\w.-]/g, '_')
			const file = path.join(SHOT_DIR, `${safe}.png`)
			fs.writeFileSync(file, image.toPNG())
			return { ok: true, file }
		} catch (error) {
			return toError(error)
		}
	})
}

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1200,
		height: 820,
		backgroundColor: '#1C1B1F',
		show: true,
		webPreferences: {
			preload: path.join(__dirname, 'lyrics-lab-preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
		},
	})
	return mainWindow
}

/** 加载完成后按环境变量决定是否自动截图 / 跑脚本 */
async function runPostLoad(win) {
	const scriptFile = process.env.BBPLAYER_LYRICS_LAB_SCRIPT
	if (scriptFile && fs.existsSync(scriptFile)) {
		const code = fs.readFileSync(scriptFile, 'utf8')
		try {
			const result = await win.webContents.executeJavaScript(code, true)
			console.log('[lyrics-lab] 注入脚本返回:', JSON.stringify(result))
		} catch (error) {
			console.error('[lyrics-lab] 注入脚本执行失败:', error)
		}
	}

	if (process.env.BBPLAYER_LYRICS_LAB_AUTOSHOT === '1') {
		const image = await win.webContents.capturePage()
		fs.mkdirSync(SHOT_DIR, { recursive: true })
		const file = path.join(SHOT_DIR, 'lab-auto.png')
		fs.writeFileSync(file, image.toPNG())
		console.log('[lyrics-lab] 自动截图:', file)
	}

	if (process.env.BBPLAYER_LYRICS_LAB_EXIT === '1') {
		// 延迟 1s：截图与报告写盘需要一点时间，但绝不能无限等（否则会挂住终端）
		setTimeout(() => app.exit(0), 1000)
	}
}

// 显式 void：这是「即发即忘」的启动流程，错误在内部处理
void app.whenReady().then(() => {
	registerLyricsLabIpc()
	const win = createWindow()

	win.webContents.once('did-finish-load', () => {
		console.log('[lyrics-lab] 页面已加载')
		runPostLoad(win).catch((error) => {
			console.error('[lyrics-lab] 加载后处理失败:', error)
		})
	})

	void win.loadFile(path.join(RENDERER_DIR, 'lyrics-lab.html'))
})

app.on('window-all-closed', () => {
	app.quit()
})
