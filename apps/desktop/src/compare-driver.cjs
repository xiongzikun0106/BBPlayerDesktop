/* oxlint-disable no-console -- 探针脚本，以 stdout 输出对比结果 */
/**
 * 方案对比探针：`webRequest` 头注入 vs 自定义协议代理。
 *
 * §2.3 的实测已经确认：主线 CDN 需要 `Referer` + 桌面 UA，**且不返回
 * `Access-Control-Allow-Origin`**。于是「用 `session.webRequest.onBeforeSendHeaders`
 * 注入 Referer，渲染进程直接播 CDN 地址」这个方案，理论上会因为 CORS 而失败。
 *
 * 本模块把「理论上」变成「实测」：
 *   Case A  webRequest 注入 + 直接播 CDN，**不**关 webSecurity
 *           → 预期：媒体错误（CORS 拦下，因为 CDN 无 ACAO）
 *   Case B  webRequest 注入 + 直接播 CDN，**关掉** webSecurity
 *           → 预期：能播，但代价是渲染进程失去同源保护
 *   Case C  自定义协议代理（已完成，作为对照组，直接引用其结论）
 *
 * 结论用于确定 Phase 1 的实现选择；结果写入 `probe-output/comparison.json`。
 */
const fs = require('node:fs')
const path = require('node:path')

const { resolveAudio, requestLog } = require('./audio-proxy.cjs')

const OUTPUT = path.join(__dirname, '..', 'probe-output')
const REPORT = path.join(OUTPUT, 'comparison.json')

const TEST_BVID = 'BV1GJ411x7h7'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 在给定窗口里测「直接播 CDN」这条路。
 *
 * 关键：先用 `net.fetch`（主进程，不受 CORS 约束）证明「只要头对了，CDN 就会给 206」，
 * 再用渲染进程的 `<audio>` 去播同一个 URL —— 后者会被 CORS 规则约束。
 * 两个结果放一起，就能把「头的问题」和「CORS 的问题」分离开。
 */
async function testDirectCdn(window, audioUrl, label) {
	console.log(`\n[compare] ${label}`)
	console.log(`[compare] 目标: ${new URL(audioUrl).host}`)

	// 1) 渲染进程直接播 CDN 地址
	const result = await window.webContents.executeJavaScript(
		`(async () => {
			const audio = document.getElementById('audio')
			audio.pause()
			audio.removeAttribute('src')
			audio.load()

			const events = { error: 0, loadedmetadata: 0, canplay: 0, playing: 0 }
			const waiters = []
			for (const name of Object.keys(events)) {
				audio.addEventListener(name, () => { events[name] += 1; waiters.forEach(w => w()) })
			}

			audio.src = ${JSON.stringify(audioUrl)}
			audio.load()

			const waitFor = (predicate, timeoutMs) => new Promise((resolve) => {
				const start = Date.now()
				const tick = () => {
					if (predicate()) return resolve(true)
					if (Date.now() - start > timeoutMs) return resolve(false)
					setTimeout(tick, 100)
				}
				tick()
			})

			const metaLoaded = await waitFor(() => audio.readyState >= 1 || audio.error, 8000)
			let played = false
			if (metaLoaded && !audio.error) {
				try { await audio.play(); played = await waitFor(() => !audio.paused && audio.currentTime > 0, 6000) }
				catch (e) { /* play() 被拒绝 */ }
			}

			const err = audio.error
			return JSON.stringify({
				metaLoaded,
				readyState: audio.readyState,
				duration: Number.isFinite(audio.duration) ? audio.duration : null,
				played,
				currentTime: audio.currentTime,
				error: err ? { code: err.code, message: err.message ?? null } : null,
				events,
			})
		})()`,
		true,
	)

	const parsed = JSON.parse(result)
	console.log(
		`[compare]   元数据加载=${parsed.metaLoaded} readyState=${parsed.readyState} 播放=${parsed.played} 错误=${parsed.error ? parsed.error.message || parsed.error.code : '无'}`,
	)
	return parsed
}

