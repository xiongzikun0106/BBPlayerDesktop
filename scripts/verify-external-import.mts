/* oxlint-disable no-console -- 验证脚本，以 stdout 输出 */
/**
 * Phase 3.3 验收：**外部歌单导入（网易云）+ 手动匹配**。
 *
 * 这一块是整个桌面端里**唯一有判断成分**的功能 —— 拉歌单是确定性的、
 * 落库是确定性的，只有「这首歌对应 B 站哪个视频」需要启发式。
 * 所以验证的重点也在匹配质量上，而不只是「有没有报错」。
 *
 * 覆盖：
 *  A. 纯函数（离线，确定性）
 *     1. `parsePlaylistId`：各种链接形态 + 否定用例
 *     2. `parseDuration`：`"4:21"` / `"1:02:33"` / 纯秒 / 非法输入
 *     3. `titlePenalty`：强/弱负向标记与系数叠乘
 *     4. `artistEvidence`：上传者命中、标题包含、**多歌手按空白拆分**
 *     5. `titleEvidence`：完整包含 vs 软相似度、单字歌名保护
 *  B. 真实接口（需要网络）
 *     6. 拉一个真实歌单（热歌榜）
 *     7. 匹配若干首，断言「首选是带歌名与歌手的**歌曲**视频」而不只是「有结果」
 *     8. 断言负向标记确实把伴奏/鼓谱压下去（用真实搜索结果里的样本）
 *  C. 落库（注入假 resolver，不依赖网络）
 *     9. 导入到本地歌单、幂等、不同远端 id 不互相认领
 *
 * 用法：pnpm exec tsx scripts/verify-external-import.mts
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')

const DATA_DIR = path.join(os.tmpdir(), `bbplayer-external-${Date.now()}`)
fs.mkdirSync(DATA_DIR, { recursive: true })

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = '') {
	if (ok) {
		passed++
		console.log(`  ✅ ${label}${detail ? `  — ${detail}` : ''}`)
	} else {
		failed++
		console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`)
	}
}

function runNode(script: string): unknown {
	const output = execFileSync(process.execPath, ['-e', script], {
		cwd: DESKTOP,
		encoding: 'utf8',
		env: { ...process.env, BBPLAYER_DATA_DIR: DATA_DIR },
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 180_000,
	})
	const marker = output.lastIndexOf('__RESULT__')
	if (marker === -1) throw new Error(`子进程未返回结果:\n${output}`)
	return JSON.parse(output.slice(marker + '__RESULT__'.length).trim())
}

console.log('=== Phase 3.3 验收：外部歌单导入 + 手动匹配 ===\n')
console.log(`数据目录：${DATA_DIR}\n`)

// ===============================================================
// A. 纯函数
// ===============================================================

console.log('A. 纯函数（离线）\n')

// ---------- 1. parsePlaylistId ----------
{
	const result = runNode(`
		const { parsePlaylistId } = require('./src/netease-playlist.cjs')
		const cases = {
			bare: parsePlaylistId('3778678'),
			canonical: parsePlaylistId('https://music.163.com/playlist?id=3778678'),
			hashRoute: parsePlaylistId('https://music.163.com/#/playlist?id=3778678'),
			mobile: parsePlaylistId('https://y.music.163.com/m/playlist?id=3778678&userid=1'),
			pathForm: parsePlaylistId('https://music.163.com/playlist/3778678/'),
			shared: parsePlaylistId('分享歌单: 热歌榜 https://music.163.com/playlist/3778678/abc'),
			number: parsePlaylistId(12345678),
			// 否定用例
			notPlaylist: parsePlaylistId('https://example.com/foo'),
			shortDigits: parsePlaylistId('123'),
			textWithShortNumber: parsePlaylistId('分享歌单 3'),
			empty: parsePlaylistId(''),
			nullish: parsePlaylistId(null),
			undefinedValue: parsePlaylistId(undefined),
		}
		console.log('__RESULT__' + JSON.stringify(cases))
	`)
	const r = result as any
	check('纯数字直接作为 id', r.bare === '3778678', String(r.bare))
	check('标准链接解析出 id', r.canonical === '3778678', String(r.canonical))
	check(
		'hash 路由形式解析出 id',
		r.hashRoute === '3778678',
		String(r.hashRoute),
	)
	check(
		'移动端链接（带其它 query）解析出 id',
		r.mobile === '3778678',
		String(r.mobile),
	)
	check(
		'路径形式 /playlist/<id> 解析出 id',
		r.pathForm === '3778678',
		String(r.pathForm),
	)
	check('分享文案里的链接解析出 id', r.shared === '3778678', String(r.shared))
	check(
		'数字输入（非字符串）也能解析',
		r.number === '12345678',
		String(r.number),
	)
	check('无关链接返回 null', r.notPlaylist === null, String(r.notPlaylist))
	// ⚠️ 纯数字输入是**无条件接受**的（由服务端去判断 id 是否存在）。
	// 只有「在任意文本里捞数字」那条兜底路径才要求 5 位以上 —— 否则
	// 「分享歌单 3」这种文案里的 3 会被误当成 id。
	// 第一版探针把这两条规则搞混了，断言 `parsePlaylistId('123') === null`，
	// 而实现是接受 —— 错的是断言，不是实现（拒绝一个合法但短的 id
	// 比接受一个不存在的 id 更糟：前者让用户没法导入，后者只是一次报错）。
	check(
		'纯数字输入无条件接受（即使是短数字）',
		r.shortDigits === '123',
		String(r.shortDigits),
	)
	check(
		'但在任意文本里捞数字时要求 5 位以上（避免把文案里的数字当 id）',
		r.textWithShortNumber === null,
		String(r.textWithShortNumber),
	)
	check('空串返回 null', r.empty === null)
	check(
		'null / undefined 返回 null',
		r.nullish === null && r.undefinedValue === null,
	)
}

// ---------- 2. parseDuration ----------
{
	const result = runNode(`
		const { parseDuration } = require('./src/bilibili-api.cjs')
		console.log('__RESULT__' + JSON.stringify({
			mmss: parseDuration('4:21'),
			hmmss: parseDuration('1:02:33'),
			plainSeconds: parseDuration('295'),
			zero: parseDuration('0:00'),
			number: parseDuration(300),
			// 否定/边界
			empty: parseDuration(''),
			text: parseDuration('abc'),
			fourParts: parseDuration('1:2:3:4'),
			nullish: parseDuration(null),
			negativeish: parseDuration('-5'),
		}))
	`)
	const r = result as any
	check('"4:21" -> 261 秒', r.mmss === 261, String(r.mmss))
	check('"1:02:33" -> 3753 秒', r.hmmss === 3753, String(r.hmmss))
	check(
		'"295"（纯秒字符串）-> 295',
		r.plainSeconds === 295,
		String(r.plainSeconds),
	)
	check('"0:00" -> 0', r.zero === 0, String(r.zero))
	check('数字输入原样返回（取整）', r.number === 300, String(r.number))
	check('空串返回 null（不是 0）', r.empty === null, String(r.empty))
	check('非时长文本返回 null', r.text === null, String(r.text))
	check('四段式（非法）返回 null', r.fourParts === null, String(r.fourParts))
	check('null 返回 null', r.nullish === null)
	check('负数不是合法时长', r.negativeish === null, String(r.negativeish))
}

// ---------- 3. titlePenalty ----------
{
	const result = runNode(`
		const { titlePenalty } = require('./src/track-matcher.cjs')
		const cases = {
			clean: titlePenalty('郑润泽《如果呢》百万豪装录音棚'),
			instrumental: titlePenalty('如果呢-郑润泽 高质量和声伴奏'),
			drumScore: titlePenalty('我不难过 孙燕姿 动态鼓谱'),
			guitarTab: titlePenalty('【吉他指弹】甲乙丙丁(你我怎么两清)李佳薇'),
			pureMusic: titlePenalty('纯音乐 海屿你'),
			ringtone: titlePenalty('海屿你 铃声 片段'),
			cover: titlePenalty('【翻唱】明知故犯'),
			live: titlePenalty('孙燕姿 我不难过 Live 现场'),
			// 强 + 弱同时命中，系数应叠乘
			both: titlePenalty('【翻唱】如果呢 伴奏'),
		}
		console.log('__RESULT__' + JSON.stringify(cases))
	`)
	const r = result as any
	check(
		'干净标题不被罚（系数 1）',
		r.clean?.factor === 1 && r.clean?.matched?.length === 0,
		JSON.stringify(r.clean),
	)
	check(
		'「伴奏」命中强负向',
		r.instrumental?.factor === 0.45,
		JSON.stringify(r.instrumental),
	)
	check(
		'「鼓谱」命中强负向',
		r.drumScore?.factor === 0.45,
		JSON.stringify(r.drumScore),
	)
	check(
		'「指弹」命中强负向',
		r.guitarTab?.factor === 0.45,
		JSON.stringify(r.guitarTab),
	)
	check(
		'「纯音乐」命中强负向',
		r.pureMusic?.factor === 0.45,
		JSON.stringify(r.pureMusic),
	)
	check(
		'「铃声」命中强负向',
		r.ringtone?.factor === 0.45,
		JSON.stringify(r.ringtone),
	)
	check(
		'「翻唱」只命中弱负向（罚得轻）',
		r.cover?.factor === 0.85,
		JSON.stringify(r.cover),
	)
	check('「Live」只命中弱负向', r.live?.factor === 0.85, JSON.stringify(r.live))
	check(
		'强 + 弱同时命中时系数叠乘（0.45 × 0.85）',
		Math.abs((r.both?.factor ?? 0) - 0.45 * 0.85) < 1e-9,
		JSON.stringify(r.both),
	)
}

// ---------- 4. artistEvidence ----------
{
	const result = runNode(`
		const { core } = require('./src/ports.cjs')
		const { artistEvidence } = require('./src/track-matcher.cjs')
		const primitives = {
			titleSimilarity: core.titleSimilarity,
			artistSimilarity: core.artistSimilarity,
			durationSimilarity: core.durationSimilarity,
			normalizeTitle: core.normalizeTitle,
			normalizeArtist: core.normalizeArtist,
			toHalfWidth: core.toHalfWidth,
		}
		const ev = (a, u, t) => artistEvidence(a, u, t, primitives)
		console.log('__RESULT__' + JSON.stringify({
			// 歌手出现在标题里（B 站的主要信号）
			inTitle: ev('郑润泽', '某搬运号', '郑润泽《如果呢》百万豪装录音棚'),
			// 上传者就是歌手名（少见但存在）
			asUploader: ev('郑润泽', '郑润泽', '如果呢'),
			// 都不命中
			miss: ev('郑润泽', '某搬运号', '完全无关的标题'),
			// 多歌手：原始分隔符是 /，normalizeArtist 会归一成空格
			multiSlash: ev('程思源/Rapeter', 'x', '皇家蓝Royal Blue程思源Rapeter'),
			multiSlashSecond: ev('程思源/Rapeter', 'x', '皇家蓝 Rapeter 版本'),
			multiComma: ev('周杰伦、方文山', 'x', '周杰伦 方文山 作品'),
			// 单字歌手名太容易误命中，应被忽略
			shortName: ev('A', 'x', 'ABC 的标题'),
			// 无歌手
			noArtist: ev('', 'x', '随便什么标题'),
		}))
	`)
	const r = result as any
	check('歌手出现在标题里 -> 证据 1', r.inTitle === 1, String(r.inTitle))
	check('上传者与歌手同名 -> 证据 1', r.asUploader === 1, String(r.asUploader))
	check('都不命中 -> 证据 0', r.miss === 0, String(r.miss))
	// 这条是那个真实 bug 的回归断言：normalizeArtist 把 `/` 归一成空格，
	// 所以必须按空白拆分才能拿到单个歌手名
	check(
		'多歌手（斜杠分隔）能命中标题里的第一个歌手',
		r.multiSlash === 1,
		`证据=${r.multiSlash}（按原始分隔符拆分会恒为 0）`,
	)
	check(
		'多歌手能命中标题里的第二个歌手',
		r.multiSlashSecond === 1,
		String(r.multiSlashSecond),
	)
	check('多歌手（顿号分隔）也能命中', r.multiComma === 1, String(r.multiComma))
	check(
		'单字歌手名被忽略（避免误命中）',
		r.shortName === 0,
		String(r.shortName),
	)
	check('没有歌手信息 -> 证据 0', r.noArtist === 0, String(r.noArtist))
}

// ---------- 5. titleEvidence ----------
{
	const result = runNode(`
		const { core } = require('./src/ports.cjs')
		const { titleEvidence } = require('./src/track-matcher.cjs')
		const primitives = {
			titleSimilarity: core.titleSimilarity,
			normalizeTitle: core.normalizeTitle,
		}
		const ev = (a, b) => titleEvidence(a, b, primitives)
		const soft = (a, b) => core.titleSimilarity(a, b)
		console.log('__RESULT__' + JSON.stringify({
			// B 站标题噪声多：软相似度很低，但完整包含歌名
			noisyContain: ev('如果呢', '郑润泽《如果呢》百万豪装录音棚大声听'),
			noisySoft: soft('如果呢', '郑润泽《如果呢》百万豪装录音棚大声听'),
			// 精确相等
			exact: ev('如果呢', '如果呢'),
			// 完全无关
			unrelated: ev('如果呢', '某个完全无关的视频标题'),
			// 带括号噪声的歌名（normalizeTitle 会剥掉）
			parenTitle: ev('甲乙丙丁 (你我怎么两清)', '【吉他指弹】甲乙丙丁(你我怎么两清)李佳薇'),
			// 单字歌名不做包含判断（会被几乎任何标题包含）
			singleChar: ev('光', '光年之外 的 某些 光 影'),
			singleCharSoft: soft('光', '光年之外 的 某些 光 影'),
		}))
	`)
	const r = result as any
	check(
		'标题完整包含歌名时证据为 1（即使软相似度很低）',
		r.noisyContain === 1 && Number(r.noisySoft) < 0.5,
		`证据=${r.noisyContain}，软相似度=${Number(r.noisySoft).toFixed(3)}`,
	)
	check('精确相等也是 1', r.exact === 1)
	check(
		'无关标题不会因为「包含」而虚高',
		r.unrelated !== 1,
		String(r.unrelated),
	)
	check(
		'带括号噪声的歌名也能命中（normalizeTitle 会剥掉）',
		r.parenTitle === 1,
		String(r.parenTitle),
	)
	check(
		'单字歌名退化为软相似度（避免被任何标题命中）',
		r.singleChar === r.singleCharSoft,
		`证据=${r.singleChar}，软=${r.singleCharSoft}`,
	)
}

// ===============================================================
// B. 真实接口
// ===============================================================

console.log('\nB. 真实接口（需要网络）\n')

// ---------- 6. 拉真实歌单 ----------
{
	const result = runNode(`
		const { fetchPlaylist } = require('./src/netease-playlist.cjs')
		;(async () => {
			try {
				const playlist = await fetchPlaylist('https://music.163.com/playlist?id=3778678')
				console.log('__RESULT__' + JSON.stringify({
					name: playlist.name,
					total: playlist.total,
					fetched: playlist.fetched,
					playlistId: playlist.playlistId,
					hasCover: Boolean(playlist.cover),
					first: playlist.tracks[0],
					// 字段完整性：匹配需要的三个字段都不能缺
					allHaveTitle: playlist.tracks.every((t) => typeof t.title === 'string' && t.title.length > 0),
					allHaveArtist: playlist.tracks.every((t) => typeof t.artist === 'string'),
					allHaveDuration: playlist.tracks.every((t) => typeof t.duration === 'number' && t.duration > 0),
					durationUnitLooksLikeSeconds: playlist.tracks.every((t) => t.duration > 20 && t.duration < 3600),
				}))
			} catch (error) {
				console.log('__RESULT__' + JSON.stringify({ error: error.message }))
			}
		})()
	`)
	const r = result as any
	if (r.error) {
		check('拉取真实歌单可用', false, r.error)
	} else {
		check(
			'拉到真实歌单',
			r.fetched > 0 && r.playlistId === '3778678',
			`${r.name}（${r.fetched}/${r.total}）`,
		)
		check('歌单带封面上报', r.hasCover === true)
		check('每首都带标题', r.allHaveTitle === true)
		check('每首都带作者', r.allHaveArtist === true)
		check('每首都带时长', r.allHaveDuration === true)
		check(
			'时长已从毫秒换算成秒（不是毫秒原值）',
			r.durationUnitLooksLikeSeconds === true,
			`首曲 duration=${r.first?.duration}（毫秒会是 6 位数）`,
		)
	}
}

// ---------- 7. 真实匹配 ----------
{
	const result = runNode(`
		const { fetchPlaylist } = require('./src/netease-playlist.cjs')
		const { matchTrack } = require('./src/track-matcher.cjs')
		;(async () => {
			try {
				const playlist = await fetchPlaylist(3778678)
				const sample = playlist.tracks.slice(0, 6)
				const results = []
				for (const track of sample) {
					const match = await matchTrack(track)
					results.push({
						song: track.title,
						artist: track.artist,
						duration: track.duration,
						status: match.status,
						keyword: match.keyword,
						bestTitle: match.best?.title ?? null,
						bestDuration: match.best?.duration ?? null,
						score: match.best?.score ?? 0,
						titleScore: match.best?.titleScore ?? 0,
						artistScore: match.best?.artistScore ?? 0,
						durationScore: match.best?.durationScore ?? 0,
						penalties: match.best?.penalties ?? [],
						candidateCount: match.candidates.length,
						error: match.error ?? null,
					})
				}
				console.log('__RESULT__' + JSON.stringify({ results }))
			} catch (error) {
				console.log('__RESULT__' + JSON.stringify({ error: error.message }))
			}
		})()
	`)
	const r = result as any
	if (r.error) {
		check('真实匹配可用', false, r.error)
	} else {
		const results = r.results ?? []
		console.log('    匹配明细：')
		for (const item of results) {
			console.log(
				`      [${item.status.padEnd(9)}] ${item.song.slice(0, 18)} -> ${String(item.bestTitle).slice(0, 40)}` +
					` (${item.score.toFixed(3)} t=${item.titleScore.toFixed(2)} a=${item.artistScore.toFixed(2)} d=${item.durationScore.toFixed(2)})` +
					(item.penalties.length > 0
						? ` [罚:${item.penalties.join(',')}]`
						: ''),
			)
		}

		check(
			'6 首样本全部匹配到候选（没有搜索失败）',
			results.length === 6 &&
				results.every((x: any) => !x.error && x.bestTitle),
			`${results.filter((x: any) => x.bestTitle).length}/6`,
		)
		check(
			'每首都给了候选列表（供人工复核）',
			results.every((x: any) => x.candidateCount > 0),
			results.map((x: any) => x.candidateCount).join(','),
		)
		// 关键质量断言：首选必须**不是**被罚的伴奏/鼓谱（这是加惩罚之前的问题）
		check(
			'首选没有被负向标记惩罚（不是伴奏/鼓谱/指弹）',
			results.every((x: any) => x.penalties.length === 0),
			results
				.filter((x: any) => x.penalties.length > 0)
				.map((x: any) => `${x.song}->[${x.penalties.join(',')}]`)
				.join(' | ') || '全部干净',
		)
		// 歌手维度必须真的起作用（不能恒为 0 —— 那是第一版的 bug）
		check(
			'歌手证据维度真的起作用（不是恒为 0）',
			results.filter((x: any) => x.artistScore > 0).length === results.length,
			`artistScore: ${results.map((x: any) => x.artistScore.toFixed(2)).join(',')}`,
		)
		check(
			'时长维度真的起作用（不是恒为 0）',
			results.filter((x: any) => x.durationScore > 0).length === results.length,
			`durationScore: ${results.map((x: any) => x.durationScore.toFixed(2)).join(',')}`,
		)
		check(
			'至少一半样本能自动匹配（不需要人工确认）',
			results.filter((x: any) => x.status === 'auto').length >= 3,
			`auto ${results.filter((x: any) => x.status === 'auto').length}/6`,
		)
		check(
			'时长相符的候选被识别出来（durationScore >= 0.7）',
			results.filter((x: any) => x.durationScore >= 0.7).length >= 4,
			`${results.filter((x: any) => x.durationScore >= 0.7).length}/6`,
		)
	}
}

// ===============================================================
// C. 落库
// ===============================================================

console.log('\nC. 落库（注入假 resolver，不依赖网络）\n')

const importResult = runNode(`
	const db = require('./src/db.cjs')
	db.runMigrations()
	const { importMatched } = require('./src/track-matcher.cjs')

	// 假的 view 接口：只回 cid/作者，避免真实网络
	const resolveInfo = async (bvid) => ({
		bvid,
		cid: 1000 + bvid.length,
		title: 'B站标题 ' + bvid,
		owner: 'B站作者',
		ownerMid: '12345',
		cover: 'https://i0.hdslb.com/x.jpg',
		duration: 200,
		pages: 1,
	})

	const items = [
		{ title: '歌一', artist: '作者一', duration: 200, bvid: 'BV1extA' },
		{ title: '歌二', artist: '作者二', duration: 180, bvid: 'BV1extB' },
	]

	;(async () => {
		const first = await importMatched({
			title: '网易云歌单甲', remoteId: '3778678', cover: 'https://x/cover.jpg',
			items, resolveInfo, db,
		})
		// 第二次同样内容：应该全部跳过（幂等）
		const second = await importMatched({
			title: '网易云歌单甲', remoteId: '3778678',
			items, resolveInfo, db,
		})
		// 另一个远端 id：必须是**另一个**歌单，不能认领成同一个
		const other = await importMatched({
			title: '网易云歌单乙', remoteId: '19723756',
			items: [{ title: '歌三', artist: '作者三', duration: 100, bvid: 'BV1extC' }],
			resolveInfo, db,
		})
		// 单个 bvid 解析失败：应记入 failures 而不中断整体
		const withFailure = await importMatched({
			title: '含失败项', remoteId: '999',
			items: [
				{ title: '好的', artist: 'x', duration: 100, bvid: 'BV1extD' },
				{ title: '坏的', artist: 'x', duration: 100, bvid: 'BV1extFAIL' },
			],
			resolveInfo: async (bvid) => {
				if (bvid.includes('FAIL')) throw new Error('模拟 view 接口失败')
				return resolveInfo(bvid)
			},
			db,
		})

		console.log('__RESULT__' + JSON.stringify({
			first, second, other, withFailure,
			playlists: db.listPlaylists().map((p) => ({ id: p.id, title: p.title, count: p.item_count })),
			// 远端身份必须能从 description 的标记还原
			resolved: db.listPlaylists().map((p) => ({
				title: p.title,
				remote: db.resolveRemoteSource(p),
			})),
		}))
	})()
`)

const ir = importResult as any
check(
	'首次导入成功落库',
	ir.first?.added === 2,
	JSON.stringify({ added: ir.first?.added, skipped: ir.first?.skipped }),
)
check(
	'导入后歌单条目数正确',
	ir.first?.itemCount === 2,
	String(ir.first?.itemCount),
)
check(
	'重复导入是幂等的（全部跳过，不重复追加）',
	ir.second?.added === 0 && ir.second?.skipped === 2,
	JSON.stringify({ added: ir.second?.added, skipped: ir.second?.skipped }),
)
check(
	'不同远端 id 建成不同歌单（不互相认领）',
	ir.other?.playlistId !== ir.first?.playlistId && ir.other?.added === 1,
	`甲=${ir.first?.playlistId} 乙=${ir.other?.playlistId}`,
)
check(
	'单个失败不中断整体（其余项正常落库）',
	ir.withFailure?.added === 1 && ir.withFailure?.failures?.length === 1,
	JSON.stringify({
		added: ir.withFailure?.added,
		failures: ir.withFailure?.failures?.length,
	}),
)
check(
	'失败项带上了可读原因',
	String(ir.withFailure?.failures?.[0]?.error ?? '').includes('模拟'),
	String(ir.withFailure?.failures?.[0]?.error ?? ''),
)
check(
	'歌单出现在列表里（3 个）',
	(ir.playlists ?? []).length === 3,
	JSON.stringify(
		(ir.playlists ?? []).map((p: any) => `${p.title}(${p.count})`),
	),
)
check(
	'远端身份带 source=netease 且 remoteId 可还原',
	(ir.resolved ?? []).every((x: any) => x.remote?.source === 'netease') &&
		(ir.resolved ?? []).some((x: any) => x.remote?.remoteId === 3778678) &&
		(ir.resolved ?? []).some((x: any) => x.remote?.remoteId === 19723756),
	JSON.stringify((ir.resolved ?? []).map((x: any) => x.remote)),
)

console.log(`\n=== 结果：${passed} 通过, ${failed} 失败 ===`)
fs.rmSync(DATA_DIR, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
