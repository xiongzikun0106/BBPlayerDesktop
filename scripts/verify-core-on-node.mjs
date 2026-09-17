/* oxlint-disable no-console -- 验证脚本，以 stdout 为输出 */
/**
 * Node 侧端口 PoC：用 **纯 Node**（`node:sqlite` + 内存 KV + console 日志）
 * 驱动 `packages/core` 里的数据迁移与领域逻辑，不依赖 Electron、不依赖 RN。
 *
 * 目的：证明 `packages/core` 真的可以脱离移动端运行 —— 这是桌面端方案的前提。
 *
 * 用法（**必须用 tsx**）：
 *   pnpm exec tsx scripts/verify-core-on-node.mjs
 *
 * 不能用 `node`：core 源码是 TS，内部用无扩展名的 ESM import
 * （如 `from './errors/index'`），Node 的 ESM 解析器要求显式扩展名，会报
 * `ERR_MODULE_NOT_FOUND`。tsx 会处理。
 */
import { DatabaseSync } from 'node:sqlite'

import {
	DataMigration,
	clearLegacyMigrationKeys,
	generateUniqueTrackKey,
	getCorePorts,
	migratePlayHistory,
	migrateSortKeysV3,
	parseExternalPlaylistInfo,
	registerCorePorts,
} from '../packages/core/src/index.ts'

// ---------------------------------------------------------------
// Node 侧端口实现
// ---------------------------------------------------------------

const db = new DatabaseSync(':memory:')

const sqlite = {
	execSync: (source) => {
		db.exec(source)
	},
	runSync: (source, params) => db.prepare(source).run(...(params ?? [])),
	getFirstSync: (source, params) =>
		db.prepare(source).get(...(params ?? [])) ?? null,
	getAllSync: (source, params) => db.prepare(source).all(...(params ?? [])),
	withTransactionSync: (task) => {
		db.exec('BEGIN')
		try {
			task()
			db.exec('COMMIT')
		} catch (error) {
			db.exec('ROLLBACK')
			throw error
		}
	},
}

/** 内存 KV，模拟桌面端可以落盘到 JSON */
const kv = new Map()

const logger = {
	debug: () => {},
	info: (message) => console.log(`  [info] ${message}`),
	warn: (message) => console.log(`  [warn] ${message}`),
	error: (message, meta) =>
		console.log(`  [error] ${message}`, meta === undefined ? '' : meta),
	extend: () => logger,
}

registerCorePorts({
	logger,
	storage: {
		getString: (key) => kv.get(key),
		getBoolean: (key) => {
			const value = kv.get(key)
			return value === undefined ? undefined : value === 'true'
		},
		set: (key, value) => kv.set(key, value),
		delete: (key) => kv.delete(key),
		contains: (key) => kv.has(key),
		clearAll: () => kv.clear(),
	},
	secureStorage: {
		getItem: async (key) => kv.get(`secure:${key}`) ?? null,
		setItem: async (key, value) => kv.set(`secure:${key}`, value),
		deleteItem: async (key) => kv.delete(`secure:${key}`),
	},
	db: { client: db, sqlite, orm: null },
	http: async () => {
		throw new Error('本验证脚本不发起网络请求')
	},
})

// ---------------------------------------------------------------
// 断言工具
// ---------------------------------------------------------------

let passed = 0
let failed = 0

