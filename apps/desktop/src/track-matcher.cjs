/**
 * 音轨匹配（Phase 3.3 外部歌单导入的第二半）。
 *
 * 把「网易云/QQ 的一首歌」匹配成「B 站的一个视频」。这一步是整个导入
 * 功能里唯一有判断成分的地方 —— 拉歌单是确定性的，落库是确定性的，
 * 只有「这首歌对应 B 站哪个视频」需要启发式。
 *
 * ## 复用 core 的相似度原语，但**换一套权重**
 *
 * core 的 `lyricMatcher.ts` 里有整套原语：`normalizeTitle`（全角转半角、
 * 去 `【4K修复】` 之类的噪声）、`titleSimilarity`（bigram 集合相似度）、
 * `artistSimilarity`（拆分多作者后取最佳）、`durationSimilarity`
 * （3 秒内满分、20 秒外零分）。这些**直接复用** —— 相似度算法的实现只该有一份。
 *
 * 但**权重必须换**，原因是 B 站的数据现实：
 *
 * > B 站搜索结果的 `author` 是**上传者**，不是歌手。
 *
 * 实测：搜「如果呢 郑润泽」，返回的 `author` 是 `JLRS-LeoFM`、
 * `看哦爱随风原创鼓谱`、`木木237B站来时路` —— 全是搬运号/二创号。
 * 拿它跟网易云的歌手比，分数**恒为 0**，于是
 * `artistScore` 这一维等于没有（第一版就是这样，表现为整体分数偏低）。
 *
 * 所以这里把「歌手证据」重新定义为：
 *
 * ```
 * 歌手证据 = max( 相似度(网易云歌手, B站上传者),   // 偶尔真的同名
 *                 标题里是否出现网易云歌手 )      // 更常见且更强的信号
 * ```
 *
 * B 站音乐视频的标题几乎都会写歌手（`郑润泽《如果呢》`、`【翻唱】明知故犯`），
 * 所以「歌手出现在标题里」是比 `author` 可靠得多的证据。
 */
const {
	getAudioStream,
	getVideoInfo,
	searchVideos,
} = require('./bilibili-api.cjs')
const { core } = require('./ports.cjs')

/** 每个未匹配曲目向用户展示多少个候选 */
const CANDIDATE_LIMIT = 5

/** 搜索时多取一些结果：B 站搜索的前几条经常是同名翻唱/合集 */
const SEARCH_PAGE_SIZE = 20

/**
 * 音轨匹配的权重。
 *
 * 与 core 的歌词匹配权重（标题 0.6 / 歌手 0.25 / 时长 0.15）不同：
 * 时长权重提高，因为**时长是最难造假的证据** —— 一个 4:21 的视频
 * 与一首 261 秒的歌对上，比标题相似更能说明是同一首。
 */
const TRACK_WEIGHTS = {
	title: 0.5,
	artist: 0.25,
	duration: 0.25,
}

/**
 * 标题里的**负向标记**：出现这些词通常说明「不是那首歌本身」。
 *
 * ## 为什么必须有这个
 *
 * 实测（在修好「时长解析」与「歌手证据」之后）：分数看起来不错
 * （0.60–0.86），但**排名第一的经常是伴奏 / 鼓谱 / 指弹**：
 *
 * | 目标歌 | 排名第一的候选 | 分数 |
 * | --- | --- | --- |
 * | 甲乙丙丁 / 李佳薇 | 【吉他指弹】甲乙丙丁(你我怎么两清)李佳薇 | 0.855 → **被判 auto** |
 * | 如果呢 / 郑润泽 | 如果呢-郑润泽 高质量和声伴奏 | 0.633 |
 * | 我不难过 / 孙燕姿 | 我不难过 孙燕姿 动态鼓谱 | 0.672 |
 *
 * 这些标题**同时含歌名与歌手**，所以在标题/歌手两维上得分都很高 ——
 * 纯靠相似度区分不了「原曲」与「伴奏」。而用户点开歌单听到的是伴奏，
 * 就是典型的「自动匹配错了，代价很高」。
 *
 * ## 分两档
 *
 * * `strong`：几乎肯定不是那首歌（伴奏 / 谱 / 音效 / 片段）→ 重罚
 * * `mild`：是歌但形态不同（翻唱 / remix / live）→ 轻罚，因为有些用户接受翻唱
 *
 * 惩罚做成**乘法系数**而不是减分：减分对高分候选不够狠
 * （0.855 − 0.3 还是 0.55，仍在 `review` 区），而乘法能把
 * 「伴奏 + 完美标题匹配」压到 `auto` 阈值以下。
 */
