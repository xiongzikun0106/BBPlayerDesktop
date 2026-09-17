/* oxlint-disable no-console -- 探针脚本，以 stdout 输出验证过程 */
/**
 * 探针驱动：在 Electron 主进程里跑完整的播放验证序列。
 *
 * 由 main.cjs 在 `--probe` 模式下调用。之所以放在主进程而不是外部脚本：
 *  - `webContents.executeJavaScript` 能直接驱动渲染进程做点击级操作；
 *  - `webContents.capturePage` 能截图落盘；
 *  - 不需要额外安装 Playwright/Puppeteer。
 */
const fs = require('node:fs')
const path = require('node:path')
const { net } = require('electron')

const { requestLog } = require('./audio-proxy.cjs')

const OUTPUT = path.join(__dirname, '..', 'probe-output')
const SHOT_DIR = path.join(OUTPUT, 'shots')
const REPORT = path.join(OUTPUT, 'report.json')

const TEST_BVID = 'BV1GJ411x7h7'

const checks = []
const screenshots = []

function check(name, ok, detail) {
	checks.push({ name, ok: Boolean(ok), detail: detail ?? null })
	console.log(
		`[probe] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`,
	)
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function shot(window, name) {
	// capturePage 在页面尚未完成首次绘制时会抛 UnknownVizError，
	// 这里小睡 + 重试，避免把「时机问题」误报成「功能问题」。
	for (let attempt = 1; attempt <= 4; attempt++) {
		try {
			await sleep(attempt === 1 ? 700 : 500)
			const image = await window.webContents.capturePage()
			const size = image.getSize()
			if (size.width === 0 || size.height === 0) {
				throw new Error(`空图像 (${size.width}x${size.height})`)
			}
			fs.mkdirSync(SHOT_DIR, { recursive: true })
			const file = path.join(SHOT_DIR, `${name}.png`)
			fs.writeFileSync(file, image.toPNG())
			screenshots.push(file)
			console.log(`[probe] 截图: ${file} (${size.width}x${size.height})`)
			return file
		} catch (error) {
			console.log(`[probe] 截图重试 ${attempt}/4 ${name}: ${error.message}`)
		}
	}
	console.log(`[probe] 截图失败 ${name}`)
	return null
}

/** 在渲染进程里执行表达式并取回结果 */
async function evaluate(window, expression) {
	return await window.webContents.executeJavaScript(expression, true)
}

async function run(window) {
	fs.mkdirSync(OUTPUT, { recursive: true })

	console.log('[probe] 等待渲染进程就绪…')
	// 重试等待 window.__bbReady
	let ready = false
	for (let attempt = 0; attempt < 60; attempt++) {
		try {
			ready = await evaluate(window, 'Boolean(window.__bbReady)')
		} catch {
			ready = false
		}
		if (ready) break
		await sleep(250)
	}
	check('渲染进程加载完成（window.__bbReady）', ready)
	if (!ready) return finish(window)

	// UI 真的渲染出了按钮？
	const buttons = await evaluate(
		window,
		'JSON.stringify(window.bbTest.buttons())',
	)
	const buttonList = JSON.parse(buttons)
	check(
		'UI 渲染出可点击按钮',
		buttonList.length >= 4,
		`${buttonList.length} 个：${buttonList.join(' / ')}`,
	)
	await shot(window, '01-idle')

	// ---------------------------------------------------------------
	// 1. 解析 + 加载
	// ---------------------------------------------------------------
	console.log('\n[probe] 1) 解析并加载音频')
	const loadResult = JSON.parse(
		await evaluate(
			window,
			`(async () => JSON.stringify(await window.bbTest.load('${TEST_BVID}')))()`,
		),
	)
	check(
		'自定义协议 + <audio> 能加载出元数据（readyState>=1）',
		loadResult.ok && loadResult.readyState >= 1,
		`readyState=${loadResult.readyState} duration=${loadResult.duration}`,
	)
	check(
		'拿到有效时长',
		Number.isFinite(loadResult.duration) && loadResult.duration > 0,
		`${loadResult.duration}s`,
	)
	check(
		'加载阶段无媒体错误',
		!loadResult.error,
		loadResult.error ? JSON.stringify(loadResult.error) : '无',
	)
	await shot(window, '02-loaded')

	// ---------------------------------------------------------------
	// 2. 播放
	// ---------------------------------------------------------------
	console.log('\n[probe] 2) 播放')
	const playResult = JSON.parse(
		await evaluate(
			window,
			'(async () => JSON.stringify(await window.bbTest.play()))()',
		),
	)
	check(
		'能真正开始播放（paused=false 且 currentTime>0）',
		playResult.ok,
		`currentTime=${playResult.currentTime} paused=${playResult.paused}`,
	)

	// 让时间推进
	const advance = JSON.parse(
		await evaluate(
			window,
			'(async () => JSON.stringify(await window.bbTest.advance(2500)))()',
		),
	)
	check(
		'播放时间确实在推进',
		advance.advanced > 1,
		`${advance.start.toFixed(2)}s → ${advance.end.toFixed(2)}s（+${advance.advanced.toFixed(2)}s）`,
	)
	await shot(window, '03-playing')

	// ---------------------------------------------------------------
	// 3. seek
	// ---------------------------------------------------------------
	console.log('\n[probe] 3) 拖动 seek')
	const seekResult = JSON.parse(
		await evaluate(
			window,
			'(async () => JSON.stringify(await window.bbTest.seek(30)))()',
		),
	)
	check(
		'seek 生效（触发 seeked 且位置跳到目标）',
		seekResult.ok && seekResult.after > 25,
		`${seekResult.before.toFixed(2)}s → ${seekResult.after.toFixed(2)}s`,
	)
	await sleep(1200)
	await shot(window, '04-after-seek')

	// ---------------------------------------------------------------
	// 4. 代理请求日志：确认 Range 与注入的请求头
	// ---------------------------------------------------------------
	console.log('\n[probe] 4) 代理请求日志')
	const log = requestLog
	const resolvedEntries = log.filter((entry) => entry.upstreamStatus)
	check(
		'主进程代理收到过音频请求',
		resolvedEntries.length > 0,
		`${resolvedEntries.length} 次`,
	)

	const upstreamOk = resolvedEntries.filter(
		(entry) => entry.upstreamStatus === 200 || entry.upstreamStatus === 206,
	)
	check(
		'上游 CDN 返回 200/206（说明 Referer 注入生效）',
		upstreamOk.length > 0,
		`状态码：${[...new Set(resolvedEntries.map((e) => e.upstreamStatus))].join(', ')}`,
	)

	const rangeEntries = log.filter((entry) => entry.range)
	check(
		'代理收到并转发了 Range 请求（seek 走 206）',
		rangeEntries.length > 0,
		`${rangeEntries.length} 次带 Range`,
	)

	// 用 Electron 自己的 net.fetch 直连代理，做一次**严格的 Range 验证**：
	// 媒体元素的请求时机不可控，但「代理本身是否透传 206」可以确定地测出来。
	console.log('\n[probe] 5) 直连代理的严格 Range 测试')
	let strictRange = null
	try {
		const proxyUrl = `bbplayer-audio://track/${encodeURIComponent(TEST_BVID)}`
		const response = await net.fetch(proxyUrl, {
			headers: { Range: 'bytes=1000000-1001023' },
		})
		const body = await response.arrayBuffer()
		strictRange = {
			status: response.status,
			contentRange: response.headers.get('content-range'),
			acceptRanges: response.headers.get('accept-ranges'),
			contentType: response.headers.get('content-type'),
			bytes: body.byteLength,
		}
	} catch (error) {
		strictRange = { error: String(error) }
	}

	check(
		'代理对 Range 请求返回 206（严格测试）',
		strictRange?.status === 206,
		JSON.stringify(strictRange),
	)
	check(
		'Content-Range 正确（bytes 1000000-1001023/…）',
		typeof strictRange?.contentRange === 'string' &&
			strictRange.contentRange.startsWith('bytes 1000000-1001023/'),
		strictRange?.contentRange ?? '无',
	)
	check(
		'只回传请求的 1024 字节（没把整个文件吐出来）',
		strictRange?.bytes === 1024,
		`${strictRange?.bytes} 字节`,
	)

	const r206 = resolvedEntries.filter((entry) => entry.upstreamStatus === 206)
	check('上游对 Range 请求返回 206', r206.length > 0, `${r206.length} 次 206`)

	const hosts = [...new Set(resolvedEntries.map((entry) => entry.host))]
	check('记录到上游 CDN 主机', hosts.length > 0, hosts.join(', ') || '无')

	// ---------------------------------------------------------------
	// 5. 最终状态
	// ---------------------------------------------------------------
	const finalState = JSON.parse(
		await evaluate(window, 'JSON.stringify(window.bbTest.state())'),
	)
	check(
		'全程无媒体错误',
		!finalState.error,
		finalState.error ? JSON.stringify(finalState.error) : '无',
	)
	check(
		'解码缓冲已建立（buffered 非空，证明数据真的到位）',
		finalState.buffered.length > 0,
		JSON.stringify(
			finalState.buffered.map((r) => r.map((v) => Number(v.toFixed(2)))),
		),
	)

	await shot(window, '05-final')

	return finish(window, finalState)
}

function finish(window, finalState) {
	fs.mkdirSync(OUTPUT, { recursive: true })
	fs.writeFileSync(
		REPORT,
		JSON.stringify(
			{
				checks,
				screenshots,
				summary: finalState ?? null,
				proxyRequests: requestLog.slice(-20),
			},
			null,
			2,
		),
	)
	console.log(`[probe] 报告已写入 ${REPORT}`)
	if (window) window.destroy()
}

module.exports = { run }
