/**
 * 桌面端的 B 站 API 层。
 *
 * 直接复用 `packages/core` 里端口注入的 `bilibiliApiClient` 与 WBI 签名
 * （`scripts/verify-bilibili-api.mts` 已验证签名被服务端接受）。
 *
 * 音质降级顺序参照移动端 `apps/mobile/src/lib/api/bilibili/api.ts`：
 *   杜比全景声 -> Hi-Res -> 指定音质 -> 兜底最高带宽音轨 -> durl（老视频）
 */
const { core } = require('./ports.cjs')
const { getLoginManager } = require('./bilibili-login-holder.cjs')

/** B 站音频容器：30216=64K, 30232=132K, 30280=192K, 30250=杜比, 30251=Hi-Res */
const AUDIO_QUALITY = {
	LOW_64K: 30216,
	MEDIUM_132K: 30232,
	HIGH_192K: 30280,
	DOLBY: 30250,
	HI_RES: 30251,
}

/**
 * 会员音轨（杜比 / Hi-Res）是否可用。
 *
 * 实测（`docs/DESKTOP_PLAN.md` §2.3 补记）：匿名请求 `fnval=4048` 时
 * `dash.flac` 缺失、`dash.dolby.audio` 为空数组，只有
 * 30216 / 30232 / 30280 三档标准音质；且**带宽随视频而异**
 * （同一个视频匿名只拿到 46096 / 100395 / 183360）。
 * 即使请求里已经声明要杜比和 Hi-Res（`fnval=4048`），服务端也只按
 * **登录态**下发会员音轨 —— 所以这里必须登录后才打开开关。
 */
function memberTiersAvailable() {
	return Boolean(getLoginManager()?.getCookie())
}

/**
 * 是否为主线 CDN（模块级，避免 lint 的 consistent-function-scoping）。
 *
 * PCDN 节点（`*.mcdn.bilivideo.cn`）不校验 Referer、行为不稳定，
 * 优先选主线能减少播放失败（实测见 docs/DESKTOP_PLAN.md §2.3）。
 */
const isMainlineHost = (url) => !new URL(url).host.includes('mcdn.bilivideo')

/**
 * 把 B 站的封面 URL 归一化成 HTTPS。
 *
 * 渲染进程的 CSP 是 `img-src 'self' data: https:` —— 只允许 HTTPS。
 * 而 B 站接口返回的 `pic` 字段常常是 **`http://i0.hdslb.com/...`**
 * 或 **协议相对** `//i0.hdslb.com/...`，两种都会被 CSP 拦下，
 * 表现是"所有封面都裂成占位符"。
 *
 * 所有从 B 站接口出去的封面统一在这里过一遍，
 * 不要在每个渲染层再各自补救（那是漏网之鱼的温床）。
 */
function normalizeCoverUrl(url) {
	if (!url) return null
	if (url.startsWith('//')) return `https:${url}`
	if (url.startsWith('http://')) return `https://${url.slice('http://'.length)}`
	return url
}

/** 取视频基本信息（cid / 标题 / 时长） */
async function getVideoInfo(bvid) {
	const { bilibiliApiClient } = core
	const result = await bilibiliApiClient.get({
		endpoint: '/x/web-interface/view',
		params: { bvid },
	})
	if (result.isErr()) {
		throw new Error(`view 接口失败: ${result.error.message}`)
	}
	const data = result.value
	return {
		bvid,
		aid: data.aid,
		cid: data.cid,
		title: data.title,
		duration: data.duration,
		cover: normalizeCoverUrl(data.pic),
		owner: data.owner?.name,
		// 需要 mid 才能把作者落成 `source='bilibili'`
		// （artists 表有 CHECK 约束：非 local 必须带 remote_id）
		ownerMid: data.owner?.mid != null ? String(data.owner.mid) : null,
		pages: data.pages?.length ?? 1,
	}
}