function check(label, condition, detail = '') {
	if (condition) {
		passed++
		console.log(`  ✅ ${label}`)
	} else {
		failed++
		console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`)
	}
}

// ---------------------------------------------------------------
// 1. 端口注册
// ---------------------------------------------------------------

console.log('\n[1] 端口注册与读取')
check('getCorePorts() 可返回已注册端口', getCorePorts().db.sqlite === sqlite)

// ---------------------------------------------------------------
// 2. DataMigration：迁移台账
// ---------------------------------------------------------------

console.log('\n[2] DataMigration 迁移台账')
const migration = new DataMigration('probe_v1', 'sort_key_migrated_v2')
check('初始状态为「未应用」', !migration.isApplied())
migration.markAsApplied()
check('标记后为「已应用」', migration.isApplied())

const ledger = sqlite.getFirstSync(
	'SELECT name FROM __bbplayer_data_migrations WHERE name = ?',
	['probe_v1'],
)
check('台账表里写入了记录', ledger?.name === 'probe_v1')

// ---------------------------------------------------------------
// 3. 真实迁移：playHistory（JSON -> 表）
// ---------------------------------------------------------------

console.log(
	'\n[3] migratePlayHistory（把 tracks.play_history JSON 搬进 play_history 表）',
)
sqlite.execSync(`
  CREATE TABLE tracks (
    id INTEGER PRIMARY KEY,
    play_history TEXT
  );
  CREATE TABLE play_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER,
    start_time INTEGER,
    duration_played INTEGER,
    completed INTEGER,
    created_at INTEGER
  );
`)
sqlite.runSync('INSERT INTO tracks (id, play_history) VALUES (?, ?)', [
	1,
	JSON.stringify([
		{ startTime: 100, durationPlayed: 60, completed: true },
		{ startTime: 200, durationPlayed: 30, completed: false },
	]),
])

migratePlayHistory()

const rows = sqlite.getAllSync(
	'SELECT track_id, start_time, completed FROM play_history ORDER BY start_time',
)
check('迁移出 2 条播放记录', rows.length === 2, `实际 ${rows.length}`)
check('内容正确', rows[0]?.start_time === 100 && rows[1]?.completed === 0)

// ---------------------------------------------------------------
// 4. 真实迁移：sortKeysV3（翻转 sort_key）
// ---------------------------------------------------------------

console.log('\n[4] migrateSortKeysV3（非 local 播放列表 sort_key 翻转）')
sqlite.execSync(`
  CREATE TABLE playlists (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL
  );
  CREATE TABLE playlist_tracks (
    playlist_id INTEGER,
    track_id INTEGER,
    sort_key TEXT
  );
`)
sqlite.runSync(`INSERT INTO playlists (id, type) VALUES (1, 'favorite')`)
for (const [index, trackId] of [10, 20, 30].entries()) {
	sqlite.runSync(
		'INSERT INTO playlist_tracks (playlist_id, track_id, sort_key) VALUES (?, ?, ?)',
		[1, trackId, `a${index}`],
	)
}

migrateSortKeysV3()

const after = sqlite.getAllSync(
	'SELECT track_id, sort_key FROM playlist_tracks ORDER BY sort_key',
)
check(
	'3 行都被重新分配 sort_key',
	after.every((row) => Boolean(row.sort_key)),
)
check(
	'顺序被翻转（原 10,20,30 → 现 30,20,10）',
	after.map((row) => row.track_id).join(',') === '30,20,10',
	`实际 ${after.map((row) => row.track_id).join(',')}`,
)
check(
	'与「已应用」标记一致（第二次调用应跳过）',
	sqlite.getFirstSync(
		'SELECT name FROM __bbplayer_data_migrations WHERE name = ?',
		['sort_key_v3'],
	)?.name === 'sort_key_v3',
)

// ---------------------------------------------------------------
// 5. 领域逻辑：纯函数（无端口依赖）
// ---------------------------------------------------------------

console.log('\n[5] 领域逻辑（纯函数）')

const key = generateUniqueTrackKey({
	source: 'bilibili',
	bilibiliMetadata: {
		bvid: 'BV1xx411c7mD',
		isMultiPage: false,
		videoIsValid: true,
	},
})
check(
	'generateUniqueTrackKey 产出 bilibili::<bvid>',
	key.isOk() && key.value === 'bilibili::BV1xx411c7mD',
	key.isOk() ? key.value : 'err',
)

const parsed = parseExternalPlaylistInfo(
	'https://music.163.com/playlist?id=12345',
)
check(
	'parseExternalPlaylistInfo 解析网易云',
	parsed?.id === '12345' && parsed.source === 'netease',
)

// 注意：该解析器要求 `id=` 查询参数（见 packages/core/src/utils/playlistUrlParser.ts），
// 路径形式的 QQ 音乐链接（/n/ryqq/playlist/98765）不在它支持范围内。
const qq = parseExternalPlaylistInfo(
	'https://y.qq.com/n/ryqq/playlist?id=98765',
)
check(
	'parseExternalPlaylistInfo 解析 QQ 音乐',
	qq?.id === '98765' && qq.source === 'qq',
)

// ---------------------------------------------------------------
// 6. 遗留标记清理
// ---------------------------------------------------------------

console.log('\n[6] clearLegacyMigrationKeys（清理 MMKV 遗留标记）')
kv.set('sort_key_migrated_v2', 'true')
kv.set('play_history_migrated_v1', 'true')
clearLegacyMigrationKeys()
check(
	'遗留标记已清空',
	!kv.has('sort_key_migrated_v2') && !kv.has('play_history_migrated_v1'),
)

// ---------------------------------------------------------------
// 结果
// ---------------------------------------------------------------

console.log(`\n${'='.repeat(50)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
console.log('='.repeat(50))
process.exit(failed === 0 ? 0 : 1)
