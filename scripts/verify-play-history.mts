/* oxlint-disable no-console -- 验证脚本，以 stdout 输出 */
/**
 * Phase 3.5 验收：**播放历史**。
 *
 * `play_history` 是共用 schema 里的表，但桌面端此前**只建表、从不写入**
 * （移动端的 `playHistory.ts` 也查不到调用点）。本脚本验证它真的被接上了：
 *
 *  1. SQL 层：会话开始/更新/聚合（最近播放、最常播放、继续收听、单曲统计、汇总）
 *  2. 「有效播放」阈值确实生效（≥30 秒才算一次，否则误触会冲乱排行）
 *  3. 「继续收听」的边界：听完的不出现、太短的（<10s）不出现、只有最后一次会话算数
 *  4. 外键约束：不存在的 track_id 必须被拒（历史表有 FK）
 *  5. 清空只删历史，不动曲目与歌单
 *
 * 用法：pnpm exec tsx scripts/verify-play-history.mts
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')

const DATA_DIR = path.join(os.tmpdir(), `bbplayer-history-${Date.now()}`)
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
		timeout: 120_000,
	})
	const marker = output.lastIndexOf('__RESULT__')
	if (marker === -1) throw new Error(`子进程未返回结果:\n${output}`)
	return JSON.parse(output.slice(marker + '__RESULT__'.length).trim())
}

console.log('=== Phase 3.5 验收：播放历史 ===\n')
console.log(`数据目录：${DATA_DIR}\n`)

// ===============================================================
// 1. 建库 + 造数据 + 会话生命周期
// ===============================================================

console.log('1. 会话生命周期与聚合\n')

const result = runNode(`
	const db = require('./src/db.cjs')
	db.runMigrations()

	// 两首曲目：一首 200 秒，一首 60 秒
	const mk = (suffix, duration) =>
		db.upsertTrack({
			uniqueKey: 'bilibili::BV1hist' + suffix,
			title: '历史' + suffix,
			artistName: '作者',
			artistRemoteId: null,
			coverUrl: null,
			duration,
			bvid: 'BV1hist' + suffix,
			cid: 1,
			isMultiPage: false,
		})
	const a = mk('A', 200)
	const b = mk('B', 60)

	const now = Date.now()

	// A：三次会话
	//   1) 5 分钟前，听完
	const a1 = db.startPlaySession(a.id, now - 300000)
	db.updatePlaySession(a1, 200, true)
	//   2) 100 秒前，听了 60 秒（有效播放，但没听完）
	const a2 = db.startPlaySession(a.id, now - 100000)
	db.updatePlaySession(a2, 60, false)
	//   3) 50 秒前，误触（3 秒）
	const a3 = db.startPlaySession(a.id, now - 50000)
	db.updatePlaySession(a3, 3, false)

	// B：一次会话，听了 20 秒（< 30 秒阈值，不算有效播放；但 > 10 秒，应进「继续收听」）
	const b1 = db.startPlaySession(b.id, now - 20000)
	db.updatePlaySession(b1, 20, false)

	// duration_played 应取 MAX，而不是累加/覆盖成更小的值
	db.updatePlaySession(a2, 10, false)

	console.log('__RESULT__' + JSON.stringify({
		aId: a.id,
		bId: b.id,
		sessions: { a1, a2, a3, b1 },
		recent: db.listRecentlyPlayed().map((r) => ({
			title: r.title,
			playCount: Number(r.play_count),
			everCompleted: Boolean(r.ever_completed),
			lastPlayedAt: r.last_played_at,
		})),
		mostPlayed: db.listMostPlayed().map((r) => ({
			title: r.title,
			playCount: Number(r.play_count),
			totalSeconds: Number(r.total_played_seconds),
		})),
		resume: db.listResumeCandidates().map((r) => ({
			title: r.title,
			position: Number(r.last_position_seconds),
		})),
		statsA: db.getTrackPlayStats(a.id),
		summary: db.getPlayHistorySummary(),
		// 没播放过的曲目统计应为零
		statsUnknown: db.getTrackPlayStats(999999),
	}))
`)

const r = result

check(
	'为每首歌建立了独立会话',
	r.sessions?.a1 > 0 &&
		r.sessions?.a2 > 0 &&
		r.sessions?.a3 > 0 &&
		r.sessions?.b1 > 0,
	JSON.stringify(r.sessions),
)
check(
	'会话 id 互不相同',
	new Set([r.sessions?.a1, r.sessions?.a2, r.sessions?.a3, r.sessions?.b1])
		.size === 4,
)

check(
	'最近播放按每首歌去重（2 首）',
	r.recent?.length === 2,
	JSON.stringify(r.recent?.map((x) => x.title)),
)
check(
	'最近播放带上会话次数（A 播了 3 次）',
	r.recent?.find((x) => x.title === '历史A')?.playCount === 3,
	JSON.stringify(r.recent?.find((x) => x.title === '历史A')),
)
check(
	'最近播放按最后一次播的时间排序（B 更近，应在前）',
	r.recent?.[0]?.title === '历史B',
	JSON.stringify(r.recent?.map((x) => x.title)),
)
check(
	'ever_completed 反映「曾经听完」',
	r.recent?.find((x) => x.title === '历史A')?.everCompleted === true,
)

check(
	'最常播放只统计有效播放（≥30 秒）：A 的两条会话计入、3 秒那条不计',
	r.mostPlayed?.find((x) => x.title === '历史A')?.playCount === 2,
	JSON.stringify(r.mostPlayed),
)
check(
	'最常播放排除 B（只听了 20 秒，未达 30 秒阈值）',
	!r.mostPlayed?.some((x) => x.title === '历史B'),
	JSON.stringify(r.mostPlayed?.map((x) => x.title)),
)
check(
	'最常播放累计已播秒数正确（200 + 60）',
	r.mostPlayed?.find((x) => x.title === '历史A')?.totalSeconds === 260,
	JSON.stringify(r.mostPlayed),
)

check(
	'继续收听只包含未听完且够长的曲目',
	r.resume?.length === 1 && r.resume?.[0]?.title === '历史B',
	JSON.stringify(r.resume),
)
check(
	'继续收听带上上次听到的位置（20 秒）',
	r.resume?.[0]?.position === 20,
	String(r.resume?.[0]?.position),
)

check(
	'duration_played 取最大值（重复上报更小的值不会把它改小）',
	r.statsA?.totalPlayedSeconds === 263,
	`总 ${r.statsA?.totalPlayedSeconds} 秒（200 + 60 + 3）`,
)
check(
	'单曲统计的会话数正确',
	r.statsA?.playCount === 3,
	String(r.statsA?.playCount),
)
check('单曲统计的 everCompleted 正确', r.statsA?.everCompleted === true)

check(
	'汇总：4 次会话 / 2 首曲目',
	r.summary?.sessionCount === 4 && r.summary?.trackCount === 2,
	JSON.stringify(r.summary),
)
check(
	'汇总的累计秒数正确（263 + 20）',
	r.summary?.totalSeconds === 283,
	String(r.summary?.totalSeconds),
)
check(
	'汇总带上首次/最后播放时间',
	typeof r.summary?.firstPlayedAt === 'number' &&
		typeof r.summary?.lastPlayedAt === 'number',
	`${r.summary?.firstPlayedAt} → ${r.summary?.lastPlayedAt}`,
)

check(
	'未播放过的曲目统计为零值而不是报错',
	r.statsUnknown?.playCount === 0 &&
		r.statsUnknown?.lastPlayedAt === null &&
		r.statsUnknown?.everCompleted === false,
	JSON.stringify(r.statsUnknown),
)

// ===============================================================
// 2. 边界：继续收听的条件
// ===============================================================

console.log('\n2. 「继续收听」的边界条件\n')

const boundaries = runNode(`
	const db = require('./src/db.cjs')
	// 复用上一段建的库（同一个 BBPLAYER_DATA_DIR）
	const mk = (suffix, duration) => {
		const existing = db.findTrackIdByBvid('BV1edge' + suffix)
		if (existing) return { id: existing }
		return db.upsertTrack({
			uniqueKey: 'bilibili::BV1edge' + suffix,
			title: '边界' + suffix,
			artistName: '作者',
			artistRemoteId: null,
			coverUrl: null,
			duration,
			bvid: 'BV1edge' + suffix,
			cid: 1,
			isMultiPage: false,
		})
	}

	const now = Date.now()
	const out = {}

	// 1) 听完的（completed = 1）不该出现
	const done = mk('DONE', 100)
	const s1 = db.startPlaySession(done.id, now - 1000)
	db.updatePlaySession(s1, 100, true)

	// 2) 太短的（< 10 秒）不该出现
	const tiny = mk('TINY', 300)
	const s2 = db.startPlaySession(tiny.id, now - 900)
	db.updatePlaySession(s2, 5, false)

	// 3) 已播到接近结尾的（剩余 < 15 秒）不该出现 —— 视为听完了
	const almost = mk('ALMOST', 100)
	const s3 = db.startPlaySession(almost.id, now - 800)
	db.updatePlaySession(s3, 95, false)

	// 4) 中途听到一半的，应该出现
	const middle = mk('MIDDLE', 200)
	const s4 = db.startPlaySession(middle.id, now - 700)
	db.updatePlaySession(s4, 80, false)

	// 5) 同一首歌多次会话：只有**最后一次**算数
	const multi = mk('MULTI', 200)
	const m1 = db.startPlaySession(multi.id, now - 600)
	db.updatePlaySession(m1, 150, false)   // 早期会话听到 150
	const m2 = db.startPlaySession(multi.id, now - 500)
	db.updatePlaySession(m2, 30, false)    // 最后一次只听到 30

	const resume = db.listResumeCandidates()
	out.titles = resume.map((x) => x.title)
	out.multiPosition = resume.find((x) => x.title === '边界MULTI')?.last_position_seconds ?? null
	out.donePresent = resume.some((x) => x.title === '边界DONE')
	out.tinyPresent = resume.some((x) => x.title === '边界TINY')
	out.almostPresent = resume.some((x) => x.title === '边界ALMOST')
	out.middlePresent = resume.some((x) => x.title === '边界MIDDLE')

	console.log('__RESULT__' + JSON.stringify(out))
`)

const b = boundaries
check(
	'听完的曲目不出现在「继续收听」',
	b.donePresent === false,
	JSON.stringify(b.titles),
)
check('只听了 5 秒的不出现（低于 10 秒阈值）', b.tinyPresent === false)
check(
	'听到 95/100 秒的不出现（剩余不足 15 秒，视为听完）',
	b.almostPresent === false,
)
check('听到 80/200 秒的出现', b.middlePresent === true)
check(
	'同一首歌多次会话时只有最后一次算数（30 秒而不是 150 秒）',
	b.multiPosition === 30,
	`位置 ${b.multiPosition}`,
)

// ===============================================================
// 3. 外键约束与清空语义
// ===============================================================

console.log('\n3. 外键约束与清空语义\n')

const integrity = runNode(`
	const db = require('./src/db.cjs')

	// ⚠️ 必须先真的建一个歌单。第一版这里没建，于是「清空不动歌单」断言的是
	// 0 === 0 —— 一个永远成立的弱断言，什么都没验证到。
	// （注意：本段代码在外层模板字面量里，注释中不能出现反引号。）
	const playlist = db.createPlaylist({ title: '历史测试歌单', type: 'local' })
	const trackId = db.findTrackIdByBvid('BV1histA')
	db.addTrackToPlaylist(playlist.id, trackId, 0)

	const before = db.getPlayHistorySummary()
	const playlistsBefore = db.listPlaylists()
	const tracksBefore = db.getPlaylistTracks(playlist.id).length

	const out = {}

	// 1) 不存在的 track_id 必须被外键拒绝
	try {
		db.startPlaySession(999999)
		out.badTrackAccepted = true
	} catch (error) {
		out.badTrackAccepted = false
		out.badTrackError = error.message
	}

	// 2) 清空只删历史
	out.removed = db.clearPlayHistory()
	out.afterClear = db.getPlayHistorySummary()
	out.playlistsBefore = playlistsBefore.length
	out.playlistsAfter = db.listPlaylists().length
	out.playlistTitleAfter = db.listPlaylists()[0]?.title ?? null
	out.tracksBefore = tracksBefore
	out.tracksAfter = db.getPlaylistTracks(playlist.id).length

	// 3) 清空后各视图都应为空
	out.recentEmpty = db.listRecentlyPlayed().length === 0
	out.mostEmpty = db.listMostPlayed().length === 0
	out.resumeEmpty = db.listResumeCandidates().length === 0

	// 4) 更新一个不存在的会话 id 不该抛（幂等）
	try {
		db.updatePlaySession(0, 10, false)
		db.updatePlaySession(999999, 10, false)
		out.updateUnknownOk = true
	} catch (error) {
		out.updateUnknownOk = false
		out.updateUnknownError = error.message
	}

	out.beforeSessions = before.sessionCount

	console.log('__RESULT__' + JSON.stringify(out))
`)

const i = integrity
check(
	'不存在的 track_id 被外键拒绝',
	i.badTrackAccepted === false,
	String(i.badTrackError).slice(0, 80),
)
check(
	'清空删除了全部会话',
	i.removed === i.beforeSessions,
	`删了 ${i.removed} 条（原有 ${i.beforeSessions}）`,
)
check(
	'清空后汇总归零',
	i.afterClear?.sessionCount === 0 &&
		i.afterClear?.trackCount === 0 &&
		i.afterClear?.totalSeconds === 0,
	JSON.stringify(i.afterClear),
)
check(
	'清空后三个视图都为空',
	i.recentEmpty === true && i.mostEmpty === true && i.resumeEmpty === true,
	JSON.stringify({
		recent: i.recentEmpty,
		most: i.mostEmpty,
		resume: i.resumeEmpty,
	}),
)
// 这一组断言在「清空前确实有歌单和曲目」的前提下才有意义
check(
	'清空前确实有歌单可验证（避免弱断言）',
	i.playlistsBefore === 1 && i.tracksBefore === 1,
	`清空前 ${i.playlistsBefore} 个歌单 / ${i.tracksBefore} 首曲目`,
)
check(
	'清空**不动**歌单',
	i.playlistsAfter === i.playlistsBefore &&
		i.playlistTitleAfter === '历史测试歌单',
	`${i.playlistsBefore} → ${i.playlistsAfter}（${i.playlistTitleAfter}）`,
)
check(
	'清空**不动**歌单里的曲目',
	i.tracksAfter === i.tracksBefore,
	`${i.tracksBefore} → ${i.tracksAfter} 首`,
)
check(
	'更新不存在的会话 id 不抛错（幂等）',
	i.updateUnknownOk === true,
	String(i.updateUnknownError ?? ''),
)

// ===============================================================
// 4. bvid <-> track_id 映射
// ===============================================================

console.log('\n4. bvid 到 track_id 的映射\n')

const mapping = runNode(`
	const db = require('./src/db.cjs')
	console.log('__RESULT__' + JSON.stringify({
		known: db.findTrackIdByBvid('BV1histA'),
		unknown: db.findTrackIdByBvid('BV1notexist'),
		empty: db.findTrackIdByBvid(''),
		nullArg: db.findTrackIdByBvid(null),
	}))
`)

const m = mapping
check(
	'能找到已落库曲目的 id',
	typeof m.known === 'number' && m.known > 0,
	String(m.known),
)
check(
	'未知 bvid 返回 null（而不是抛错）',
	m.unknown === null,
	String(m.unknown),
)
check('空串返回 null', m.empty === null)
check('null 参数返回 null', m.nullArg === null)

console.log(`\n=== 结果：${passed} 通过, ${failed} 失败 ===`)
fs.rmSync(DATA_DIR, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
