/* oxlint-disable no-console -- 验证脚本，以 stdout 输出 */
/**
 * 跨端「歌单顺序」互通验收。
 *
 * ## 为什么需要这个脚本
 *
 * 移动端与桌面端的 `playlist_tracks.sort_key` 一度**取值方向相反**：
 *
 * | | 生成 | 读取 |
 * | --- | --- | --- |
 * | 移动端 `playlistService.ts` | fractional-indexing，**越靠前键越大** | `ORDER BY sort_key DESC` |
 * | 桌面端 `db.cjs`（修复前） | `` `a${index 补零}` ``，**越靠前键越小** | `ORDER BY sort_key ASC` |
 *
 * 两端各自自洽，因此**单端跑起来完全看不出问题** —— 但备份是「整个 SQLite
 * 文件搬家」，移动端拿到桌面端的库后会用自己的规则（DESC）去读，于是
 * **顺序整体倒过来**。
 *
 * 更隐蔽的是移动端的 `sortKeysV3` 数据迁移**只翻转 `type != 'local'` 的歌单**
 * （因为移动端自己的 local 歌单从一开始就是 fractional 约定）。所以桌面端的
 * 「导入的收藏夹/合集」在导出时会被 `v3` 翻转成对的，而**桌面端自己新建的
 * local 歌单不会被翻转** —— 恰好是最常见的那一类歌单倒序。
 *
 * ## 这个脚本怎么验
 *
 * 1. 桌面端侧**调用真实实现**（`db.getPlaylistTracks`），不重写它的 SQL ——
 *    否则脚本会永远自洽，测不出实现的变化。
 * 2. 移动端侧按移动端的规则读（`ORDER BY sort_key DESC`）。
 * 3. 两边读出的顺序必须一致，并且都等于「加入顺序」。
 * 4. 直接调用 core 的 `migrateSortKeysV3`，确认它**什么也不做** ——
 *    桌面端已经把该不变式建立起来了，导出时再翻一次会把正确的数据翻坏。
 *
 * 用法：pnpm exec tsx scripts/verify-sortkey-interop.mts
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')
const DATA_DIR = path.join(os.tmpdir(), `bbplayer-sortkey-${Date.now()}`)
fs.mkdirSync(DATA_DIR, { recursive: true })
process.env.BBPLAYER_DATA_DIR = DATA_DIR

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

function runNode(script: string): any {
	const output = execFileSync(process.execPath, ['-e', script], {
		cwd: DESKTOP,
		encoding: 'utf8',
		env: { ...process.env, BBPLAYER_DATA_DIR: DATA_DIR },
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	const marker = output.lastIndexOf('__RESULT__')
	if (marker === -1) throw new Error(`子进程未返回结果:\n${output}`)
	return JSON.parse(output.slice(marker + '__RESULT__'.length).trim())
}

/**
 * 桌面端的顺序：**走真实实现** `db.getPlaylistTracks`。
 *
 * 刻意不在这里重写它的 `ORDER BY` —— 脚本自己实现一遍读法的话，
 * 实现改成什么样脚本都自洽，等于什么都没测。
 */
function readAsDesktop(playlistId: number): number[] {
	return runNode(`
		const db = require('./src/db.cjs')
		const rows = db.getPlaylistTracks(${playlistId})
		console.log('__RESULT__' + JSON.stringify(rows.map(r => r.id)))
	`)
}

/** 移动端的顺序：`ORDER BY sort_key DESC`（`playlistService.ts` 的多处 select） */
function readAsMobile(playlistId: number): number[] {
	return runNode(`
		const { sqlite } = require('./src/ports.cjs')
		const rows = sqlite.getAllSync(
			'SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY sort_key DESC',
			[${playlistId}]
		)
		console.log('__RESULT__' + JSON.stringify(rows.map(r => r.track_id)))
	`)
}

console.log('=== 跨端歌单顺序互通验收 ===\n')
console.log(`数据目录：${DATA_DIR}\n`)

// ===============================================================
// 1. 建库 + 两类歌单 + 各加 3 首
// ===============================================================

console.log('1. 桌面端建库、建歌单、加曲目\n')