const TITLE_PENALTIES = {
	strong: {
		pattern:
			/伴奏|和声\s*backup|backing\s*track|鼓谱|动态谱|附谱|谱例|指弹|钢琴版|纯音乐|音效|铃声|试听|片段|剪辑|教程|教学|扒带|midi/i,
		factor: 0.45,
	},
	mild: {
		pattern:
			/翻唱|cover|remix|混音|鬼畜|二创|live|现场|演唱会|无损音质\s*测试/i,
		factor: 0.85,
	},
}

/**
 * 计算负向标记的惩罚系数。
 *
 * @returns {{factor: number, matched: string[]}} 系数与命中的档位（用于诊断）
 */
function titlePenalty(title) {
	const matched = []
	let factor = 1
	if (TITLE_PENALTIES.strong.pattern.test(title)) {
		factor *= TITLE_PENALTIES.strong.factor
		matched.push('strong')
	}
	if (TITLE_PENALTIES.mild.pattern.test(title)) {
		factor *= TITLE_PENALTIES.mild.factor
		matched.push('mild')
	}
	return { factor, matched }
}

/**
 * 「标题证据」：B 站标题与目标歌名的匹配程度。
 *
 * ## 为什么要额外看「完整包含」
 *
 * 软相似度（bigram 集合）对 B 站标题很不友好 —— 实测同一首歌的标题是
 * `郑润泽《如果呢》百万豪装录音棚大声听`，目标是 `如果呢`：
 * bigram 相似度只有 **0.21**，因为相似度把「多出来的那一大串」算成了不相似。
 * 但直觉上这个匹配**非常确定**：B 站标题里原样出现了完整歌名。
 *
 * 所以把「标题是否**完整包含**目标歌名」当作强信号，与软相似度取较大值：
 *
 * ```
 * 标题证据 = max( 软相似度, 完整包含 ? 1.0 : 0 )
 * ```
 *
 * 加这条之前，6 首样本的分数全落在 0.57–0.72（**全部只能进 `review`**），
 * 因为标题分被噪声拖到 0.14–0.43；加上之后真正对的匹配能进 `auto`。
 *
 * ## 为什么要求歌名 ≥2 个字符
 *
 * 单字歌名（如「光」）会被几乎任何标题包含 —— 那不是证据。所以低于 2 个
 * 字符时只用软相似度。
 */
function titleEvidence(songTitle, videoTitle, primitives) {
	const soft = primitives.titleSimilarity(songTitle, videoTitle)
	const normalizedSong = primitives.normalizeTitle(songTitle)
	if (normalizedSong.length < 2) return soft
	const normalizedVideo = primitives.normalizeTitle(videoTitle)
	return normalizedVideo.includes(normalizedSong) ? 1 : soft
}

/**
 * 「歌手证据」：网易云歌手与 B 站候选的匹配程度。
 *
 * @param {string} songArtist 网易云的歌手（可能是 `A/B` 形式）
 * @param {string} uploader B 站上传者
 * @param {string} videoTitle B 站标题
 * @param {{artistSimilarity: Function, normalizeArtist: Function, normalizeTitle: Function, toHalfWidth: Function}} primitives
 */
function artistEvidence(songArtist, uploader, videoTitle, primitives) {
	if (!songArtist) return 0

	// 1) 与上传者比较（偶尔搬运号就叫歌手名）
	const byUploader = primitives.artistSimilarity(songArtist, uploader)

	// 2) 歌手是否出现在标题里 —— B 站的主要信号
	const normalizedArtist = primitives.normalizeArtist(songArtist)
	const normalizedTitle = primitives.normalizeTitle(videoTitle)
	let byTitle = 0
	if (normalizedArtist) {
		// ⚠️ 按**空白**拆分，而不是按原始分隔符。
		//
		// core 的 `normalizeArtist` 会把 `程思源/Rapeter` 归一成
		// `"程思源 rapeter"` —— 它把各种分隔符（`/`、`、`、`&`…）统一成了空格
		// （因为它内部是给 `artistSimilarity` 用的，那边会自己再拆）。
		//
		// 第一版按 `/[、,，/&]/` 拆，于是拿到整个 `"程思源 rapeter"` 去做
		// `includes` 判断，永远不命中 —— 表现为合唱曲的 `artistScore` 恒为 0
		// （实测「皇家蓝(ft. Rapeter)」那首：标题里明明有 `程思源`，却给了 0 分）。
		//
		// 逐个歌手判断并取「任一命中」而不是平均值：合唱曲里常有一个歌手
		// 没被写进标题，平均会把这份证据稀释掉。
		for (const single of normalizedArtist.split(/[\s、,，/&]+/)) {
			const name = single.trim()
			// 单字符名字（如 `A`）太容易误命中，要求 ≥2 个字符
			if (name.length < 2) continue
			if (normalizedTitle.includes(name)) {
				byTitle = 1
				break
			}
		}
	}

	return Math.max(byUploader, byTitle)
}

