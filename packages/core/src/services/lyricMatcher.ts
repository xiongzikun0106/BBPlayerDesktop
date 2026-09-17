/**
 * 歌词候选匹配（纯逻辑，不碰网络）。
 *
 * 输入是「本地歌曲元信息」+「歌词源搜索到的候选」，输出是**排序好的候选 + 置信度**。
 * 之所以把它拆成独立文件：它是整个歌词功能里最容易出错（也最容易回归）的一段，
 * 必须能脱离端口 / 网络单独单测，见 `scripts/verify-lyrics.mts`。
 *
 * 打分模型（0~1）：
 *  - 标题相似度 55%
 *  - 歌手匹配   30%
 *  - 时长接近度 15%
 * 三项都差时不会因为「标题碰巧像」而被选中（这是最常见的误匹配来源）。
 */

/** 传进来的本地歌曲元信息 */
export interface SongMeta {
	title: string
	/** 演唱者；B 站场景下通常是 UP 主或「歌手 - 曲名」里的歌手 */
	artist?: string
	/** 时长（秒）。缺省时该项不参与打分，权重会重新分配 */
	duration?: number
}

/** 歌词源返回的候选 */
export interface LyricsCandidate {
	/** 源内 id：网易云是 number，其它源可能是 string */
	remoteId: string | number
	source: string
	title: string
	artist: string
	/** 时长（秒） */
	duration?: number
	/** 专辑名（可选，仅用于展示） */
	album?: string
}

export interface ScoredLyricsCandidate<
	T extends LyricsCandidate = LyricsCandidate,
> {
	candidate: T
	/** 综合置信度 0~1 */
	score: number
	titleScore: number
	artistScore: number
	durationScore: number
}

/** 权重：标题 > 歌手 > 时长 */
const WEIGHTS = {
	title: 0.55,
	artist: 0.3,
	duration: 0.15,
} as const

/** 时长完全一致视为 1 分，超出该秒数视为 0 分 */
const DURATION_TOLERANCE_SEC = 20
/** 时长差在该秒数内给满分 */
const DURATION_EXACT_SEC = 3
/** 达到该分数即可直接用，不需要人工确认 */
export const AUTO_MATCH_THRESHOLD = 0.75
/** 低于该分数视为不可用 */
export const MIN_USABLE_SCORE = 0.45

const FULL_WIDTH_OFFSET = 0xfee0

/** 全角转半角（同时也处理全角空格） */
export function toHalfWidth(input: string): string {
	let out = ''
	for (const char of input) {
		const code = char.codePointAt(0) ?? 0
		if (code === 0x3000) {
			out += ' '
		} else if (code > 0xff00 && code < 0xff5f) {
			out += String.fromCodePoint(code - FULL_WIDTH_OFFSET)
		} else {
			out += char
		}
	}
	return out
}

/**
 * 去括号内容。
 *
 * 需要支持成对的中英文括号，并允许括号内再嵌一层（如 `歌名 (Live (2020))`）。
 */
function stripBrackets(input: string): string {
	const OPENERS = '([{（【「'
	const CLOSERS = ')]}）】」'
	let out = ''
	let depth = 0
	for (const char of input) {
		if (OPENERS.includes(char)) {
			depth++
			continue
		}
		if (CLOSERS.includes(char)) {
			depth = Math.max(0, depth - 1)
			continue
		}
		if (depth === 0) out += char
	}
	return out
}

/**
 * 常见「版本说明 / 噪声」标记，标题比对前从**第一次出现处**截断。
 *
 * 三条硬性约束（都是实测踩出来的）：
 *  1. 必须带前导空格 —— 否则 `Song` 会被开头的 `s` + `\b` 匹配掉，削成 `ong`；
 *  2. 必须带后向断言 `(?=$|\s|[\d\p{P}])` —— 否则会切掉 `Songbird` 这种
 *     「关键词恰好是更长单词前缀」的标题；
 *  3. 前导只吃掉空格与标点，不吃字母 —— 否则会连标题正文一起删掉。
 *
 * 已知取舍：`Live and Let Die` 因为关键词不在词首而幸免，但
 * `Song Live in Tokyo` 会被截成 `Song`（版本说明天然在尾部，可接受）。
 */
const NOISE_MARKER =
	/ (?:\d{1,2}:\d{2}|[\s\d\p{P}]*)?\b(?:feat|ft|featuring|remaster(?:ed)?|official|live|acoustic|unplugged|instrumental|karaoke|伴奏|纯音乐|cover|demo|remix|mix|edit|version|ver|album|single|tv\s*size|lyrics?|sub(?:bed)?|字幕|歌词|动态歌词|mv|pv|hd|hq|4k|8k)\b(?=$|\s|[\d\p{P}])/iu

/**
 * 标题里纯装饰性的连接符，统一成空格。
 *
 * ⚠️ 这里的连字符必须是正则里的**字面量**（放在字符类首尾）。曾经写成
 * `[-_~～...]`，其中 `~～` 被解析成 `0x7E-0xFF5E` 的**区间**，
 * 恰好把 `A-Z` / `a-z` 全吃进去，标题会被削成 `ong` 这种残渣。
 */