const built = runNode(`
	const db = require('./src/db.cjs')
	const { sqlite } = require('./src/ports.cjs')
	db.runMigrations()

	// local 歌单 + non-local（模拟导入的收藏夹）歌单
	const localId = db.createPlaylist({ title: '桌面本地歌单', type: 'local' }).id
	const remoteId = db.createPlaylist({ title: '导入的收藏夹', type: 'favorites' }).id

	const trackIds = []
	for (const bvid of ['BV1a', 'BV1b', 'BV1c']) {
		const t = db.upsertTrack({
			uniqueKey: 'bilibili::' + bvid,
			title: '曲目 ' + bvid,
			artistName: '测试 UP',
			coverUrl: null,
			duration: 100,
			bvid,
		})
		trackIds.push(t.id)
	}

	// 按「a, b, c」的顺序加进去
	for (const id of trackIds) {
		db.addTrackToPlaylist(localId, id)
		db.addTrackToPlaylist(remoteId, id)
	}

	const raw = sqlite.getAllSync(
		'SELECT playlist_id, track_id, sort_key FROM playlist_tracks ORDER BY playlist_id, sort_key'
	)
	console.log('__RESULT__' + JSON.stringify({ localId, remoteId, trackIds, raw }))
`)

console.log(
	`   local 歌单 id=${built.localId}，non-local 歌单 id=${built.remoteId}`,
)
console.log(
	`   落库的 sort_key（按 ASC 打印）：${built.raw.map((r: any) => r.sort_key).join(', ')}\n`,
)

// ===============================================================
// 2. 对拍：两端读出的顺序必须一致
// ===============================================================

console.log('2. 两端读法对拍\n')

const [t0, t1, t2] = built.trackIds
const expected = [t0, t1, t2]

const localDesktop = readAsDesktop(built.localId)
const localMobile = readAsMobile(built.localId)

check(
	'local：桌面端实际实现读出的顺序 = 加入顺序',
	JSON.stringify(localDesktop) === JSON.stringify(expected),
	JSON.stringify(localDesktop),
)
check(
	'local：移动端读法读出的顺序与桌面端一致（否则备份恢复后整单倒序）',
	JSON.stringify(localMobile) === JSON.stringify(localDesktop),
	`桌面=${JSON.stringify(localDesktop)} 移动=${JSON.stringify(localMobile)}`,
)

const remoteDesktop = readAsDesktop(built.remoteId)
const remoteMobile = readAsMobile(built.remoteId)

check(
	'non-local：桌面端实际实现读出的顺序 = 加入顺序',
	JSON.stringify(remoteDesktop) === JSON.stringify(expected),
	JSON.stringify(remoteDesktop),
)
check(
	'non-local：移动端读法读出的顺序与桌面端一致',
	JSON.stringify(remoteMobile) === JSON.stringify(remoteDesktop),
	`桌面=${JSON.stringify(remoteDesktop)} 移动=${JSON.stringify(remoteMobile)}`,
)

// ===============================================================
// 3. 键的取值方向本身
// ===============================================================

console.log('\n3. sort_key 取值方向（越大越靠前）\n')

const direction = runNode(`
	const { sqlite } = require('./src/ports.cjs')
	const rows = sqlite.getAllSync(
		'SELECT track_id, sort_key FROM playlist_tracks WHERE playlist_id = ? ORDER BY sort_key DESC',
		[${built.localId}]
	)
	const keys = rows.map(r => r.sort_key)
	console.log('__RESULT__' + JSON.stringify({
		keys,
		descending: keys.every((k, i) => i === 0 || keys[i - 1] > k),
		fractional: keys.every(k => /^[A-Za-z0-9]+$/.test(k) && !/^a\\d{6}$/.test(k)),
	}))
`)

check(
	'sort_key 按字典序**降序**排列（DESC 读出的就是显示顺序）',
	direction.descending === true,
	direction.keys.join(' > '),
)
check(
	'不再是旧版 `a000000` 形状的键（已迁移到 fractional-indexing）',
	direction.fractional === true,
	direction.keys.join(', '),
)

// ===============================================================
// 4. core 的 sortKeysV3 必须变成 no-op
// ===============================================================

console.log('\n4. 导出备份时 core 的 sortKeysV3 不得再翻转\n')