/**
 * 取音频流地址。
 *
 * 返回经过「音质阶梯」挑选后的结果，并**优先主线 CDN**：实测 PCDN 节点
 * （`mcdn.bilivideo.cn`）会放行裸请求、且不一定支持 Range，用它验证会得出
 * 过于乐观的结论（见 docs/DESKTOP_PLAN.md §2.3）。
 */
async function getAudioStream(
	bvid,
	cid,
	{
		audioQuality = AUDIO_QUALITY.HIGH_192K,
		// 默认跟随登录态：未登录时服务端本来就不下发会员音轨，
		// 打开开关只是多走一次判断，不会有副作用。
		enableDolby = memberTiersAvailable(),
		enableHiRes = memberTiersAvailable(),
	} = {},
) {
	const { bilibiliApiClient, getWbiEncodedParams } = core

	const signed = await getWbiEncodedParams({
		bvid,
		cid,
		fnval: 4048, // dash + 杜比 + Hi-Res 全要
		fnver: 0,
		fourk: 1,
		qlt: audioQuality,
	})
	if (signed.isErr()) {
		throw new Error(`WBI 签名失败: ${signed.error.message}`)
	}

	const result = await bilibiliApiClient.get({
		endpoint: '/x/player/wbi/playurl',
		params: signed.value,
	})
	if (result.isErr()) {
		throw new Error(`playurl 接口失败: ${result.error.message}`)
	}

	const { dash, durl } = result.value

	/** 从一组音轨里挑一个：优先主线 CDN，其次带宽最高 */
	const pickTrack = (tracks) => {
		if (!tracks?.length) return null
		const sorted = [...tracks].sort(
			(a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0),
		)
		return sorted.find((t) => isMainlineHost(t.baseUrl)) ?? sorted[0]
	}

	// 阶梯：杜比 -> Hi-Res -> 指定音质 -> 最高带宽
	if (enableDolby && dash?.dolby?.audio?.length) {
		const track = pickTrack(dash.dolby.audio)
		if (track) {
			return {
				kind: 'dash',
				tier: 'dolby',
				url: track.baseUrl,
				backupUrls: track.backupUrl ?? [],
				qualityId: track.id,
				bandwidth: track.bandwidth,
			}
		}
	}

	if (enableHiRes && dash?.flac?.audio) {
		const track = dash.flac.audio
		return {
			kind: 'dash',
			tier: 'hires',
			url: track.baseUrl,
			backupUrls: track.backupUrl ?? [],
			qualityId: track.id,
			bandwidth: track.bandwidth,
		}
	}

	if (dash?.audio?.length) {
		const exact = dash.audio.find((t) => t.id === audioQuality)
		const track = exact ?? pickTrack(dash.audio)
		return {
			kind: 'dash',
			tier: exact ? 'requested' : 'fallback',
			url: track.baseUrl,
			backupUrls: track.backupUrl ?? [],
			qualityId: track.id,
			bandwidth: track.bandwidth,
			availableQualities: dash.audio.map((t) => ({
				id: t.id,
				bandwidth: t.bandwidth,
			})),
		}
	}

	// 老视频没有 dash，回退 durl
	if (durl?.length) {
		return {
			kind: 'durl',
			tier: 'durl',
			url: durl[0].url,
			backupUrls: durl[0].backup_url ?? [],
			qualityId: null,
			bandwidth: null,
		}
	}

	throw new Error('响应里既没有 dash.audio 也没有 durl')
}

/**
 * 把 B 站搜索返回的时长字符串解析成**秒**。
 *
 * ⚠️ 实测：搜索接口的 `duration` 是 `"4:21"` / `"1:02:33"` 这种**格式化字符串**，
 * 不是秒数（`typeof` 是 `string`）。第一版直接 `typeof === 'number' ? … : undefined`
 * 就把它丢了，于是所有下游的「时长相似度」恒为 0 —— 表现是匹配分数整体偏低，
 * 而且不容易看出来（分数只是「有点低」，不报错）。
 *
 * 支持三种形态：`"295"`（纯秒）、`"4:21"`、`"1:02:33"`。
 * 解析不出来返回 `null`（而不是 0 —— 0 会被当成「时长为 0 秒」参与打分）。
 */
