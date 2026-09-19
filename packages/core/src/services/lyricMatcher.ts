/**
 * 歌词候选匹配（纯逻辑，不碰网络）。
 *
 * 输入是「本地歌曲元信息」+「歌词源搜索到的候选」，输出是**排序好的候选 + 置信度**。
 * 之所以把它拆成独立文件：它是整个歌词功能里最容易出错（也最容易回归）的一段，
 * 必须能脱离端口 / 网络单独单测，见 `scripts/verify-lyrics.mts`。
 *
 * 打分模型（0~1）：标题 50% / 歌手 30% / 时长 20%。
 *
 * ## 为什么长这样：从「B 站脏标题」的实测基准移植
 *
 * 基准在 `lyrics_hit_rate_test_molde/`：100 个用例 = 真实 B 站视频标题 × 真实三源候选池。
 * 移植前的实测是 **召回 99% / 端到端命中 0% / 过度拒绝 99%** —— 正确答案就在候选池里，
 * 旧实现却一律放弃。四条根因，逐条对应下面的实现：
 *
 * 1. `《如果呢》` 被当普通括号**整段删掉**。B 站音乐视频的歌名最常写在 `《》` 里，
 *    删掉等于把最关键的证据扔掉：`郑润泽《如果呢》百万豪装录音棚大声听` 与候选
 *    `如果呢` 的 Dice 只剩 ~0.06。现在只有 `【】`/`[]` 这类画质 / 属性装饰被丢弃，
 *    `《》`/`「」` 的内容**展开保留**（`unwrapBiliDecorations`）。
 * 2. 歌手维度拿 **B 站上传者** 去比。上传者是搬运号（`JLRS-LeoFM`、`光遇琴谱Tofo`），
 *    直接比恒为 0，这一维等于不存在。现在歌手证据 = `max(候选歌手是否出现在脏标题里,
 *    与 song.artist 的相似度)` —— 保留后半条是为了不退化成「本地曲目的歌手字段也没用」。
 * 3. 标题证据只有 Dice 软相似度。改成 `max(软相似度, 候选歌名在脏标题里的覆盖率)`：
 *    上面那条例子的 Dice 只有 ~0.2，而覆盖率是 1.0 —— 后者才是「非常确定」的来源。
 * 4. 时长 `≤3s 满分 / ≥20s 归零` 对**含前后奏的视频时长**等于失效，放宽到 5s / 120s。
 *    另外补了两档负向词（伴奏 / 鼓谱 / 指弹 / 卡拉 OK 重罚，翻唱 / remix / live 轻罚）：
 *    它是基准里唯一的「误自动采用」来源，而且**只能靠补特征修，不能靠调阈值修**
 *    （阈值从 0.45 提到 0.90，误采用率恒为 2%）。
 *
 * 移植后**同一份数据**的实测：端到端命中 0% → 89%、可用 100%、误自动采用 0%、
 * 过度拒绝 0%。⚠️ 权重、惩罚系数与阈值都是在 25 首歌 / 100 个用例上调出来的，
 * 存在过拟合风险；换数据集请重跑阈值扫描，不要直接沿用这些数字。
 */

/** 传进来的本地歌曲元信息 */
export interface SongMeta {
	title: string
	/**
	 * 演唱者。⚠️ **B 站场景下这里是 UP 主**（`apps/desktop/src/ipc-handlers.cjs` 的
	 * `lyrics:autoMatch` 就是这么传的），所以它只能当弱证据：打分时会与
	 * 「候选歌手是否出现在标题里」取较大值，见 `scoreCandidate`。
	 */
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
	/** 标题证据：`max(Dice 软相似度, 候选歌名在标题里的覆盖率)` */
	titleScore: number
	/** 歌手证据：`max(候选歌手出现在标题里, 与 song.artist 的相似度)` */
	artistScore: number
	/**
	 * 时长接近度。**缺时长时这里是 0**（与旧版一致，避免改坏调用方的算术），
	 * 「不参与打分」这层含义已经落在 `score` 里（权重被按比例让给了其它维度）。
	 */
	durationScore: number
}