const v3 = runNode(`
	const { core, sqlite } = require('./src/ports.cjs')

	const before = sqlite.getAllSync(
		'SELECT playlist_id, track_id, sort_key FROM playlist_tracks ORDER BY playlist_id, track_id'
	)
	const ledgerBefore = sqlite.getAllSync(
		'SELECT name FROM __bbplayer_data_migrations ORDER BY name'
	).map(r => r.name)

	// backup.cjs 在导出副本上就是这么调的
	core.migrateSortKeysV3()

	const after = sqlite.getAllSync(
		'SELECT playlist_id, track_id, sort_key FROM playlist_tracks ORDER BY playlist_id, track_id'
	)
	console.log('__RESULT__' + JSON.stringify({
		ledger: ledgerBefore,
		changed: JSON.stringify(before) !== JSON.stringify(after),
	}))
`)

check(
	'记账表里 sort_key_v3 已标记完成（导出时迁移会直接 return）',
	v3.ledger.includes('sort_key_v3'),
	v3.ledger.join(', '),
)
check(
	'记账表里 sort_key_desktop_v1 已标记完成',
	v3.ledger.includes('sort_key_desktop_v1'),
	v3.ledger.join(', '),
)
check('调用 migrateSortKeysV3 之后一行都没变', v3.changed === false)

check(
	'调用 v3 之后移动端读法仍然正确',
	JSON.stringify(readAsMobile(built.remoteId)) === JSON.stringify(expected),
	JSON.stringify(readAsMobile(built.remoteId)),
)

// ===============================================================
// 5. 追加一首，检查落在末尾且两端一致
// ===============================================================

console.log('\n5. 追加曲目后的顺序\n')

const appended = runNode(`
	const db = require('./src/db.cjs')
	const track = db.upsertTrack({
		uniqueKey: 'bilibili::BV1d',
		title: '曲目 BV1d',
		artistName: '测试 UP',
		coverUrl: null,
		duration: 100,
		bvid: 'BV1d',
	})
	db.addTrackToPlaylist(${built.localId}, track.id)
	console.log('__RESULT__' + JSON.stringify({ trackId: track.id }))
`)

const appendedDesktop = readAsDesktop(built.localId)
const appendedMobile = readAsMobile(built.localId)
const expectedAfterAppend = [t0, t1, t2, appended.trackId]

check(
	'新加的曲目落在**末尾**（保留旧版「追加到末尾」的用户可见行为）',
	JSON.stringify(appendedDesktop) === JSON.stringify(expectedAfterAppend),
	JSON.stringify(appendedDesktop),
)
check(
	'追加后移动端读法读出的顺序与桌面端一致',
	JSON.stringify(appendedMobile) === JSON.stringify(appendedDesktop),
	`桌面=${JSON.stringify(appendedDesktop)} 移动=${JSON.stringify(appendedMobile)}`,
)

// ===============================================================
// 6. 旧库升级：模拟「已有 `a000000` 键的桌面库」
// ===============================================================

console.log('\n6. 旧版桌面库升级路径\n')

const upgradeDir = path.join(
	os.tmpdir(),
	`bbplayer-sortkey-legacy-${Date.now()}`,
)
fs.mkdirSync(upgradeDir, { recursive: true })