function parseDuration(value) {
	if (typeof value === 'number' && Number.isFinite(value))
		return Math.round(value)
	if (typeof value !== 'string') return null

	const trimmed = value.trim()
	if (!trimmed) return null

	// 纯数字：直接是秒
	if (/^\d+$/.test(trimmed)) return Number(trimmed)

	// mm:ss 或 hh:mm:ss
	const parts = trimmed.split(':')
	if (parts.length < 2 || parts.length > 3) return null
	if (!parts.every((part) => /^\d+$/.test(part.trim()))) return null

	const numbers = parts.map((part) => Number(part.trim()))
	if (parts.length === 2) {
		const [minutes, seconds] = numbers
		return minutes * 60 + seconds
	}
	const [hours, minutes, seconds] = numbers
	return hours * 3600 + minutes * 60 + seconds
}

/** 搜索视频（WBI 签名接口） */
async function searchVideos(keyword, page = 1) {
	const { bilibiliApiClient, getWbiEncodedParams } = core

	const signed = await getWbiEncodedParams({
		search_type: 'video',
		keyword,
		page,
	})
	if (signed.isErr()) {
		throw new Error(`WBI 签名失败: ${signed.error.message}`)
	}

	const result = await bilibiliApiClient.get({
		endpoint: '/x/web-interface/wbi/search/type',
		params: signed.value,
	})
	if (result.isErr()) {
		throw new Error(`search 接口失败: ${result.error.message}`)
	}

	const items = result.value?.result ?? []
	return items
		.filter((item) => item.bvid)
		.map((item) => ({
			bvid: item.bvid,
			// 搜索结果的标题带 `<em class="keyword">` 高亮标签，必须剥掉
			title: item.title?.replaceAll(/<[^>]+>/g, '') ?? '',
			author: item.author,
			// ⚠️ 这里过去直接透传原值（`"4:21"` 字符串），见 parseDuration 的说明
			duration: parseDuration(item.duration),
			/** 原始时长字符串，保留下来便于排查与显示 */
			durationText: typeof item.duration === 'string' ? item.duration : null,
			cover: normalizeCoverUrl(item.pic),
			play: item.play,
		}))
}

/**
 * 列出某个 UP 的公开合集（无需登录）。
 *
 * 这是 P1 的验证载体：收藏夹要登录态，而 UP 合集是公开的，
 * 所以用它能端到端验证「拉歌单 -> 落库」而不依赖凭据。
 */
async function listUserSeasons(mid, { pageNum = 1, pageSize = 20 } = {}) {
	const { bilibiliApiClient } = core
	const result = await bilibiliApiClient.get({
		endpoint: '/x/polymer/web-space/seasons_series_list',
		params: { mid, page_num: pageNum, page_size: pageSize },
	})
	if (result.isErr()) {
		throw new Error(`合集列表接口失败: ${result.error.message}`)
	}
	const list = result.value?.items_lists?.seasons_list ?? []
	return list.map((entry) => ({
		seasonId: entry.meta.season_id,
		title: entry.meta.name,
		total: entry.meta.total,
		cover: normalizeCoverUrl(entry.meta.cover),
	}))
}

/**
 * 取某个合集里的视频（无需登录）。
 *
 * 注意 B 站对 `page_size` 有上限（实测 30 会报错），这里分页拉取。
 */