/**
 * 权重：标题 > 歌手 > 时长。
 *
 * 比旧版的 0.55 / 0.30 / 0.15 略向时长倾斜：B 站标题噪声大，标题证据的天花板低，
 * 而时长是最难造假的证据（它含前后奏，但不会凭空偏几十秒）。
 */
const WEIGHTS = {
	title: 0.5,
	artist: 0.3,
	duration: 0.2,
} as const

/** 时长差在该秒数内给满分 */
const DURATION_EXACT_SEC = 5
/**
 * 时长差达到该秒数归零。
 *
 * 旧版是 20s —— 而这里比的是**视频时长**（含前后奏 / 片头片尾 / 直播切片），
 * 与录音室版本的差值动辄 10~30s，20s 的窗口实际等于让这一维随机生效。
 */
const DURATION_ZERO_SEC = 120

/**
 * 达到该分数即可直接用，不需要人工确认。
 *
 * 取 0.45 而不是旧版的 0.75，依据是基准里的阈值扫描：0.40~0.50 是一段**平台区**
 * （89% 命中 / 100% 可用 / 0% 误自动采用），而 0.72~0.75 只给 84~85% 命中，
 * 还要多拒掉 7~8% 的用例。关键在于**提高阈值并不能降低误自动采用率**，
 * 它买到的只是「本来能给出可用歌词（多为翻唱，歌词一样）的用例变成什么都没有」。
 * 拒绝的代价是实打实的（用户没歌词），所以低阈值是更优的工作点。
 *
 * ⚠️ `apps/desktop/src/track-matcher.cjs` 也读这个常量（B 站视频匹配那套打分），
 * 那边的分数尺度与这里不同，改这里会同时影响它。
 */
export const AUTO_MATCH_THRESHOLD = 0.45
/**
 * 低于该分数视为不可用（`describeConfidence` 的 `medium` 档、桌面端 track-matcher
 * 的 `review` 档）。
 *
 * 必须**严格低于** `AUTO_MATCH_THRESHOLD`，否则 `medium` 这一档永远不可达 ——
 * 旧版两个常量都是 0.45，就是这种自相矛盾的状态。这里取 0.3：低于它的候选基本
 * 只剩「标题局部重合」，交给用户人工确认即可，没必要直接丢掉。
 */
export const MIN_USABLE_SCORE = 0.3

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
 * 「展开」书名号 / 引号：`《X》` -> ` X `，同时**丢弃**方括号装饰 `【X】`/`[X]`。
 *
 * 对应 B 站标题的两类写法，必须区别对待：
 *  - `郑润泽《如果呢》百万豪装…` —— 歌名在书名号里，必须留下（旧版在这里丢掉歌名）；
 *  - `【4K修复】Rick Astley - …` —— 方括号装的是画质 / 属性标记，必须丢掉。
 */
function unwrapBiliDecorations(input: string): string {
	return input
		.replace(/[《「『]([^》」』]*)[》」』]/g, ' $1 ')
		.replace(/[【[［]([^】\]］]*)[】\]］]/g, ' ')
}

/**
 * 去**成对圆括号**里的内容。
 *
 * 需要支持成对的中英文括号，并允许括号内再嵌一层（如 `歌名 (Live (2020))`）。
 * `《》`/`「」` 不在这里处理：它们在 `unwrapBiliDecorations` 里被展开保留。
 */
