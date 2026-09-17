/**
 * B 站音频代理。
 *
 * 背景（见 docs/DESKTOP_PLAN.md §2.3，均为实测结论）：
 *  - 主线 CDN（`upos-*` / `cn-sccd-*` / `*.edge.mountaintoys.cn`）**强制校验 `Referer`**：
 *    无 Referer 即 403，**仅带 UA 仍然 403**。`Referer` 充分且必要，UA 对结果无影响；
 *  - `*.mcdn.bilivideo.cn`（PCDN）不校验 Referer，但不稳定，不能作为依赖；
 *  - **CDN 的 CORS 其实是通的**（upos 系回显 Origin）。真正必须由主进程介入的原因是
 *    `Referer` 属于 Fetch 规范的 forbidden request header，渲染进程 JS 设不上去；
 *  - CDN 原生支持 `Range`（206），代理**只需透传**，不需要自己算 206。
 *
 * 因此音频经自定义协议 `bbplayer-audio://` 由主进程代发：渲染进程只拿到本协议地址，
 * 主进程负责注入请求头并流式回传。**不需要 `webSecurity: false`。**
 *
 * ⚠️ 实现约束：`protocol.handle` 必须在 `createWindow()` **之前**注册，
 * 否则会静默失效（`<audio>` 报 `MediaError 4 Format error`）。见 main.cjs。
 */
const { getAudioStream, getVideoInfo } = require('./bilibili-api.cjs')

const DESKTOP_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'

/** bvid -> 已解析的音频信息（内存缓存，避免重复解析） */
const resolved = new Map()

/** 记录代理请求，供验证脚本断言 */
const requestLog = []

/**
 * 把一个 bvid 解析为可播放的音频地址。
 *
 * 委托给 `bilibili-api.cjs` —— 也就是 **core 的端口注入客户端 + WBI 签名**。
 * 未签名接口只能拿到 64K 档；签名后实测可达 192K（音质 id 30280）。
 */
async function resolveAudio(bvid) {
	const cached = resolved.get(bvid)
	if (cached) return cached

	const info = await getVideoInfo(bvid)
	const stream = await getAudioStream(bvid, info.cid)

	const result = {
		bvid,
		cid: info.cid,
		title: info.title,
		duration: info.duration,
		audioUrl: stream.url,
		backupUrls: stream.backupUrls,
		quality: stream.qualityId,
		bandwidth: stream.bandwidth,
		/** 音质阶梯：dolby / hires / requested / fallback / durl */
		tier: stream.tier,
		upstreamHost: new URL(stream.url).host,
	}
	resolved.set(bvid, result)
	return result
}

/**
 * 处理 `bbplayer-audio://track/<bvid>` 请求。
 *
 * 把 CDN 返回的一切原样透传（状态码、Content-Type、Content-Range、
 * Accept-Ranges），这样 `<audio>` 的 Range 拖动 seek 才能正常工作。
 */
async function handleAudioRequest(request) {
	const requestUrl = new URL(request.url)
	// bbplayer-audio://track/<bvid>  → host=track, pathname=/<bvid>
	const bvid = decodeURIComponent(requestUrl.pathname.replace(/^\//, ''))
	if (!bvid) {
		return new Response('missing bvid', { status: 400 })
	}

	// 每个进入代理的请求都先记账，便于诊断（例如 Range 是否真的到来）
	const entry = {
		seq: requestLog.length + 1,
		bvid,
		at: Date.now(),
		range: request.headers.get('range'),
		// 记录浏览器发来的其余头，帮助判断媒体元素的行为
		accept: request.headers.get('accept'),
	}
	requestLog.push(entry)

	let info
	try {
		info = await resolveAudio(bvid)
	} catch (error) {
		entry.phase = 'resolve'
		entry.error = String(error)
		return new Response(`resolve failed: ${error.message}`, { status: 502 })
	}

	// 透传 Range，转发请求头
	const upstreamHeaders = {
		Referer: REFERER,
		'User-Agent': DESKTOP_UA,
	}
	if (entry.range) upstreamHeaders.Range = entry.range

	entry.host = new URL(info.audioUrl).host
	entry.quality = info.quality
	entry.tier = info.tier

	let upstream
	try {
		upstream = await fetch(info.audioUrl, { headers: upstreamHeaders })
	} catch (error) {
		entry.error = String(error)
		return new Response(`upstream failed: ${error.message}`, { status: 502 })
	}

	entry.upstreamStatus = upstream.status
	entry.upstreamContentRange = upstream.headers.get('content-range')
	entry.upstreamAcceptRanges = upstream.headers.get('accept-ranges')
	entry.upstreamContentLength = upstream.headers.get('content-length')

	// 只保留对媒体播放有意义的响应头
	const responseHeaders = new Headers()
	for (const name of [
		'content-type',
		'content-length',
		'content-range',
		'accept-ranges',
		'cache-control',
		'etag',
		'last-modified',
	]) {
		const value = upstream.headers.get(name)
		if (value) responseHeaders.set(name, value)
	}

	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: responseHeaders,
	})
}

/**
 * 清空解析缓存。
 *
 * **登录/退出登录后必须调用**：音轨档位取决于登录态（未登录时服务端
 * 不下发杜比/Hi-Res，见 `bilibili-api.cjs` 的 `memberTiersAvailable`），
 * 而这里的缓存以 bvid 为键、没有登录态维度。不清就可能一直播登录前
 * 解析出来的低档音轨，表现为「登录了但音质没提升」。
 */
function clearAudioCache() {
	const size = resolved.size
	resolved.clear()
	return size
}

module.exports = {
	handleAudioRequest,
	resolveAudio,
	clearAudioCache,
	requestLog,
	DESKTOP_UA,
	REFERER,
}
