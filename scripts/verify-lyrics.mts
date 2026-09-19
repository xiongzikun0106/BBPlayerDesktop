/* oxlint-disable no-console -- 验证脚本，以 stdout 输出 */
/**
 * 验证歌词模块：网易云接口 + 候选匹配 + LRC 解析合并。
 *
 * 覆盖三块：
 *  [A] `services/lyricMatcher` 纯逻辑（不联网，含易错场景）
 *  [B] `packages/splash` 解析器（手写 LRC -> 断言行/时间/翻译合并）
 *  [C] 真实网络：搜索 -> 匹配 -> 取歌词 -> 解析 -> 断言时间戳递增
 *
 * 用法：
 *   pnpm exec tsx scripts/verify-lyrics.mts            # 全部
 *   pnpm exec tsx scripts/verify-lyrics.mts --offline  # 跳过网络部分（CI 无外网时）
 */
import process from 'node:process'

import {
	buildLyricsSearchKeyword,
	lyricCandidatesLookLikeInstrumental,
	neteaseLyricsApiClient,
	normalizeTitle,
	rankLyricsCandidates,
	registerCorePorts,
	toLyricsCandidates,
} from '../packages/core/src/index.ts'
import type {
	CorePorts,
	LyricsCandidate,
	SongMeta,
} from '../packages/core/src/index.ts'
import { parseSpl } from '../packages/splash/src/parser/index.ts'
// 注意：这里刻意**不**从 `packages/splash/src/index.ts` 走 barrel import。
// splash 的 package.json 没有 `"type": "module"`，Node 会把它目录下的 `.ts`
// 当 CJS 处理，`export * from './parser/merge'` 这类再导出在 ESM 里就看不见了
// （实测：namespace 只剩 `default` / `module.exports`）。直接引子模块即可。
import { parseAndMergeLyrics } from '../packages/splash/src/parser/merge.ts'

const OFFLINE = process.argv.includes('--offline')

// ---------------------------------------------------------------
// Node 侧端口（最小实现，与 verify-bilibili-api.mts 一致）
// ---------------------------------------------------------------

const kv = new Map<string, string>()

const noopLogger = {
	debug: () => {},
	info: () => {},
	warn: (message: string) => console.log(`  [warn] ${message}`),
	error: (message: string) => console.log(`  [error] ${message}`),
	extend(): typeof noopLogger {
		return noopLogger
	},
}

const ports: CorePorts = {
	logger: noopLogger,
	storage: {
		getString: (key) => kv.get(key),
		getBoolean: (key) => {
			const value = kv.get(key)
			return value === undefined ? undefined : value === 'true'
		},
		set: (key, value) => void kv.set(key, value),
		delete: (key) => void kv.delete(key),
		contains: (key) => kv.has(key),
		clearAll: () => kv.clear(),
	},
	secureStorage: {
		getItem: async () => null,
		setItem: async () => {},
		deleteItem: async () => {},
	},
	db: {
		client: null,
		sqlite: {
			execSync: () => {},
			runSync: () => {},
			getFirstSync: () => null,
			getAllSync: () => [],
			withTransactionSync: (task) => task(),
		},
		orm: null,
	},
	http: (input, init) =>
		fetch(String(input), {
			method: init?.method,
			headers: init?.headers,
			body: init?.body,
			signal: init?.signal,
		}),
	bilibili: {
		getCookie: async () => null,
		setCookie: async () => {},
	},
}

registerCorePorts(ports)

// ---------------------------------------------------------------
// 断言工具
// ---------------------------------------------------------------

let passed = 0
let failed = 0
let skipped = 0