function stripBrackets(input: string): string {
	const OPENERS = '([{（【「『'
	const CLOSERS = ')]}）】」』'
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
 * **紧贴式**中文噪声词，单独再截一次。
 *
 * 上面那条规则要求噪声词前必须有空格（这条约束本身是对的：去掉它
 * `Live and Let Die` 会被截成空串）。但中文标题常常整段没有空格，
 * `如果呢-郑润泽 高质量和声伴奏` 里的「伴奏」紧贴「声」，于是截断不到，
 * 关键词里就会一直带着「高质量和声伴奏」去搜索 —— 实测这条明显拖累召回。
 *
 * 所以取**最早**出现的那个中文装饰词截断，且要求它前面还有内容
 * （否则会把「歌名恰好叫伴奏」这种极端情况削成空串）。这里刻意只收
 * 「几乎不可能是歌名一部分」的词；`片段`/`试听`/`铃声` 这类有可能是真歌名的词，
 * 只放在负向惩罚表里，不参与截断。
 */
const CJK_NOISE_MARKER =
	/高质量|高音质|无损音质|动态歌词|完整版|伴奏|纯音乐|鼓谱|动态谱|附谱|谱例|指弹|钢琴版|音效|字幕|和声|翻唱|现场版|演唱会|教学|教程|扒带|dj\s*版|remix\s*版/i

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
 * 标题归一化：全角转半角 -> 展开 `《》` / 丢弃 `【】` -> 去圆括号内容
 * -> 截断版本噪声 -> 去标点 -> 小写。**两侧（本地标题与候选标题）共用。**
 *
 * ⚠️ 与旧版唯一的、也是决定性的区别：旧版把 `《》` 当普通括号，内容**整段删除**。
 * 两侧都会出现「歌名被书名号包着」的写法，删掉会让匹配彻底失效：
 *
 * | 输入 | 旧版 | 现在 |
 * | --- | --- | --- |
 * | `郑润泽《如果呢》百万豪装录音棚大声听`（B 站标题） | `郑润泽百万豪装录音棚大声听` | `郑润泽 如果呢 百万豪装录音棚大声听` |
 * | `郑润泽《如果呢 (DJ阿智版)》`（QQ 候选） | `郑润泽` | `郑润泽 如果呢` |
 *
 * 第二行尤其危险：旧版把它削成 `郑润泽` 之后，「郑润泽」这三个字原样出现在
 * B 站标题里，反而会让一个 DJ 版候选拿到满分的标题证据。
 *
 * 去噪声必须用「截断」而不是「删除关键词」：`Song - Live` 里删掉 `live`
 * 会得到 `song`，但 `Live and Let Die` 这种把 live 放在开头的曲名一旦被
 * 全局删除就会毁掉标题。截断只影响版本说明这种天然位于尾部的部分。
 */
export function normalizeTitle(raw: string): string {
	if (!raw) return ''
	let text = toHalfWidth(raw)
	text = unwrapBiliDecorations(text)
	text = stripBrackets(text)
	text = text.replace(SEPARATORS, ' ')
	text = text.replace(NOISE_MARKER, '\u0000').split('\u0000')[0] ?? ''
	// 紧贴式中文噪声词再截一次（见 CJK_NOISE_MARKER 的说明）
	const cjkCut = text.search(CJK_NOISE_MARKER)
	if (cjkCut > 0) {
		const head = text.slice(0, cjkCut).trim()
		if (head.length > 0) text = head
	}
	text = text.replace(NON_WORD, ' ')
	return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * 去掉 B 站标题里把 UP 主名字塞进歌名的常见写法（`歌手 - 歌名` -> `歌名`）。
 *
 * 打分器**不再需要**它：新版的标题证据含「候选歌名在标题里的覆盖率」，
 * `Rick Astley - Never Gonna Give You Up` 对候选 `Never Gonna Give You Up`
 * 的覆盖率天然是 1.0。保留导出只是因为它在 core 的公开面上（`track-matcher.cjs`
 * 这类消费方可能仍在用），删掉属于破坏性改动。
 */
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
 * 字符串相似度 = Dice 二元组系数（0~1）—— **软**证据那一半。
 *
 * 选它而不是编辑距离：歌名普遍很短、且中英文混杂，编辑距离对
 * 「多一个后缀词」和「完全不相干」的区分度不如二元组重合度。
 * 完全相等直接短路返回 1，避免短字符串上二元组退化。
 *
 * 传进来的应当是**原始字符串**（函数只做小写）；需要标题证据时用
 * `scoreCandidate`，它还会额外算覆盖率并取较大值。
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

/** 最长公共子串长度（标题都很短，O(n·m) 的动态规划足够） */
function longestCommonSubstringLength(a: string, b: string): number {
	if (!a || !b) return 0
	let best = 0
	let previous = new Array<number>(b.length + 1).fill(0)
	for (let i = 1; i <= a.length; i++) {
		const current = new Array<number>(b.length + 1).fill(0)
		for (let j = 1; j <= b.length; j++) {
			if (a[i - 1] === b[j - 1]) {
				const value = (previous[j - 1] ?? 0) + 1
				current[j] = value
				if (value > best) best = value
			}
		}
		previous = current
	}
	return best
}

/**
 * 「候选歌名有多大比例原样出现在（脏）标题里」。
 *
 * 用最长公共子串而不是 `includes`：`如果呢DJ版` 这种候选（歌名被粘上了后缀）
 * 用 `includes` 会直接判 0，而 LCS 能拿到 `如果呢` 这 3 个字符。
 * 要求候选至少 2 个字符：单字歌名会被几乎任何标题包含，那不是证据。
 */
function containmentRatio(noisy: string, candidate: string): number {
	const cleanCandidate = candidate.replace(/\s+/g, '')
	if (cleanCandidate.length < 2) return 0
	const longest = longestCommonSubstringLength(
		noisy.replace(/\s+/g, ''),
		cleanCandidate,
	)
	return longest / cleanCandidate.length
}

/**
 * 歌手名归一化。
 *
 * ⚠️ 与标题相反：歌手名里的括号几乎总是**别名 / 本名**而不是版本说明，必须
 * **展开保留**而不是删除。实测踩到的例子：
 *  - `冯沁苑(买辣椒也用券)` 是《起风了》的真实条目，删掉括号后剩下的 `冯沁苑`
 *    与真值 `买辣椒也用券` 毫无交集，会让整首歌解析失败；
 *  - 反过来，`Adele (Official Channel)` 展开后由下面那行关键词清理掉。
 */
export function normalizeArtist(raw: string): string {
	if (!raw) return ''
	let text = toHalfWidth(raw)
	text = text.replace(
		/[《「『(（【[［]([^》」』)）】\]］]*)[》」』)）】\]］]/g,
		' $1 ',
	)
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
 * `|Δ| <= 5s` 满分，`|Δ| >= 120s` 归零，中间线性衰减。
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
	if (diff >= DURATION_ZERO_SEC) return 0
	return (
		1 - (diff - DURATION_EXACT_SEC) / (DURATION_ZERO_SEC - DURATION_EXACT_SEC)
	)
}