/** 在一个全新的数据目录里跑一段脚本（用它模拟「老用户的库」） */
function runNodeIn(dir: string, script: string): any {
	const output = execFileSync(process.execPath, ['-e', script], {
		cwd: DESKTOP,
		encoding: 'utf8',
		env: { ...process.env, BBPLAYER_DATA_DIR: dir },
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	const marker = output.lastIndexOf('__RESULT__')
	if (marker === -1) throw new Error(`子进程未返回结果:\n${output}`)
	return JSON.parse(output.slice(marker + '__RESULT__'.length).trim())
}

const upgraded = runNodeIn(
	upgradeDir,
	`
	const db = require('./src/db.cjs')
	const { sqlite } = require('./src/ports.cjs')
	db.runMigrations()

	const playlistId = db.createPlaylist({ title: '老歌单', type: 'local' }).id
	const trackIds = []
	for (const bvid of ['BV1a', 'BV1b', 'BV1c', 'BV1d']) {
		const t = db.upsertTrack({
			uniqueKey: 'bilibili::' + bvid,
			title: '曲目 ' + bvid,
			artistName: '测试 UP',
			coverUrl: null,
			duration: 100,
			bvid,
		})
		trackIds.push(t.id)
		db.addTrackToPlaylist(playlistId, t.id)
	}

	// 手工改回**旧版桌面端**的键形状与方向：越小越靠前
	trackIds.forEach((id, i) => {
		sqlite.runSync(
			'UPDATE playlist_tracks SET sort_key = ? WHERE playlist_id = ? AND track_id = ?',
			['a' + String(i).padStart(6, '0'), playlistId, id]
		)
	})
	// 把这次迁移的记账抹掉，模拟「升级前就已经存在的库」
	sqlite.runSync("DELETE FROM __bbplayer_data_migrations WHERE name = 'sort_key_desktop_v1'")
	sqlite.runSync("DELETE FROM __bbplayer_data_migrations WHERE name = 'sort_key_v3'")

	const beforeOrder = sqlite.getAllSync(
		'SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY sort_key ASC',
		[playlistId]
	).map(r => r.track_id)

	console.log('__RESULT__' + JSON.stringify({ playlistId, trackIds, beforeOrder }))
`,
)

console.log(
	`   旧库存量顺序（旧版按 ASC 显示）：${JSON.stringify(upgraded.beforeOrder)}`,
)

runNodeIn(
	upgradeDir,
	`
	const db = require('./src/db.cjs')
	db.runMigrations()
	console.log('__RESULT__' + JSON.stringify({ ok: true }))
`,
)

const afterDesktop = runNodeIn(
	upgradeDir,
	`
	const db = require('./src/db.cjs')
	console.log('__RESULT__' + JSON.stringify(db.getPlaylistTracks(${upgraded.playlistId}).map(r => r.id)))
`,
)
const afterMobile = runNodeIn(
	upgradeDir,
	`
	const { sqlite } = require('./src/ports.cjs')
	const rows = sqlite.getAllSync(
		'SELECT track_id, sort_key FROM playlist_tracks WHERE playlist_id = ? ORDER BY sort_key DESC',
		[${upgraded.playlistId}]
	)
	console.log('__RESULT__' + JSON.stringify({
		order: rows.map(r => r.track_id),
		legacyLeft: rows.filter(r => /^a\\d{6}$/.test(r.sort_key)).length,
	}))
`,
)

check(
	'升级后桌面端显示顺序与升级前一致（不因迁移而倒序）',
	JSON.stringify(afterDesktop) === JSON.stringify(upgraded.beforeOrder),
	`升级前=${JSON.stringify(upgraded.beforeOrder)} 升级后=${JSON.stringify(afterDesktop)}`,
)
check(
	'升级后移动端读法读出的顺序也一致',
	JSON.stringify(afterMobile.order) === JSON.stringify(upgraded.beforeOrder),
	`移动端=${JSON.stringify(afterMobile.order)}`,
)
check('旧形状的键已被全部重写', afterMobile.legacyLeft === 0)

// ===============================================================
// 7. fractional 键可以插到任意两项之间
// ===============================================================

console.log('\n7. fractional 键的可插入性（未来拖拽排序的前提）\n')

const between = runNode(`
	const { sqlite, core } = require('./src/ports.cjs')
	const rows = sqlite.getAllSync(
		'SELECT sort_key FROM playlist_tracks WHERE playlist_id = ? ORDER BY sort_key DESC',
		[${built.localId}]
	)
	const keys = rows.map(r => r.sort_key)
	const mid = core.generateKeyBetweenPositions(keys[1], keys[0])
	console.log('__RESULT__' + JSON.stringify({ keys, mid, ok: mid > keys[1] && mid < keys[0] }))
`)

check(
	'能在相邻两项之间生成严格夹在中间的键',
	between.ok === true,
	`${between.keys[0]} > ${between.mid} > ${between.keys[1]}`,
)

// ===============================================================

console.log(
	`\n========================================================\n通过 ${passed} 项，失败 ${failed} 项\n========================================================`,
)
process.exit(failed === 0 ? 0 : 1)