function check(label: string, ok: boolean, detail = ''): void {
	if (ok) {
		passed++
		console.log(`  ✅ ${label}${detail ? `  — ${detail}` : ''}`)
	} else {
		failed++
		console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`)
	}
}

function skip(label: string, why: string): void {
	skipped++
	console.log(`  ⏭  ${label}  — ${why}`)
}

function section(title: string): void {
	console.log(`\n${title}`)
}

// ---------------------------------------------------------------
// [A] lyricMatcher 纯逻辑
// ---------------------------------------------------------------

/** 造一个候选，字段名短一点省地方 */
function cand(
	remoteId: number,
	title: string,
	artist: string,
	duration?: number,
): LyricsCandidate {
	return { remoteId, source: 'netease', title, artist, duration }
}

function testNormalizeTitle(): void {
	section('[A1] 标题归一化（清洗后应完全相同）')
	// `normalizeTitle` 没有从 core 的公开面单独导出，这里用「清洗后应当完全
	// 相同 => titleScore === 1」间接断言。左右两侧都必须是「原始标题」，
	// 而不是「已洗好的标题」—— 后者永远不会相等（曾经就这么写错过）。
	const cases: [string, string][] = [
		['Never Gonna Give You Up (Official Video)', 'Never Gonna Give You Up'],
		['Song - Remastered 2011', 'Song'],
		['Song（Live）', 'Song'],
		['Song [Live]', 'Song'],
		['Song feat. Somebody', 'Song'],
		['Song Ft. Somebody', 'Song'],
		['【官方】病名は愛だった', '病名は愛だった'],
		['Ｓｏｎｇ　Ｎａｍｅ', 'Song Name'],
		['Hello, World!', 'Hello World'],
		['A   B', 'A B'],
		['Song (Live (2020))', 'Song'],
		['song - instrumental', 'song'],
		['Song Official Music Video', 'Song'],
	]
	for (const [input, expected] of cases) {
		check(`"${input}" ≈ "${expected}"`, normalizeViaScore(input, expected))
	}

	// 反向用例：归一化必须真的有区分度，不能「什么都判相同」
	check(
		'"Song" 与 "Another Song" 不应判为同一标题',
		!normalizeViaScore('Song', 'Another Song'),
	)
	/*
	 * ⚠️ 这条**直接断言 `normalizeTitle`**，不再用 `normalizeViaScore` 代理。
	 *
	 * 原来的写法是"如果归一化正确，那么 `Live and Let Die` 与 `Die` 的打分
	 * 就不该相等" —— 一个间接代理。标题证据改成
	 * `max(Dice 相似度, 候选歌名的覆盖率)` 之后代理失效了：
	 * `Die` 是标题的**完整子串**，覆盖率 1.0 → 判为相同。
	 * 但归一化本身没坏（`normalizeTitle('Live and Let Die')` 没有被截断）。
	 *
	 * 教训：**代理断言会在被测实现换了算法之后悄悄测错东西**。
	 * 能直接断言被测函数就直接断言。
	 */
	check(
		'"Live and Let Die" 不能被噪声词削成 "Die"',
		normalizeTitle('Live and Let Die') !== normalizeTitle('Die') &&
			normalizeTitle('Live and Let Die').toLowerCase().includes('die'),
		`normalizeTitle = 「${normalizeTitle('Live and Let Die')}」`,
	)
}

/**
 * `normalizeTitle` 没有从 core 的公开面单独导出（避免把内部细节固化进 API），
 * 这里用「归一化后应当完全相同 => titleSimilarity === 1」来间接断言。
 */
function normalizeViaScore(input: string, expected: string): boolean {
	const score = rankLyricsCandidates({ title: input }, [
		cand(1, expected, '', 0),
	])[0]
	return score?.titleScore === 1
}

function testRanking(): void {
	section('[A2] 候选排序（含易错场景）')

	// A2-1 精确匹配优先
	{
		const song: SongMeta = {
			title: 'Never Gonna Give You Up',
			artist: 'Rick Astley',
			duration: 213,
		}
		const ranked = rankLyricsCandidates(song, [
			cand(1, 'Never Gonna Give You Up', 'Rick Astley', 214),
			cand(2, 'Never Gonna Give You Up (Live)', 'Rick Astley', 250),
			cand(3, 'Never Gonna Give You Up', 'Some Cover Band', 212),
			cand(4, 'Together Forever', 'Rick Astley', 213),
		])
		check(
			'精确匹配排第一',
			ranked[0]?.candidate.remoteId === 1,
			`top=${ranked[0]?.candidate.remoteId} score=${ranked[0]?.score.toFixed(3)}`,
		)
		check(
			'同名但时长差很远（Live 版）排在录音室版之后',
			ranked.findIndex((item) => item.candidate.remoteId === 2) > 0,
		)
		check(
			'歌手不同的同名候选排在精确匹配之后',
			ranked.findIndex((item) => item.candidate.remoteId === 3) > 0,
		)
		check(
			'好候选置信度为 high',
			ranked[0] !== undefined && ranked[0].score >= 0.75,
			ranked[0]?.score.toFixed(3) ?? '',
		)
	}

	// A2-2 标题相同但时长差很远：必须被时长项压下去
	{
		const song: SongMeta = {
			title: 'Ashes',
			artist: 'Céline Dion',
			duration: 200,
		}
		const ranked = rankLyricsCandidates(song, [
			cand(10, 'Ashes', 'Céline Dion', 480),
			cand(11, 'Ashes', 'Céline Dion', 201),
		])
		check(
			'标题相同、时长差很远时选中时长接近的',
			ranked[0]?.candidate.remoteId === 11,
			`10=${ranked.find((i) => i.candidate.remoteId === 10)?.score.toFixed(3)} ` +
				`11=${ranked.find((i) => i.candidate.remoteId === 11)?.score.toFixed(3)}`,
		)
		const wrong = ranked.find((item) => item.candidate.remoteId === 10)
		check(
			'时长差 280s 的候选即便标题全同也没到自动匹配线',
			wrong !== undefined && wrong.score < 0.75,
			wrong?.score.toFixed(3) ?? '',
		)
	}

	// A2-3 歌手不同：标题全同也不该自动采用
	{
		const song: SongMeta = { title: 'Hello', artist: 'Adele', duration: 295 }
		const ranked = rankLyricsCandidates(song, [
			cand(20, 'Hello', 'Lionel Richie', 295),
			cand(21, 'Hello', 'Adele', 296),
		])
		check(
			'歌手不同则排在歌手相同之后',
			ranked[0]?.candidate.remoteId === 21 &&
				ranked[1]?.candidate.remoteId === 20,
		)
		const wrong = ranked.find((item) => item.candidate.remoteId === 20)
		check(
			'歌手完全不同的候选低于自动匹配线',
			wrong !== undefined && wrong.score < 0.75,
			wrong?.score.toFixed(3) ?? '',
		)
	}

	// A2-4 B 站标题带 UP 主前缀
	{
		const song: SongMeta = {
			title: 'Rick Astley - Never Gonna Give You Up',
			artist: 'Rick Astley',
			duration: 213,
		}
		const ranked = rankLyricsCandidates(song, [
			cand(30, 'Never Gonna Give You Up', 'Rick Astley', 213),
		])
		check(
			'UP 主前缀被剥离后仍能命中',
			ranked[0] !== undefined && ranked[0].score >= 0.9,
			ranked[0]?.score.toFixed(3) ?? '',
		)
	}

	// A2-5 候选缺时长不该被惩罚
	{
		const song: SongMeta = { title: 'Song', artist: 'Artist', duration: 200 }
		const ranked = rankLyricsCandidates(song, [
			cand(40, 'Song', 'Artist'),
			cand(41, 'Song', 'Artist', 400),
		])
		check(
			'缺时长的完美标题/歌手候选依然第一',
			ranked[0]?.candidate.remoteId === 40,
			ranked[0]?.score.toFixed(3) ?? '',
		)
		check(
			'缺时长时候选仍可达 high 档',
			ranked[0] !== undefined && ranked[0].score >= 0.75,
			ranked[0]?.score.toFixed(3) ?? '',
		)
	}

	// A2-6 全角 / 大小写 / 别名
	{
		const song: SongMeta = {
			title: 'Ｄｒｅａｍ　Ｏｎ',
			artist: 'ＡＢＣ',
			duration: 100,
		}
		const ranked = rankLyricsCandidates(song, [
			cand(50, 'Dream On', 'abc', 100),
		])
		check(
			'全角 + 大小写差异被归一化',
			ranked[0] !== undefined && ranked[0].score >= 0.9,
			ranked[0]?.score.toFixed(3) ?? '',
		)
	}

	// A2-7 完全不相关：必须没有可用候选
	{
		const song: SongMeta = {
			title: 'Totally Different Song',
			artist: 'Nobody',
			duration: 180,
		}
		const ranked = rankLyricsCandidates(song, [
			cand(60, 'Another World', 'Someone Else', 300),
		])
		check(
			'毫不相关的候选分数很低',
			ranked[0] !== undefined && ranked[0].score < 0.45,
			ranked[0]?.score.toFixed(3) ?? '',
		)
	}

	// A2-8 空候选
	{
		const ranked = rankLyricsCandidates({ title: 'x' }, [])
		check('空候选列表返回空数组（不抛错）', ranked.length === 0)
	}

	// A2-9 多歌手串
	{
		const song: SongMeta = { title: 'Song', artist: 'A / B', duration: 120 }
		const ranked = rankLyricsCandidates(song, [cand(70, 'Song', 'B & C', 120)])
		check(
			'多歌手串按 token 命中',
			ranked[0] !== undefined && ranked[0].artistScore > 0,
			`artistScore=${ranked[0]?.artistScore.toFixed(3)}`,
		)
	}
}

function testHelpers(): void {
	section('[A3] 关键词构造 / 纯音乐识别')
	check(
		'关键词 = 清洗后标题 + 歌手',
		buildLyricsSearchKeyword('Song (Live)', 'Artist') === 'song Artist',
		buildLyricsSearchKeyword('Song (Live)', 'Artist'),
	)
	check(
		'无歌手时只留标题',
		buildLyricsSearchKeyword('Song', undefined) === 'song',
		buildLyricsSearchKeyword('Song', undefined),
	)
	check(
		'空歌词判为纯音乐',
		lyricCandidatesLookLikeInstrumental({
			lrc: '',
			tlyric: null,
			romalrc: null,
		}),
	)
	check(
		'有歌词则不是纯音乐',
		!lyricCandidatesLookLikeInstrumental({
			lrc: '[00:01.00]hi',
			tlyric: null,
			romalrc: null,
		}),
	)
}

// ---------------------------------------------------------------
// [B] splash 解析器
// ---------------------------------------------------------------

function testParser(): void {
	section('[B1] LRC 解析（手写输入）')

	const lrc = [
		'[ti:测试歌曲]',
		'[ar:测试歌手]',
		'[00:01.00]第一行',
		'[00:03.500]第二行',
		'[00:06.25]第三行',
		'[00:10.00]',
		'[00:12.00]第四行',
	].join('\n')

	const parsed = parseSpl(lrc)
	check('标签被正确解析', parsed.meta.ti === '测试歌曲', parsed.meta.ti)
	check('解析出 5 行', parsed.lines.length === 5, `实际 ${parsed.lines.length}`)
	check(
		'时间戳为毫秒且递增',
		parsed.lines.every(
			(line, index) =>
				index === 0 || line.startTime > parsed.lines[index - 1].startTime,
		),
		parsed.lines.map((line) => line.startTime).join(','),
	)
	check(
		'首行时间 1000ms',
		parsed.lines[0]?.startTime === 1000,
		String(parsed.lines[0]?.startTime),
	)
	check(
		'第二行时间 3500ms（三位小数）',
		parsed.lines[1]?.startTime === 3500,
		String(parsed.lines[1]?.startTime),
	)
	check(
		'第三行时间 6250ms（两位小数）',
		parsed.lines[2]?.startTime === 6250,
		String(parsed.lines[2]?.startTime),
	)
	check(
		'内容不含时间标签',
		parsed.lines[0]?.content === '第一行',
		parsed.lines[0]?.content,
	)
	check(
		'空内容行被保留（用于「间奏」占位）',
		parsed.lines[3]?.content === '',
		JSON.stringify(parsed.lines[3]?.content),
	)

	section('[B2] 翻译 / 罗马音合并（时间戳对齐）')

	const tlyric = [
		'[00:01.00]line one',
		'[00:03.500]line two',
		'[00:06.25]line three',
		'[00:12.00]line four',
	].join('\n')

	const merged = parseAndMergeLyrics({ lrc, tlyric })
	check('合并后仍是 5 行', merged.length === 5, `实际 ${merged.length}`)
	check(
		'翻译按时间戳对齐到第 1 行',
		merged[0]?.translation === 'line one',
		String(merged[0]?.translation),
	)
	check(
		'翻译按时间戳对齐到第 3 行',
		merged[2]?.translation === 'line three',
		String(merged[2]?.translation),
	)
	check(
		'无翻译的行取到 undefined 而不是串行错位',
		merged[3]?.translation === undefined,
		String(merged[3]?.translation),
	)
	check(
		'translations 兼容数组被填充',
		merged[0]?.translations.length === 1,
		JSON.stringify(merged[0]?.translations),
	)

	section('[B3] 时间轴不匹配的翻译必须被丢弃')
	const mismatched = parseAndMergeLyrics({
		lrc,
		tlyric: '[00:40.00]a\n[00:50.00]b\n[01:00.00]c\n',
	})
	check(
		'时间轴完全对不上的翻译被丢弃（避免串行）',
		mismatched.every((line) => line.translation === undefined),
		JSON.stringify(mismatched.map((line) => line.translation)),
	)

	section('[B4] 非法输入')
	let threw = false
	try {
		parseSpl('这不是歌词')
	} catch {
		threw = true
	}
	check('非法行抛 SplParseError', threw)
	check('空串解析出 0 行', parseSpl('').lines.length === 0)
}

// ---------------------------------------------------------------
// [C] 真实网络
// ---------------------------------------------------------------

async function testNetwork(): Promise<void> {
	section('[C1] 真实网络：搜索 -> 匹配 -> 取歌词 -> 解析')

	const song: SongMeta = {
		title: 'Never Gonna Give You Up',
		artist: 'Rick Astley',
		duration: 213,
	}

	const search = await neteaseLyricsApiClient.searchLyrics(
		buildLyricsSearchKeyword(song.title, song.artist),
		10,
	)
	check(
		'搜索接口返回成功',
		search.isOk(),
		search.isErr() ? search.error.message : '',
	)

	if (search.isErr()) {
		check('搜索失败后续步骤无法进行', false)
		return
	}

	const rawSongs = search.value
	check('搜索结果非空', rawSongs.length > 0, `${rawSongs.length} 条`)
	if (rawSongs.length === 0) return
	console.log(
		`      原始首条: id=${rawSongs[0]?.id} name="${rawSongs[0]?.name}" ` +
			`artists=${(rawSongs[0]?.artists ?? []).map((a) => a.name).join('/')} ` +
			`duration=${rawSongs[0]?.duration}ms`,
	)

	const candidates = toLyricsCandidates(rawSongs)
	check(
		'候选时长由毫秒转成秒',
		(candidates[0]?.duration ?? 0) > 0 && (candidates[0]?.duration ?? 0) < 3600,
		String(candidates[0]?.duration),
	)

	const ranked = rankLyricsCandidates(song, candidates)
	check('打分排序产出非空', ranked.length > 0)
	// 「Rick Astley」在网易云有多个同名条目（原唱 + 各种 Tribute Band），
	// 且实测原唱 18520488 有时返回空歌词。所以这里断言的是
	// **排序是否把歌手/时长更接近的排在前面**，而不是硬编码单个 id。
	const top = ranked[0]
	check(
		'最佳匹配置信度 >= 0.75',
		top !== undefined && top.score >= 0.75,
		top ? `${top.score.toFixed(3)} (${String(top.candidate.remoteId)})` : '',
	)
	if (!top) return
	console.log(
		`      最佳匹配: id=${String(top.candidate.remoteId)} ` +
			`"${top.candidate.title}" - ${top.candidate.artist} ` +
			`${top.candidate.duration}s  score=${top.score.toFixed(3)}`,
	)

	// 排行榜必须严格降序
	check(
		'候选按置信度降序排列',
		ranked.every(
			(item, index) => index === 0 || item.score <= ranked[index - 1].score,
		),
	)

	section('[C2] 取歌词并解析（候选逐个尝试，跳过无歌词条目）')

	// 已知的实测样例，用来确认搜索确实能召回到原唱
	const knownIds = new Set(['18520488'])
	check(
		'搜索结果包含原唱 id 18520488',
		candidates.some((item) => knownIds.has(String(item.remoteId))),
		candidates.map((item) => String(item.remoteId)).join(','),
	)

	let used: LyricsCandidate | null = null
	let lrc = ''
	let tlyric: string | null = null
	let romalrc: string | null = null
	let emptyLyricSeen = false

	for (const item of ranked) {
		const result = await neteaseLyricsApiClient.fetchLyricsById(
			Number(item.candidate.remoteId),
		)
		if (result.isErr()) {
			console.log(
				`      id=${String(item.candidate.remoteId)} 取歌词失败: ${result.error.message}`,
			)
			continue
		}
		if (result.value.isInstrumental || result.value.lrc.length === 0) {
			emptyLyricSeen = true
			console.log(`      id=${String(item.candidate.remoteId)} 无歌词（跳过）`)
			continue
		}
		used = item.candidate
		lrc = result.value.lrc
		tlyric = result.value.tlyric
		romalrc = result.value.romalrc
		break
	}

	check('至少有一个候选返回了可用歌词', used !== null)
	if (!used) {
		check('解析后行数 > 0', false, '没有可用歌词，无法继续')
		return
	}
	console.log(
		`      采用 id=${String(used.remoteId)} "${used.title}" - ${used.artist}`,
	)
	check('原始歌词非空', lrc.length > 0, `${lrc.length} 字符`)
	check(
		'翻译歌词存在（实测有翻译；若网易云改了数据则此处会失败）',
		tlyric !== null && tlyric.length > 0,
		tlyric ? `${tlyric.length} 字符` : 'null',
	)
	console.log(`      romalrc: ${romalrc ? `${romalrc.length} 字符` : 'null'}`)
	if (emptyLyricSeen) {
		console.log(
			'      （过程中确实遇到空歌词条目，证明「跳过并继续」分支被执行到）',
		)
	}

	const merged = parseAndMergeLyrics({
		lrc,
		...(tlyric ? { tlyric } : {}),
		...(romalrc ? { romalrc } : {}),
	})
	check('解析后行数 > 0', merged.length > 0, `${merged.length} 行`)
	check(
		'时间戳严格递增',
		merged.every(
			(line, index) =>
				index === 0 || line.startTime > merged[index - 1].startTime,
		),
	)
	check(
		'每行都有结束时间（且不早于开始时间）',
		merged.every((line) => line.endTime >= line.startTime),
	)
	check(
		'内容非空行占比 > 50%',
		merged.filter((line) => line.content.trim().length > 0).length /
			merged.length >
			0.5,
	)
	if (tlyric) {
		const translated = merged.filter((line) => line.translation).length
		check(
			'至少合并上一行翻译',
			translated > 0,
			`${translated}/${merged.length} 行有翻译`,
		)
	}
	const first = merged.find((line) => line.content.trim().length > 0)
	console.log(
		`      首行: [${(first?.startTime ?? 0) / 1000}s] ${first?.content ?? ''}` +
			(first?.translation ? ` / ${first.translation}` : ''),
	)
	const last = merged.at(-1)
	console.log(
		`      末行: [${(last?.startTime ?? 0) / 1000}s] ${last?.content ?? ''}`,
	)

	section('[C3] 错误分支')
	const badId = await neteaseLyricsApiClient.fetchLyricsById(-1)
	check('非法 id 返回 err 而不是抛异常', badId.isErr())
	const emptyKeyword = await neteaseLyricsApiClient.searchLyrics('   ')
	check('空关键词返回 err', emptyKeyword.isErr())
	const knownLyrics = await neteaseLyricsApiClient.fetchLyricsById(18520488)
	check(
		'对已知 id 的取歌词请求本身不报错（无歌词也算成功）',
		knownLyrics.isOk(),
		knownLyrics.isErr()
			? knownLyrics.error.message
			: `isInstrumental=${String(knownLyrics.value.isInstrumental)}`,
	)
}

// ---------------------------------------------------------------
// main
// ---------------------------------------------------------------

async function main(): Promise<void> {
	console.log('=== 歌词模块验证（网易云接口 + 匹配算法 + LRC 解析）===')
	console.log(`模式: ${OFFLINE ? '离线（跳过网络）' : '在线（含真实网络）'}`)

	testNormalizeTitle()
	testRanking()
	testHelpers()
	testParser()

	if (OFFLINE) {
		skip('[C] 真实网络', '--offline')
	} else {
		try {
			await testNetwork()
		} catch (error) {
			failed++
			console.log(`  ❌ 网络部分异常: ${String(error)}`)
		}
	}

	console.log(`\n${'='.repeat(56)}`)
	console.log(
		`通过 ${passed} 项，失败 ${failed} 项${skipped ? `，跳过 ${skipped} 项` : ''}`,
	)
	console.log('='.repeat(56))
	process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
	console.error('验证脚本异常:', error)
	process.exit(1)
})