/**
 * 候选标题上的负向标记（搬自 `apps/desktop/src/track-matcher.cjs:87-98`，按实测补词）。
 *
 * `karaoke` 这一档是**阈值扫描逼出来的**：把阈值从 0.45 一路提到 0.90，误自动采用率
 * 始终是 2% —— 说明那 2% 的分数非常高，靠阈值根本拦不住。看明细才发现两条都是
 * 卡拉 OK 版，而它们的歌手字段里**写着原唱**（`Adele / Karaoke Diamonds / DR`），
 * 于是「候选歌手出现在标题里」这条证据被完美满足、拿到 1.000。
 * 补上 `karaoke` 后两项都消失。这类错误只能靠**特征**修，不能靠**阈值**修。
 */
const NEGATIVE_STRONG =
	/伴奏|和声\s*backup|backing\s*track|鼓谱|动态谱|附谱|谱例|指弹|钢琴版|纯音乐|音效|铃声|试听|片段|剪辑|教程|教学|扒带|midi|instrumental|karaoke|卡拉\s*ok|消音|无人声/i
const NEGATIVE_MILD =
	/翻唱|cover|remix|混音|鬼畜|二创|\blive\b|现场|演唱会|dj\s*版|\bdj\b|原唱/i

/** 负向标记的乘法系数：减法对高分候选不够狠，乘法能把「伴奏 + 完美标题」压到阈值下 */
function titlePenalty(title: string): number {
	let factor = 1
	if (NEGATIVE_STRONG.test(title)) factor *= 0.45
	if (NEGATIVE_MILD.test(title)) factor *= 0.85
	return factor
}

/**
 * 候选歌手是否**原样出现在**归一化标题里。
 *
 * 逐个歌手判断并取「任一命中」而不是平均值：合唱曲常有一个歌手没被写进标题，
 * 平均会把这份证据稀释掉（`track-matcher.cjs:180-181` 有同一个坑的记录）。
 * 单字名字（如 `A`）太容易误命中，直接忽略。
 */
function artistInTitle(noisyTitle: string, candidateArtist: string): number {
	for (const token of splitArtists(candidateArtist)) {
		if (token.length < 2) continue
		if (noisyTitle.includes(token)) return 1
	}
	return 0
}

