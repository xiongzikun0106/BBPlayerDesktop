/**
 * B 站音频代理（Phase 1 可行��性验证用）。
 *
 * 背景（见 docs/DESKTOP_PLAN.md §2.3，已实测）：
 *  - 主线 CDN（upos-*）裸请求返回 403，必须带 `Referer` + 桌面 UA；
 *  - 主线 CDN **不返回** `Access-Control-Allow-Origin`，渲染进程直接
 *    `<audio src="https://...bilivideo.com/...">` 会被 CORS 拦；
 *  - CDN 支持 `Range`（206），因此代理必须透传该请求头。
 *
 * 因此音频必须由主进程代发请求。这里用自定义协议 `bbplayer-audio://`：
 * 渲染进程拿到的是本协议地址，主进程负责注入请求头并流式回传。
 */
const DESKTOP_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'

/** bvid -> 已解析的音频信息（内存缓存，避免重复解析） */
const resolved = new Map()

/** 记录代理请求，供验证脚本断言 */
const requestLog = []

async function fetchJson(url) {
	const response = await fetch(url, {
		headers: { 'User-Agent': DESKTOP_UA, Referer: REFERER },
	})
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} for ${url}`)
	}
	return await response.json()
}

/**
 * 把一个 bvid 解析为可播放的音频地址。
 * 走 B 站公开的 view + playurl 接口（与移动端 lib/api/bilibili/api.ts 同源思路）。
 */
/** 是否为主线 CDN（模块级，避免 lint 的 consistent-function-scoping） */
const isMainlineHost = (url) => !new URL(url).host.includes('mcdn.bilivideo')

async function resolveAudio(bvid) {
	const cached = resolved.get(bvid)
	if (cached) return cached

	const view = await fetchJson(
		`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
	)
	if (view.code !== 0) {
		throw new Error(`view 接口失败: ${view.code} ${view.message}`)
	}

	const { cid, title, duration } = view.data
	const play = await fetchJson(
		`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&fnver=0&fourk=1`,
	)
	if (play.code !== 0) {
		throw new Error(`playurl 接口失败: ${play.code} ${play.message}`)
	}

	const tracks = play.data?.dash?.audio ?? []
	if (tracks.length === 0) {
		throw new Error('响应中没有 dash.audio')
	}

	// 选带宽最高的音轨
	const best = [...tracks].sort(
		(a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0),
	)[0]

	// 优先选「主线 CDN」的地址（upos-*）。PCDN 节点（mcdn.*）行为宽松、
	// 会放行裸请求，用它验证会得到过于乐观的结论（见 §2.3 的样本偏差教训）。
	const candidates = [best.baseUrl, ...(best.backupUrl ?? [])]
	const chosen = candidates.find(isMainlineHost) ?? candidates[0]

	const info = {
		bvid,
		cid,
		title,
		duration,
		audioUrl: chosen,
		preferredMainline: chosen !== best.baseUrl,
		allHosts: candidates.map((url) => new URL(url).host),
		backupUrls: best.backupUrl ?? [],
		quality: best.id,
		bandwidth: best.bandwidth,
	}
	resolved.set(bvid, info)
	return info
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

module.exports = {
	handleAudioRequest,
	resolveAudio,
	requestLog,
	DESKTOP_UA,
	REFERER,
}