const SEPARATORS = /[‐‑‒–—―・·|｜/\\_~～-]+/g

/**
 * 只保留中日韩文字、字母、数字与空格（丢弃所有标点）。
 *
 * 这里刻意**不用** `\p{Script=Han}` / `\p{Script=Hiragana}`：
 * 实测 Node 26 里 `/[^\p{Script=Han}…a-z0-9\s]/gi` 会把假名整段吃掉
 * （`病名は愛だった` -> 全空），而 `gu` 版本又会误删大写字母。
 * 直接写码点区间没有这些坑，行为在所有 JS 引擎上都可预期。
 *
 *  4e00-9fff 汉字 / 3040-30ff 假名 / ac00-d7af 谚文
 *  3400-4dbf 汉字扩展 A / 20000-2fa1f 汉字扩展 B~
 */
const NON_WORD =
	/[^\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u{20000}-\u{2fa1f}A-Za-z0-9\s]/gu

/**
 * 标题归一化：全角转半角 -> 去括号内容 -> 去噪声后缀 -> 去标点 -> 小写。
 *
 * 例：
 *  - `Never Gonna Give You Up (Official Video)` -> `never gonna give you up`
 *  - `病名は愛だった - feat. 初音ミク`            -> `病名は愛だった`
 *  - `Song - Remastered 2011`                   -> `song`
 *
 * 去噪声必须用「截断」而不是「删除关键词」：`Song - Live` 里删掉 `live`
 * 会得到 `song`，但 `Live and Let Die` 这种把 live 放在开头的曲名一旦被
 * 全局删除就会毁掉标题。截断只影响版本说明这种天然位于尾部的部分。
 */
export function normalizeTitle(raw: string): string {
	if (!raw) return ''
	let text = toHalfWidth(raw)
	text = stripBrackets(text)
	text = text.replace(SEPARATORS, ' ')
	text = text.replace(NOISE_MARKER, '\u0000').split('\u0000')[0] ?? ''
	text = text.replace(NON_WORD, ' ')
	text = text.replace(/\s+/g, ' ').trim()
	return text.toLowerCase()
}

/** 去掉 B 站标题里把 UP 主名字塞进歌名的常见写法 */
export function stripArtistPrefix(title: string, artist?: string): string {
	if (!artist) return title
	const prefixPattern = new RegExp(
		`^\\s*${escapeRegExp(artist)}\\s*[-–—:：]\\s*`,
		'i',
	)
	return escapeRegExp(artist) && prefixPattern.test(title)
		? title.replace(prefixPattern, '')
		: title
}

function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 二元组集合，用于 Dice 系数 */
function bigrams(input: string): Set<string> {
	const compact = input.replace(/\s+/g, '')
	const grams = new Set<string>()
	if (compact.length <= 1) {
		if (compact.length === 1) grams.add(compact)
		return grams
	}
	for (let i = 0; i < compact.length - 1; i++) {
		grams.add(compact.slice(i, i + 2))
	}
	return grams
}

/**
 * 字符串相似度 = Dice 二元组系数（0~1）。
 *
 * 选它而不是编辑距离：歌名普遍很短、且中英文混杂，编辑距离对
 * 「多一个后缀词」和「完全不相干」的区分度不如二元组重合度。
 * 完全相等直接短路返回 1，避免短字符串上二元组退化。
 */
export function titleSimilarity(a: string, b: string): number {
	const left = a.toLowerCase()
	const right = b.toLowerCase()
	if (!left || !right) return 0
	if (left === right) return 1

	const gramsA = bigrams(left)
	const gramsB = bigrams(right)
	if (gramsA.size === 0 || gramsB.size === 0) return 0

	let overlap = 0
	for (const gram of gramsA) {
		if (gramsB.has(gram)) overlap++
	}
	return (2 * overlap) / (gramsA.size + gramsB.size)
}