interface Evidence {
	title: { score: number; soft: number; contain: number }
	artist: { score: number; byTitle: number; byUploader: number }
	/** null 表示时长不参与打分（某一侧没给） */
	duration: number | null
}

/** 把一条候选的三维证据算出来（池级信息不在这里，见 `rankLyricsCandidates`） */
function collectEvidence(song: SongMeta, candidate: LyricsCandidate): Evidence {
	const noisyTitle = normalizeTitle(song.title)
	const candidateTitle = normalizeTitle(candidate.title)
	const soft = titleSimilarity(noisyTitle, candidateTitle)
	const contain = containmentRatio(noisyTitle, candidateTitle)

	// 歌手证据 = max(候选歌手出现在标题里, 与 song.artist 的相似度)。
	// 前半条是 B 站场景的主信号（上传者不可信，但标题里通常写着歌手），
	// 后半条保证本地曲目（artist 字段确实是歌手）不被削弱。
	const byTitle = artistInTitle(noisyTitle, candidate.artist)
	const byUploader = artistSimilarity(song.artist, candidate.artist)

	return {
		title: { score: Math.max(soft, contain), soft, contain },
		artist: {
			score: Math.max(byTitle, byUploader),
			byTitle,
			byUploader,
		},
		duration: durationSimilarity(song.duration, candidate.duration),
	}
}

/** `scoreCandidate` 的池级上下文；只给一条候选打分时可以不传 */
export interface ScoreContext {
	/**
	 * 候选池里是否存在任何歌手证据。
	 *
	 * 默认 `true`（不退化歌手维度）。`rankLyricsCandidates` 会按整池判断：
	 * 若**没有任何**候选能命中歌手，说明这条输入里根本没有歌手信息
	 * （例如 B 站标题是纯演奏视频），此时把歌手权重按比例让给标题与时长。
	 */
	artistInformative?: boolean
	/** 返回同一首歌（归一化标题 + 歌手相同）的**不同源**数量，用于跨源一致性加分 */
	sourceVotes?: number
}

/** 把某一维的权重按比例分给其余维度（而不是让总分凭空少一块） */
function redistribute(
	weights: Record<keyof typeof WEIGHTS, number>,
	key: keyof typeof WEIGHTS,
): void {
	const removed = weights[key]
	if (removed <= 0) return
	weights[key] = 0
	const rest = weights.title + weights.artist + weights.duration
	if (rest <= 0) return
	if (key !== 'title') weights.title += (removed * weights.title) / rest
	if (key !== 'artist') weights.artist += (removed * weights.artist) / rest
	if (key !== 'duration')
		weights.duration += (removed * weights.duration) / rest
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0
	return Math.min(1, Math.max(0, value))
}

/** 加权 + 门限 + 惩罚 + 跨源加分，产出最终置信度 */
function scoreWithEvidence<T extends LyricsCandidate>(
	candidate: T,
	evidence: Evidence,
	context: Required<ScoreContext>,
): ScoredLyricsCandidate<T> {
	// 两处「缺项」的粒度不同，这一点很重要：
	//  - 歌手：只要池子里没有任何候选命中歌手，就说明这条输入里根本没有歌手信息，
	//    整池退化掉这一维；
	//  - 时长：只把这一条候选没给时长的那份权重分掉，不影响别的候选。
	const weights = { ...WEIGHTS } as Record<keyof typeof WEIGHTS, number>
	if (!context.artistInformative) redistribute(weights, 'artist')
	if (evidence.duration === null) redistribute(weights, 'duration')

	const weighted =
		evidence.title.score * weights.title +
		evidence.artist.score * weights.artist +
		(evidence.duration ?? 0) * weights.duration

	// 加权和有一个天然缺陷：只要权重最高的标题满分，哪怕歌手完全不同、
	// 时长差了十几分钟，总分依然能到 0.6 以上。这里对某一维**明显不成立**的情况
	// 直接乘惩罚系数 —— 这不是微调，而是「同名不同曲」的主要拦截手段。
	let gate = 1
	if (evidence.title.score < 0.3) gate *= 0.45
	else if (evidence.title.score < 0.5) gate *= 0.85
	if (context.artistInformative) {
		if (evidence.artist.score === 0) gate *= 0.72
		else if (evidence.artist.score < 0.6) gate *= 0.92
	}
	if (evidence.duration !== null) {
		if (evidence.duration === 0) gate *= 0.7
		else if (evidence.duration < 0.35) gate *= 0.9
	}

	let score = clamp01(weighted * gate * titlePenalty(candidate.title))

	// 跨源一致性加分：多一个源返回同一条目加 0.03，最多 +0.06。
	//
	// 直觉上「多个源都返回它」是好证据，整体也确实是正收益（基准里 89% vs 关闭时
	// 86%）。但代价很反直觉：**被多个平台同时收录的常常是翻唱 / 盗版**。
	// 反例（B 站标题是光遇琴谱演奏、压根没写歌手）：`如果呢 — DJ郭逍遥` 被 QQ 与
	// 酷狗同时返回，加分后被抬到 1.000，把真正的 `如果呢 — 郑润泽`（0.988）挤到第二位。
	// 保留它是因为净值 +3pp，这条注释留着，避免以后被单个案例误导着把它删掉。
	if (context.sourceVotes > 1) {
		score = clamp01(score + Math.min(0.06, 0.03 * (context.sourceVotes - 1)))
	}

	return {
		candidate,
		score,
		titleScore: evidence.title.score,
		artistScore: evidence.artist.score,
		durationScore: evidence.duration ?? 0,
	}
}