/**
 * 给一首歌找 B 站候选并打分。
 *
 * @param {{title: string, artist?: string, duration?: number|null}} track
 */
async function matchTrack(track) {
	const primitives = {
		titleSimilarity: core.titleSimilarity,
		artistSimilarity: core.artistSimilarity,
		durationSimilarity: core.durationSimilarity,
		normalizeTitle: core.normalizeTitle,
		normalizeArtist: core.normalizeArtist,
		toHalfWidth: core.toHalfWidth,
	}
	const { AUTO_MATCH_THRESHOLD, MIN_USABLE_SCORE } = core

	for (const [name, fn] of Object.entries(primitives)) {
		if (typeof fn !== 'function') {
			throw new Error(`core 未导出匹配原语 ${name}（bundle 过期？）`)
		}
	}

	// 搜索关键词用「标题 + 第一个作者」—— 只用标题召回太宽，只用作者没有意义。
	// 网易云的 `artist` 可能是 `A/B`，而 B 站搜索是多词 AND 语义，
	// 全带上会把结果限得过窄，所以只取第一个。
	const primaryArtist = (track.artist ?? '').split('/')[0]?.trim() ?? ''
	const keyword = [track.title, primaryArtist].filter(Boolean).join(' ')

	let videos = []
	try {
		videos = await searchVideos(keyword, 1)
	} catch (error) {
		// 搜索失败不该让整批导入中断 —— 记为未匹配，用户可重试
		return {
			status: 'unmatched',
			best: null,
			candidates: [],
			keyword,
			error: `搜索失败：${error.message}`,
		}
	}

	if (videos.length === 0) {
		return { status: 'unmatched', best: null, candidates: [], keyword }
	}

	/** 逐条打分 */
	const scored = videos
		.slice(0, SEARCH_PAGE_SIZE)
		.map((video) => {
			const titleScore = titleEvidence(
				track.title ?? '',
				video.title ?? '',
				primitives,
			)
			const artistScore = artistEvidence(
				track.artist ?? '',
				video.author ?? '',
				video.title ?? '',
				primitives,
			)
			// 时长缺失时给中性分（而不是 0）—— 拿不到时长不等于「时长不对」
			const durationScore =
				typeof track.duration === 'number' && typeof video.duration === 'number'
					? primitives.durationSimilarity(track.duration, video.duration)
					: 0.5

			const rawScore =
				TRACK_WEIGHTS.title * titleScore +
				TRACK_WEIGHTS.artist * artistScore +
				TRACK_WEIGHTS.duration * durationScore

			// 负向标记惩罚：伴奏/鼓谱/纯音乐这类「标题对得上但不是原曲」的候选
			const penalty = titlePenalty(video.title ?? '')
			const score = rawScore * penalty.factor

			return {
				bvid: video.bvid,
				title: video.title,
				artist: video.author,
				duration: video.duration ?? null,
				durationText: video.durationText ?? null,
				cover: video.cover ?? null,
				play: video.play ?? null,
				score,
				rawScore,
				titleScore,
				artistScore,
				durationScore,
				/** 命中的负向档位（空表示没有被罚） */
				penalties: penalty.matched,
			}
		})
		.filter((entry) => entry.bvid)
		.sort((a, b) => b.score - a.score)

	const best = scored[0] ?? null
	const score = best?.score ?? 0

	let status = 'unmatched'
	if (best && score >= AUTO_MATCH_THRESHOLD) status = 'auto'
	else if (best && score >= MIN_USABLE_SCORE) status = 'review'

	return {
		status,
		best,
		// 只回传前 N 个候选，避免一次导入 200 首时把 IPC 打爆
		candidates: scored.slice(0, CANDIDATE_LIMIT),
		keyword,
		thresholds: { auto: AUTO_MATCH_THRESHOLD, usable: MIN_USABLE_SCORE },
		weights: TRACK_WEIGHTS,
	}
}