async function run(window) {
	fs.mkdirSync(OUTPUT, { recursive: true })
	const insecure = process.argv.includes('--insecure')

	const comparison = {
		generatedAt: new Date().toISOString(),
		webSecurityDisabled: insecure,
		cases: {},
	}

	// 等渲染进程就绪
	for (let attempt = 0; attempt < 60; attempt++) {
		try {
			const ready = await window.webContents.executeJavaScript(
				'Boolean(window.__bbReady)',
				true,
			)
			if (ready) break
		} catch {
			// 继续等
		}
		await sleep(250)
	}

	const info = await resolveAudio(TEST_BVID)
	console.log(`[compare] 视频: ${info.title}`)
	console.log(`[compare] 音轨宿主: ${new URL(info.audioUrl).host}`)

	// 先证明「头是对的」：主进程 net.fetch 不受 CORS 约束
	try {
		const { net } = require('electron')
		const response = await net.fetch(info.audioUrl, {
			headers: {
				Referer: 'https://www.bilibili.com/',
				'User-Agent':
					'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
				Range: 'bytes=0-1023',
			},
		})
		comparison.upstreamWithHeaders = {
			status: response.status,
			contentRange: response.headers.get('content-range'),
			acao: response.headers.get('access-control-allow-origin'),
		}
		await response.body?.cancel()
	} catch (error) {
		comparison.upstreamWithHeaders = { error: String(error) }
	}
	console.log(
		`[compare] 主进程带头请求: ${JSON.stringify(comparison.upstreamWithHeaders)}`,
	)

	// 渲染进程直接播 CDN（webRequest 已注入头；是否关 webSecurity 由启动参数决定）
	const directResult = await testDirectCdn(
		window,
		info.audioUrl,
		insecure
			? 'Case B: webRequest 注入 + 直连 CDN（webSecurity: false）'
			: 'Case A: webRequest 注入 + 直连 CDN（webSecurity 默认开启）',
	)
	comparison.cases.directCdn = directResult
	comparison.cases.directCdnMode = insecure ? 'B-insecure' : 'A-secure'

	// 截图留证
	try {
		const image = await window.webContents.capturePage()
		const size = image.getSize()
		if (size.width > 0) {
			fs.mkdirSync(path.join(OUTPUT, 'shots'), { recursive: true })
			const file = path.join(
				OUTPUT,
				'shots',
				insecure ? 'compare-B-insecure.png' : 'compare-A-secure.png',
			)
			fs.writeFileSync(file, image.toPNG())
			comparison.screenshot = file
		}
	} catch {
		// 截图失败不影响结论
	}

	comparison.proxyRequestCount = requestLog.length
	comparison.networkTrace = networkTrace

	// ---------------------------------------------------------------
	// 诊断：同一地址，渲染进程 fetch vs 主进程 net.fetch
	//
	// 上一轮两个 Case 都报 `Format error`（code 4）而不是 CORS 错误，
	// 且关掉 webSecurity 也一样。所以要把「头/CORS/响应格式」分开看清楚。
	// ---------------------------------------------------------------
	console.log('\n[compare] 诊断：渲染进程 fetch 同一个音频地址')
	try {
		const rendererFetch = await window.webContents.executeJavaScript(
			`(async () => {
				const describe = async (label, init) => {
					try {
						const r = await fetch(${JSON.stringify(info.audioUrl)}, init)
						const buf = await r.arrayBuffer()
						return {
							label,
							ok: true,
							status: r.status,
							type: r.type,
							contentType: r.headers.get('content-type'),
							contentRange: r.headers.get('content-range'),
							acao: r.headers.get('access-control-allow-origin'),
							bytes: buf.byteLength,
							firstBytesHex: [...new Uint8Array(buf.slice(0, 8))]
								.map((b) => b.toString(16).padStart(2, '0'))
								.join(' '),
						}
					} catch (e) {
						return { label, ok: false, error: String(e) }
					}
				}

				// 两次都测：
				//  - 不带 Range：干净的 CORS 探测（自定义头会触发 preflight，混淆结论）
				//  - 带 Range：模拟 <audio> 拖动 seek 时真实发出的请求
				return JSON.stringify({
					noRange: await describe('no-range', {}),
					withRange: await describe('with-range', { headers: { Range: 'bytes=0-1023' } }),
				})
			})()`,
			true,
		)
		comparison.rendererFetch = JSON.parse(rendererFetch)
		console.log(
			`[compare]   渲染进程(无 Range): ${JSON.stringify(comparison.rendererFetch.noRange)}`,
		)
		console.log(
			`[compare]   渲染进程(带 Range): ${JSON.stringify(comparison.rendererFetch.withRange)}`,
		)
	} catch (error) {
		comparison.rendererFetch = { error: String(error) }
	}

	console.log('[compare] 诊断：主进程 net.fetch 同一个音频地址')
	try {
		const { net } = require('electron')
		const response = await net.fetch(info.audioUrl, {
			headers: {
				Referer: 'https://www.bilibili.com/',
				'User-Agent':
					'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
				Range: 'bytes=0-1023',
			},
		})
		const buffer = await response.arrayBuffer()
		comparison.mainFetch = {
			status: response.status,
			contentType: response.headers.get('content-type'),
			contentLength: response.headers.get('content-length'),
			contentRange: response.headers.get('content-range'),
			acao: response.headers.get('access-control-allow-origin'),
			bytes: buffer.byteLength,
			firstBytesHex: [...new Uint8Array(buffer.slice(0, 16))]
				.map((b) => b.toString(16).padStart(2, '0'))
				.join(' '),
		}
		console.log(`[compare]   主进程: ${JSON.stringify(comparison.mainFetch)}`)
	} catch (error) {
		comparison.mainFetch = { error: String(error) }
	}

	fs.writeFileSync(REPORT, JSON.stringify(comparison, null, 2))
	console.log(`[compare] 结果写入 ${REPORT}`)

	if (window) window.destroy()
	return comparison
}