/** 跨源同一条目的判定键：归一化标题 + 归一化歌手 */
function equivalenceKey(candidate: LyricsCandidate): string {
	return `${normalizeTitle(candidate.title)}|${normalizeArtist(candidate.artist)}`
}

/**
 * 单条候选打分。
 *
 * `context` 是**池级**信息：单独调用时默认「歌手维度有效、无跨源加分」，
 * 这等价于「这条候选自己就是全部候选」。要让它与整池排序完全一致，
 * 请用 `rankLyricsCandidates`。
 */
export function scoreCandidate<T extends LyricsCandidate>(
	song: SongMeta,
	candidate: T,
	context: ScoreContext = {},
): ScoredLyricsCandidate<T> {
	return scoreWithEvidence(candidate, collectEvidence(song, candidate), {
		artistInformative: context.artistInformative ?? true,
		sourceVotes: context.sourceVotes ?? 1,
	})
}

/**
 * 给所有候选打分并按置信度降序排序。
 *
 * 排序是稳定的：同分时保持原顺序（搜索接口的相关度排序本身有信息量）。
 *
 * ⚠️ 这里**不合并、不丢弃**任何条目（即使两条候选归一化后完全相同）：
 * 上层会按排名**逐条尝试取歌词**，跳过没有歌词的条目
 * （`scripts/verify-lyrics.mts` [C2] 就是这个用法），合并会让后备候选凭空消失。
 * 跨源一致性只作为**加分**统计，不改变条目数量。
 */
export function rankLyricsCandidates<T extends LyricsCandidate>(
	song: SongMeta,
	candidates: readonly T[],
): ScoredLyricsCandidate<T>[] {
	// 同一个 `(归一化标题, 归一化歌手)` 被几个**不同源**返回 —— 只统计，不合并
	const sourcesByKey = new Map<string, Set<string>>()
	const prepared = candidates.map((candidate) => {
		const key = equivalenceKey(candidate)
		const sources = sourcesByKey.get(key) ?? new Set<string>()
		sources.add(candidate.source)
		sourcesByKey.set(key, sources)
		return { candidate, key, evidence: collectEvidence(song, candidate) }
	})
	const artistInformative = prepared.some(
		(item) => item.evidence.artist.score > 0,
	)

	return prepared
		.map((item) =>
			scoreWithEvidence(item.candidate, item.evidence, {
				artistInformative,
				sourceVotes: sourcesByKey.get(item.key)?.size ?? 1,
			}),
		)
		.sort((a, b) => b.score - a.score)
}

/**
 * 取最佳匹配。
 *
 * `minScore` 默认 `AUTO_MATCH_THRESHOLD`：低于阈值的候选宁可返回 null，
 * 让上层走「手动搜索」而不是塞一份错误的歌词。
 *
 * 注意阈值只是**最后一道闸**：基准里提高阈值并不能降低误自动采用率，
 * 真正拦住错误候选的是上面的门限与负向词。
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