/** 歌手名归一化：去括号、去 `Official` 之类噪声、小写 */
export function normalizeArtist(raw: string): string {
	if (!raw) return ''
	let text = toHalfWidth(raw)
	text = stripBrackets(text)
	text = text.replace(
		/\b(official|channel|music|records?|official\s*channel)\b/gi,
		' ',
	)
	text = text.replace(NON_WORD, ' ')
	return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** 把「A / B & C」这类多歌手串拆开（空格也是分隔符，`A B` 视为两位歌手） */
function splitArtists(raw: string): string[] {
	return normalizeArtist(raw)
		.split(/[\s/&,、]+/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
}

/**
 * 歌手匹配度 0~1。
 *
 * 三者取最大：完全相同 / 一方包含另一方 / 词集合有交集。
 * 之所以要「包含」这一档：B 站标题里的 UP 主名常常是
 * 「歌手名 Official」或「歌手名-搬运」，直接相等会漏掉。
 */
export function artistSimilarity(
	wantedArtist: string | undefined,
	candidateArtist: string,
): number {
	const wanted = normalizeArtist(wantedArtist ?? '')
	const found = normalizeArtist(candidateArtist)
	if (!wanted || !found) return 0
	if (wanted === found) return 1
	if (found.includes(wanted) || wanted.includes(found)) return 0.85

	const wantedTokens = new Set(splitArtists(wantedArtist ?? ''))
	const foundTokens = splitArtists(candidateArtist)
	if (wantedTokens.size === 0 || foundTokens.length === 0) return 0
	let hit = 0
	for (const token of foundTokens) {
		if (wantedTokens.has(token)) hit++
	}
	return hit > 0 ? 0.7 : 0
}

/**
 * 时长接近度 0~1。
 *
 * `|Δ| <= 3s` 满分，`|Δ| >= 20s` 归零，中间线性衰减。
 * 只要有一侧缺时长，就返回 `null` 表示「该项不参与打分」——
 * 返回 0 会惩罚「候选没给时长」这种无辜情况。
 */
export function durationSimilarity(
	wanted?: number,
	candidate?: number,
): number | null {
	if (
		typeof wanted !== 'number' ||
		typeof candidate !== 'number' ||
		!Number.isFinite(wanted) ||
		!Number.isFinite(candidate) ||
		wanted <= 0 ||
		candidate <= 0
	) {
		return null
	}
	const diff = Math.abs(wanted - candidate)
	if (diff <= DURATION_EXACT_SEC) return 1
	if (diff >= DURATION_TOLERANCE_SEC) return 0
	return (
		1 -
		(diff - DURATION_EXACT_SEC) / (DURATION_TOLERANCE_SEC - DURATION_EXACT_SEC)
	)
}

/** 单条候选打分 */
export function scoreCandidate<T extends LyricsCandidate>(
	song: SongMeta,
	candidate: T,
): ScoredLyricsCandidate<T> {
	const wantedTitle = normalizeTitle(stripArtistPrefix(song.title, song.artist))
	const foundTitle = normalizeTitle(candidate.title)
	const titleScore = titleSimilarity(wantedTitle, foundTitle)
	const artistScore = artistSimilarity(song.artist, candidate.artist)
	const durationScore = durationSimilarity(song.duration, candidate.duration)

	// 缺时长时把它的权重按比例分给标题与歌手，而不是让总分凭空少 15%
	const weights = { ...WEIGHTS } as Record<keyof typeof WEIGHTS, number>
	if (durationScore === null) {
		const redistributed = weights.duration
		const restTotal = weights.title + weights.artist
		weights.title += (redistributed * weights.title) / restTotal
		weights.artist += (redistributed * weights.artist) / restTotal
		weights.duration = 0
	}

	const weighted =
		titleScore * weights.title +
		artistScore * weights.artist +
		(durationScore ?? 0) * weights.duration

	// 加权和有一个天然缺陷：只要权重最高的标题满分，哪怕歌手完全不同、
	// 时长差了十几分钟，总分依然能到 0.64。这里对某一维**明显不成立**的情况
	// 直接乘惩罚系数 —— 这不是微调，而是「同名不同曲」的主要拦截手段。
	let gate = 1
	if (titleScore < 0.35) gate *= 0.5
	if (artistScore === 0) gate *= 0.7
	else if (artistScore < 0.6) gate *= 0.92
	// 只有两侧都给了时长才有意义；缺时长不算「不成立」
	if (durationScore !== null && durationScore === 0) gate *= 0.7
	else if (durationScore !== null && durationScore < 0.4) gate *= 0.9

	return {
		candidate,
		score: clamp01(weighted * gate),
		titleScore,
		artistScore,
		durationScore: durationScore ?? 0,
	}
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0
	return Math.min(1, Math.max(0, value))
}

/**
 * 给所有候选打分并按置信度降序排序。
 *
 * 排序是稳定的：同分时保持原顺序（搜索接口的相关度排序本身有信息量）。
 */
export function rankLyricsCandidates<T extends LyricsCandidate>(
	song: SongMeta,
	candidates: readonly T[],
): ScoredLyricsCandidate<T>[] {
	return candidates
		.map((candidate) => scoreCandidate(song, candidate))
		.sort((a, b) => b.score - a.score)
}

/**
 * 取最佳匹配。
 *
 * `minScore` 默认 `AUTO_MATCH_THRESHOLD`：低于阈值的候选宁可返回 null，
 * 让上层走「手动搜索」而不是塞一份错误的歌词。
 */
export function pickBestLyricsCandidate<T extends LyricsCandidate>(
	song: SongMeta,
	candidates: readonly T[],
	minScore = AUTO_MATCH_THRESHOLD,
): ScoredLyricsCandidate<T> | null {
	const ranked = rankLyricsCandidates(song, candidates)
	const best = ranked[0]
	if (!best) return null
	return best.score >= minScore ? best : null
}

/** 置信度 -> 人类可读的档位（UI 用来决定「直接使用 / 需要确认」） */
export function describeConfidence(
	score: number,
): 'high' | 'medium' | 'low' | 'none' {
	if (score >= AUTO_MATCH_THRESHOLD) return 'high'
	if (score >= MIN_USABLE_SCORE) return 'medium'
	if (score > 0) return 'low'
	return 'none'
}
