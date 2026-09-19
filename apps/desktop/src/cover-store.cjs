/**
 * 歌单自定义封面的**文件存放**与 `bbplayer-cover://` 协议（阶段 C-2d）。
 *
 * ## 为什么要这么绕
 *
 * 用户要求"歌单封面要能自定义"，并且选了**从本地选图**。
 * 但渲染进程（页面）**不能直接读本地文件**：`index.html` 的 CSP 不允许 `file:`，
 * 而且页面本来也不该有文件系统的能力。
 *
 * 所以走和音频一样的路子：**主进程持文件、页面用自定义协议取**。
 *   * 选中的图**复制**进 `<数据目录>/covers/`（不是引用原路径 —— 用户可能
 *     把原图删了/移走，那时封面就变成破图）；
 *   * `playlists.cover_url` 存的是 `bbplayer-cover://<文件名>`，
 *     于是"自定义封面"和"B 站封面（https）"在数据层是同一种东西，
 *     侧栏、卡片网格、正在播放三处都不需要分支。
 *
 * ## 安全边界
 *
 * 这个协议会把**文件内容**回给页面，所以文件名必须严格白名单校验
 * （只允许我们自己生成的 `cover-<数字>.<扩展名>`），否则 `../../` 就能读到
 * 任意文件。扩展名也限定在图片里。
 */
const fs = require('node:fs')
const path = require('node:path')

// `ports.cjs` 在 require 时就把数据目录解析好了（`BBPLAYER_DATA_DIR` 或 userData），
// 并已经 `mkdirSync` 过 —— 这里直接用，不要自己再算一遍（两处算法迟早不一致）
const { DATA_DIR } = require('./ports.cjs')

/** 允许的图片扩展名 → Content-Type */
const MIME = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
	'.bmp': 'image/bmp',
}

/** 我们自己生成的文件名格式（协议只认这个，杜绝路径穿越） */
const SAFE_NAME = /^cover-\d+\.(png|jpe?g|webp|gif|bmp)$/i

function coversDir() {
	const dir = path.join(DATA_DIR, 'covers')
	fs.mkdirSync(dir, { recursive: true })
	return dir
}

/**
 * 把用户选中的图片复制进数据目录，返回可直接存进 `cover_url` 的协议 URL。
 *
 * @param {number|string} playlistId
 * @param {string} sourcePath 用户选中的文件（`dialog.showOpenDialog` 给的）
 * @returns {string} `bbplayer-cover://cover-<id>.<ext>`
 */
function saveCoverFromFile(playlistId, sourcePath) {
	const ext = path.extname(sourcePath).toLowerCase()
	if (!MIME[ext]) throw new Error(`不支持的图片格式：${ext || '(无扩展名)'}`)
	const stat = fs.statSync(sourcePath)
	if (stat.size > 8 * 1024 * 1024) {
		throw new Error('图片太大了（上限 8 MB）')
	}

	const name = `cover-${playlistId}${ext}`
	const target = path.join(coversDir(), name)
	// 换格式重设封面时，先把旧文件删掉，免得同一个歌单留一堆孤儿文件
	removeCoverFiles(playlistId)
	fs.copyFileSync(sourcePath, target)
	return `bbplayer-cover://${name}`
}

/** 删掉某个歌单已有的封面文件（任何扩展名） */
function removeCoverFiles(playlistId) {
	const dir = coversDir()
	const prefix = `cover-${playlistId}.`
	for (const entry of fs.readdirSync(dir)) {
		if (entry.startsWith(prefix)) {
			try {
				fs.unlinkSync(path.join(dir, entry))
			} catch {
				// 删不掉不影响"换一张新封面"
			}
		}
	}
}

/**
 * `protocol.handle('bbplayer-cover', …)` 的处理器。
 *
 * Electron 42 的 `protocol.handle` 要求返回一个 `Response`。
 */
async function handleCoverRequest(request) {
	let name = ''
	try {
		// `bbplayer-cover://cover-3.png` → host 是 `cover-3.png`（standard 协议）
		const url = new URL(request.url)
		name = decodeURIComponent(url.hostname || url.pathname.replace(/^\//, ''))
	} catch {
		return new Response('bad url', { status: 400 })
	}

	if (!SAFE_NAME.test(name)) {
		return new Response('forbidden', { status: 403 })
	}

	const file = path.join(coversDir(), name)
	try {
		const bytes = fs.readFileSync(file)
		return new Response(bytes, {
			status: 200,
			headers: {
				'content-type': MIME[path.extname(name).toLowerCase()],
				// 文件名带歌单 id、内容会被替换（换封面）—— 不要长缓存
				'cache-control': 'no-store',
			},
		})
	} catch {
		return new Response('not found', { status: 404 })
	}
}

module.exports = {
	SCHEME: 'bbplayer-cover',
	MIME,
	SAFE_NAME,
	coversDir,
	saveCoverFromFile,
	removeCoverFiles,
	handleCoverRequest,
}
