/**
 * 网易云歌单拉取（Phase 3.3 外部歌单导入的第一半）。
 *
 * ## 为什么能直接复用 core 的客户端
 *
 * core 里已经有 `NeteaseLyricsApiClient`（`packages/core/src/api/netease/`），
 * 它处理好了两件容易错的事：桌面 UA + `Referer: https://music.163.com/`
 * （缺 Referer 会被拒），以及 **weapi/eapi 加密**（`crypto.ts`）。
 *
 * 但歌单详情用的是**另一个接口**（`/api/playlist/detail`），是未加密的
 * 简易 API —— 实测匿名可用、返回 `code=200` 与完整曲目列表。所以这里
 * 不经过那个加密客户端，而是直接 `fetch`，并复用同一套请求头常量
 * （`NETEASE_USER_AGENT` / `NETEASE_REFERER`）保持一致性。
 *
 * ## 只取匹配需要的字段
 *
 * 匹配一首歌只需要 `(标题, 作者, 时长)`。返回原始 JSON 会把
 * 「200 首 × 每首几十个字段」全带进来（几百 KB），而渲染进程只需要三列。
 * 因此在主进程就裁剪好。
 */
/** 与 core 的 netease 客户端共用同一套头（缺 Referer 会被拒） */
const NETEASE_USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const NETEASE_REFERER = 'https://music.163.com/'

/**
 * 从各种形态的输入里取出歌单 id。
 *
 * 用户会粘贴不同形态的链接，实测常见的有：
 *   * `https://music.163.com/playlist?id=3778678`
 *   * `https://music.163.com/#/playlist?id=3778678`
 *   * `https://y.music.163.com/m/playlist?id=3778678&userid=...`
 *   * `分享歌单: 热歌榜 https://music.163.com/playlist/3778678/...`
 *   * 直接一个数字 `3778678`
 *
 * 所以按「query 里的 id」优先，其次「路径里的纯数字段」，最后「纯数字输入」。
 * 取不到返回 null（由调用方给出可读错误）。
 */
function parsePlaylistId(input) {
	if (input === null || input === undefined) return null
	// 纯数字直接就是 id。
	//
	// ⚠️ 这里**不**要求最小长度：由服务端去判断该 id 是否存在。
	// 拒绝一个合法但短的 id 比接受一个不存在的 id 更糟 —— 前者让用户完全
	// 没法导入，后者只是一次可读的报错。
	const trimmed = String(input).trim()
	if (/^\d+$/.test(trimmed)) return trimmed

	// query 参数里的 id（最常见的形态）
	const queryMatch = /[?&]id=(\d+)/.exec(trimmed)
	if (queryMatch) return queryMatch[1]

	// 路径里的 /playlist/<id>
	const pathMatch = /playlist\/(\d+)/.exec(trimmed)
	if (pathMatch) return pathMatch[1]

	// 兜底：任意位置的 5 位以上数字（网易云的歌单 id 都是这个量级）。
	// 这里**必须**要求 5 位以上 —— 否则「分享歌单 3」这类文案里的
	// 单个数字会被误当成 id。
	const looseMatch = /(\d{5,})/.exec(trimmed)
	return looseMatch ? looseMatch[1] : null
}

/**
 * 拉取歌单。
 *
 * @param {string|number} input 歌单 id 或链接
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{playlistId: string, name: string, description: string|null, cover: string|null, total: number, tracks: Array<{index: number, title: string, artist: string, duration: number|null, album: string|null, neteaseId: number|null}>}>}
 */
async function fetchPlaylist(input, { timeoutMs = 20000 } = {}) {
	const playlistId = parsePlaylistId(input)
	if (!playlistId) {
		throw new Error(
			'无法从输入里识别歌单 id。可以粘贴歌单链接（含 ?id=…）或直接填数字 id。',
		)
	}

	const response = await fetch(
		`https://music.163.com/api/playlist/detail?id=${playlistId}`,
		{
			headers: {
				'User-Agent': NETEASE_USER_AGENT,
				Referer: NETEASE_REFERER,
			},
			signal: AbortSignal.timeout(timeoutMs),
		},
	)
	if (!response.ok) {
		throw new Error(`网易云歌单接口 HTTP ${response.status}`)
	}

	const json = await response.json()
	if (json.code !== 200 || !json.result) {
		throw new Error(
			`网易云歌单接口失败：code=${json.code} ${json.message ?? ''}（歌单不存在或已设为私密？）`,
		)
	}

	const result = json.result
	const rawTracks = Array.isArray(result.tracks) ? result.tracks : []

	const tracks = rawTracks
		.map((track, index) => {
			// 有些条目是「无版权/已下架」，name 为空 —— 过滤掉而不是留空标题
			if (!track?.name) return null
			return {
				index,
				title: String(track.name),
				// 多个作者用 `/` 连接，与界面显示习惯一致
				artist: Array.isArray(track.artists)
					? track.artists
							.map((a) => a?.name)
							.filter(Boolean)
							.join('/')
					: '',
				// 网易云给的是**毫秒**，而匹配器与数据库都用秒
				duration:
					typeof track.duration === 'number'
						? Math.round(track.duration / 1000)
						: null,
				album: track.album?.name ? String(track.album.name) : null,
				neteaseId:
					typeof track.id === 'number' ? track.id : Number(track.id) || null,
			}
		})
		.filter(Boolean)

	return {
		playlistId,
		name: result.name ? String(result.name) : `网易云歌单 ${playlistId}`,
		description: result.description ? String(result.description) : null,
		cover: result.coverImgUrl ? String(result.coverImgUrl) : null,
		// `trackCount` 是歌单声明的总数，而 `tracks` 可能因为下架而少一些
		total:
			typeof result.trackCount === 'number' ? result.trackCount : tracks.length,
		tracks,
		// 如实报告「声明数」与「实际拿到数」的差异，而不是假装一致
		fetched: tracks.length,
	}
}

module.exports = {
	fetchPlaylist,
	parsePlaylistId,
	NETEASE_USER_AGENT,
	NETEASE_REFERER,
}