/**
 * 批量匹配。
 *
 * **串行**而不是并发：B 站搜索接口对突发请求敏感，200 首并发会被限流
 * （表现为大量 `search 接口失败`）。串行慢但稳；`onProgress` 让调用方
 * 能显示进度，用户不会以为卡死。
 *
 * @param {Array<object>} tracks
 * @param {{onProgress?: (done: number, total: number, current: object) => void, signal?: AbortSignal}} [options]
 */
async function matchPlaylist(tracks, { onProgress, signal } = {}) {
	const results = []
	for (const [index, track] of tracks.entries()) {
		if (signal?.aborted) break
		const match = await matchTrack(track)
		results.push({ ...track, match })
		onProgress?.(index + 1, tracks.length, track)
	}
	return results
}

/**
 * 把匹配结果导入本地歌单。
 *
 * **不在这里解析音频**：解析一首一份 `playurl` 请求，200 首会让导入慢到
 * 无法接受，而解析本来就在播放时按需发生（`audio-proxy.cjs` 的缓存）。
 * 这里只落库（`tracks` + `bilibili_metadata` + `playlist_tracks`）。
 *
 * @param {object} options
 * @param {string} options.title 歌单标题
 * @param {number|string} options.remoteId 远端歌单 id（用于「已导入」判重）
 * @param {string|null} [options.cover] 封面
 * @param {Array<{title: string, artist: string, duration: number|null, bvid: string}>} options.items
 * @param {(bvid: string) => Promise<object>} options.resolveInfo 取 cid/作者（注入，便于测试）
 * @param {object} options.db
 */
async function importMatched({
	title,
	remoteId,
	cover,
	items,
	resolveInfo,
	db,
}) {
	if (remoteId === undefined || remoteId === null) {
		// 之前这里写成了 `items.id`（items 是数组，`.id` 永远是 undefined），
		// 于是所有外部歌单都会用 0 当身份 -> 互相认领成同一个歌单。
		throw new Error('importMatched 需要一个明确的 remoteId（远端歌单 id）')
	}
	const playlist = db.upsertRemotePlaylist({
		source: db.REMOTE_SOURCE.NETEASE,
		remoteId,
		title,
		coverUrl: cover ?? null,
	})

	const known = db.getPlaylistBvids(playlist.id)
	const failures = []
	let added = 0
	let skipped = 0

	for (const item of items) {
		if (known.has(item.bvid)) {
			skipped += 1
			continue
		}
		try {
			// 需要 cid 才能播放；这里必须请求 view（与收藏夹导入同样的理由）
			const info = await resolveInfo(item.bvid)
			const track = db.upsertTrack({
				uniqueKey: `bilibili::${item.bvid}`,
				title: info.title ?? item.title,
				artistName: info.owner ?? item.artist ?? '未知作者',
				artistRemoteId: info.ownerMid ?? null,
				coverUrl: info.cover ?? item.cover ?? null,
				duration: info.duration ?? item.duration ?? 0,
				bvid: item.bvid,
				cid: info.cid,
				isMultiPage: (info.pages ?? 1) > 1,
			})
			if (db.addTrackToPlaylist(playlist.id, track.id)) {
				added += 1
			}
		} catch (error) {
			failures.push({
				bvid: item.bvid,
				title: item.title,
				error: error.message,
			})
		}
	}

	const total = db.markPlaylistSynced(playlist.id)
	return {
		playlistId: playlist.id,
		title: playlist.title,
		added,
		skipped,
		itemCount: total,
		failures,
	}
}

module.exports = {
	matchTrack,
	matchPlaylist,
	importMatched,
	artistEvidence,
	titleEvidence,
	titlePenalty,
	TRACK_WEIGHTS,
	TITLE_PENALTIES,
	CANDIDATE_LIMIT,
	SEARCH_PAGE_SIZE,
	// 重新导出便于验证脚本单独用
	getAudioStream,
	getVideoInfo,
}