/**
 * 监听 CDN 域名的网络响应。
 *
 * `fetch` 成功但 `<audio>` 报 `Format error`，说明问题出在媒体加载器自己发出的
 * 请求上（它带的 Accept / Range / 目标 URL 与我们的 fetch 不同）。把它的真实
 * 响应记下来才能定位。
 */
/** 追踪缓冲：由 installNetworkTracer() 填充，run() 读取 */
const networkTrace = []

/**
 * 只记录与音频/代理相关的请求。
 *
 * B 站音频地址会落到第三方镜像域名（实测见过 `*.edge.mountaintoys.cn:4483`），
 * 所以**不能**只按 `*.bilivideo.com` 过滤，否则追踪是空的。
 */
const isInterestingUrl = (url) =>
	url.startsWith('bbplayer-audio://') ||
	/\.(cn|com|net):\d+\//.test(url) ||
	/bilivideo|mountaintoys|hdslb|bilibili/.test(url)

/**
 * 监听网络响应。必须在**任何请求发生之前**调用（main 进程在 app ready 后立刻调），
 * 否则 `<audio>` 早期发出的请求不会被记录。
 *
 * 为什么要追踪：`fetch` 成功但 `<audio>` 报 `Format error`，说明问题出在媒体加载器
 * 自己发出的请求上（它带的 Accept / Range 与我们的 fetch 不同）。必须看它的真实响应。
 */
function installNetworkTracer() {
	const { session } = require('electron')

	const filter = { urls: ['*://*/*'] }

	session.defaultSession.webRequest.onCompleted(filter, (details) => {
		if (!isInterestingUrl(details.url)) return
		networkTrace.push({
			phase: 'completed',
			url: details.url.slice(0, 140),
			statusCode: details.statusCode,
			fromCache: details.fromCache,
			resourceType: details.resourceType,
			method: details.method,
		})
	})

	session.defaultSession.webRequest.onErrorOccurred(filter, (details) => {
		if (!isInterestingUrl(details.url)) return
		networkTrace.push({
			phase: 'error',
			url: details.url.slice(0, 140),
			error: details.error,
			resourceType: details.resourceType,
		})
	})

	return networkTrace
}

module.exports = { run, installNetworkTracer }