async function listSeasonArchives(
	mid,
	seasonId,
	{ pageSize = 20, maxItems = Number.POSITIVE_INFINITY } = {},
) {
	const { bilibiliApiClient } = core
	const items = []
	let pageNum = 1

	while (items.length < maxItems) {
		const result = await bilibiliApiClient.get({
			endpoint: '/x/polymer/web-space/seasons_archives_list',
			params: {
				mid,
				season_id: seasonId,
				page_num: pageNum,
				page_size: pageSize,
				sort_reverse: 'false',
			},
		})
		if (result.isErr()) {
			throw new Error(`合集视频接口失败: ${result.error.message}`)
		}

		const archives = result.value?.archives ?? []
		if (archives.length === 0) break

		for (const archive of archives) {
			items.push({
				bvid: archive.bvid,
				aid: archive.aid,
				title: archive.title,
				cover: normalizeCoverUrl(archive.pic),
				duration: archive.duration,
				pubdate: archive.pubdate,
				stat: archive.stat,
			})
			if (items.length >= maxItems) break
		}

		const total = result.value?.page?.total ?? 0
		if (items.length >= total) break
		pageNum += 1
		// 防御：避免接口异常导致死循环
		if (pageNum > 100) break
	}

	return items
}

/**
 * 列出某个用户的**收藏夹**（视频收藏，不是合集）。
 *
 * 实测（见 `docs/DESKTOP_PLAN.md` §3 补记）：`fav/folder/created/list-all`
 * **匿名可读**，只要知道 `mid`。所以「导入公开收藏夹」不需要登录；
 * 登录的意义在于能读到**私密收藏夹**，以及 `list-all` 会带上自己的
 * `fav_state` / `attr` 等字段。
 */
async function listFavoriteFolders(mid) {
	const { bilibiliApiClient } = core
	const result = await bilibiliApiClient.get({
		endpoint: '/x/v3/fav/folder/created/list-all',
		params: { up_mid: mid },
	})
	if (result.isErr()) {
		throw new Error(`收藏夹列表接口失败: ${result.error.message}`)
	}

	const list = result.value?.list ?? []
	return list.map((entry) => ({
		mediaId: entry.id,
		title: entry.title,
		mediaCount: entry.media_count,
		// 私密收藏夹匿名看不到，登录后才出现在列表里
		isPrivate: entry.attr !== 0,
		cover: normalizeCoverUrl(entry.cover),
		favState: entry.fav_state ?? null,
	}))
}

/**
 * 取收藏夹内容（分页全量拉取）。
 *
 * ⚠️ 该接口的**失效条目**（已删除的视频）在返回里 `title === '已失效视频'`
 * 且 `bvid` 为空 —— 必须过滤，否则导入时会在 `upsertTrack` 处报错。
 */
async function listFavoriteResources(
	mediaId,
	{ pageSize = 20, maxItems = Number.POSITIVE_INFINITY } = {},
) {
	const { bilibiliApiClient } = core
	const items = []
	let pageNumber = 1

	while (items.length < maxItems) {
		const result = await bilibiliApiClient.get({
			endpoint: '/x/v3/fav/resource/list',
			params: {
				media_id: mediaId,
				pn: pageNumber,
				ps: pageSize,
				platform: 'web',
			},
		})
		if (result.isErr()) {
			throw new Error(`收藏夹内容接口失败: ${result.error.message}`)
		}

		const medias = result.value?.medias ?? []
		if (medias.length === 0) break

		for (const media of medias) {
			// 失效条目没有 bvid，直接跳过（不是错误）
			if (!media.bvid) continue
			items.push({
				bvid: media.bvid,
				aid: media.id,
				title: media.title,
				cover: normalizeCoverUrl(media.cover),
				duration: media.duration,
				pubdate: media.pubtime,
				upperMid: media.upper?.mid != null ? String(media.upper.mid) : null,
				upperName: media.upper?.name ?? null,
				favTime: media.fav_time ?? null,
			})
			if (items.length >= maxItems) break
		}

		const total = result.value?.info?.media_count ?? 0
		if (items.length >= total) break
		pageNumber += 1
		// 防御：接口异常时避免死循环
		if (pageNumber > 200) break
	}

	return items
}

module.exports = {
	AUDIO_QUALITY,
	getVideoInfo,
	getAudioStream,
	searchVideos,
	listUserSeasons,
	listSeasonArchives,
	listFavoriteFolders,
	listFavoriteResources,
	memberTiersAvailable,
	parseDuration,
	normalizeCoverUrl,
}
