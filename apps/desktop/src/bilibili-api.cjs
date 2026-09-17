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

/** B 站音频容器：30216=64K, 30232=132K, 30280=192K, 30250=杜比, 30251=Hi-Res */
const AUDIO_QUALITY = {
	LOW_64K: 30216,
	MEDIUM_132K: 30232,
	HIGH_192K: 30280,
	DOLBY: 30250,
	HI_RES: 30251,
}

/**
 * 是否为主线 CDN（模块级，避免 lint 的 consistent-function-scoping）。
 *
 * PCDN 节点（`*.mcdn.bilivideo.cn`）不校验 Referer、行为不稳定，
 * 优先选主线能减少播放失败（实测见 docs/DESKTOP_PLAN.md §2.3）。
 */
const isMainlineHost = (url) => !new URL(url).host.includes('mcdn.bilivideo')

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
		cover: data.pic,
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
		enableDolby = false,
		enableHiRes = false,
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
			title: item.title?.replaceAll(/<[^>]+>/g, '') ?? '',
			author: item.author,
			duration: item.duration,
			cover: item.pic?.startsWith('//') ? `https:${item.pic}` : item.pic,
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
		cover: entry.meta.cover,
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
				cover: archive.pic,
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

module.exports = {
	AUDIO_QUALITY,
	getVideoInfo,
	getAudioStream,
	searchVideos,
	listUserSeasons,
	listSeasonArchives,
}
