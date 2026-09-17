/* oxlint-disable no-console -- 验证脚本，以 stdout 输出 */
/**
 * Phase 4 验收：备份 / 恢复，**重点是与移动端格式互通**。
 *
 * ## 为什么这个脚本要费劲做交叉验证
 *
 * 备份是最不能「看起来对就行」的功能 —— 格式错了会**静默毁数据**。
 * 仓库里没有任何 `.bbplayer` 样例文件，也没有任何往返测试，
 * 所以单靠读源码得出的结论必须被实测钉住。因此这里做三件额外的事：
 *
 *  1. **用移动端真正用的库（JSZip 3.10.1）读我们产出的 ZIP** ——
 *     自己写的 ZIP 被自己读通不算证据，必须是**对方**的库能读。
 *  2. **两个方向都验证迁移表规范化** —— 调研发现
 *     `__drizzle_migrations` 两端结构不同，且 `VACUUM INTO` 会把它
 *     一起带进快照。这是双向都会炸的陷阱，必须两边都断言。
 *  3. **断言文件名匹配移动端的列表规则** `/^backup-.+\.bbplayer$/` ——
 *     否则移动端根本列不出桌面传上去的备份。
 *
 * 用法：pnpm exec tsx scripts/verify-backup.mts（用 tsx 以便加载 core）
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')

/** 移动端真正使用的 ZIP 库；用它交叉验证我们的输出 */
const JSZIP_DIR = (() => {
	const pnpm = path.join(ROOT, 'node_modules', '.pnpm')
	const match = fs.readdirSync(pnpm).find((name) => name.startsWith('jszip@'))
	if (!match) return null
	return path.join(pnpm, match, 'node_modules', 'jszip')
})()

const DATA_DIR = path.join(os.tmpdir(), `bbplayer-backup-${Date.now()}`)
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

function runNode(script: string, timeoutMs = 120_000): unknown {
	const output = execFileSync(process.execPath, ['-e', script], {
		cwd: DESKTOP,
		encoding: 'utf8',
		env: { ...process.env, BBPLAYER_DATA_DIR: DATA_DIR },
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: timeoutMs,
	})
	const marker = output.lastIndexOf('__RESULT__')
	if (marker === -1) throw new Error(`子进程未返回结果:\n${output}`)
	return JSON.parse(output.slice(marker + '__RESULT__'.length).trim()) as never
}

console.log('=== Phase 4 验收：备份 / 恢复（移动端互通）===\n')
console.log(`数据目录：${DATA_DIR}`)
console.log(`JSZip（移动端用的库）：${JSZIP_DIR ?? '未找到'}\n`)

// ===============================================================
// 1. 建库 + 造数据
// ===============================================================

console.log('1. 建库并写入真实数据\n')

const DB_FILE = path.join(DATA_DIR, 'bbplayer.db')

const seed = runNode(`
	const db = require('./src/db.cjs')
	const migration = db.runMigrations()
	const dbFile = ${JSON.stringify(DB_FILE)}

	const playlist = db.createPlaylist({ title: '备份测试歌单', type: 'local' })
	const track = db.upsertTrack({
		uniqueKey: 'bilibili::BV1testBackup',
		title: '测试曲目',
		artistName: '测试作者',
		artistRemoteId: '12345',
		coverUrl: 'https://i0.hdslb.com/test.jpg',
		duration: 212,
		bvid: 'BV1testBackup',
		cid: 999,
		isMultiPage: false,
	})
	db.addTrackToPlaylist(playlist.id, track.id, 0)

	// 再挂一个远端歌单，验证远端来源标记能往返
	const remote = db.upsertRemotePlaylist({
		source: db.REMOTE_SOURCE.FAVORITE,
		remoteId: 4026748432,
		title: '远端收藏夹',
		description: '用户写的描述',
	})

	console.log('__RESULT__' + JSON.stringify({
		executed: migration.executed,
		dbFile,
		playlistId: playlist.id,
		remotePlaylistId: remote.id,
		hasDbFile: require('node:fs').existsSync(dbFile),
	}))
`)

check('迁移在空库上跑通', seed.executed.length > 0, seed.executed.join(', '))
check('数据库文件已生成', seed.hasDbFile === true, seed.dbFile)

// ===============================================================
// 2. 生成备份
// ===============================================================

console.log('\n2. 生成备份\n')

const BACKUP_FILE = path.join(DATA_DIR, 'test-backup.bbplayer')

const created = runNode(`
	const fs = require('node:fs')
	const backup = require('./src/backup.cjs')
	const result = backup.createBackup({
		dbFile: ${JSON.stringify(DB_FILE)},
		baselineName: '0000_baseline.sql',
		mmkv: { 'app-storage': '{"state":{"settings":{"theme":"dark"}},"version":4}' },
	})
	fs.writeFileSync(${JSON.stringify(BACKUP_FILE)}, result.buffer)
	console.log('__RESULT__' + JSON.stringify({
		filename: result.filename,
		manifest: result.manifest,
		stats: result.stats,
		archiveBytes: result.buffer.length,
		zipMagic: result.buffer.subarray(0, 4).toString('hex'),
	}))
`)

const r = created
check(
	'备份文件名匹配移动端的列表规则 /^backup-.+\\.bbplayer$/',
	/^backup-.+\.bbplayer$/.test(r.filename),
	r.filename,
)
check(
	'文件名是 ISO 时间戳（冒号与点都换成 -）',
	/^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.bbplayer$/.test(
		r.filename,
	),
	r.filename,
)
check('归档是合法 ZIP（PK\\x03\\x04）', r.zipMagic === '504b0304', r.zipMagic)
check(
	'manifest.version 严格等于数字 2',
	r.manifest.version === 2,
	`${JSON.stringify(r.manifest.version)} (${typeof r.manifest.version})`,
)
check(
	'manifest.exportedAt 是 ISO 字符串',
	/^\d{4}-\d{2}-\d{2}T.*Z$/.test(r.manifest.exportedAt ?? ''),
	r.manifest.exportedAt,
)
check(
	'manifest.mmkv 三个键齐全（移动端直接下标取值，缺了会 TypeError）',
	['app-storage', 'playback-context-store', 'shared-playlist-members'].every(
		(k) => typeof r.manifest.mmkv?.[k] === 'string',
	),
	JSON.stringify(r.manifest.mmkv),
)
check(
	'manifest.orpheus 存在且形如 {playerQueue, loudness}（移动端不判空就传原生）',
	typeof r.manifest.orpheus?.playerQueue === 'object' &&
		typeof r.manifest.orpheus?.loudness === 'object',
	JSON.stringify(r.manifest.orpheus),
)
check(
	'导出的 mmkv 值原样带过去',
	String(r.manifest.mmkv['app-storage']).includes('"theme":"dark"'),
)
check(
	'导出时迁移表被规范成移动端形状（created_at）',
	r.stats.migrationNormalized === true,
	`原列=[${(r.stats.migrationColumns ?? []).join(', ')}]`,
)

// ===============================================================
// 3. 用移动端的库（JSZip）交叉验证 ZIP
// ===============================================================

console.log('\n3. 用移动端真正用的 JSZip 读我们的归档\n')

if (!JSZIP_DIR) {
	check('找到 jszip 以做交叉验证', false, '未找到 jszip 包')
} else {
	const cross = runNode(`
		const fs = require('node:fs')
		const JSZip = require(${JSON.stringify(JSZIP_DIR)})
		;(async () => {
			const bytes = fs.readFileSync(${JSON.stringify(BACKUP_FILE)})
			const zip = await JSZip.loadAsync(bytes)
			const names = Object.keys(zip.files).sort()

			const manifestText = await zip.file('manifest.json').async('string')
			const dbBytes = await zip.file('database.db').async('uint8array')

			// 移动端 import.ts 的读取顺序：先 manifest 再 database
			const manifest = JSON.parse(manifestText)
			const sqliteHeader = Buffer.from(dbBytes.subarray(0, 16)).toString('ascii')

			// 移动端的版本闸门
			const versionOk = manifest.version === 2

			// 移动端 import.ts 只检查这两个条目的**精确名字**
			const hasBoth = zip.file('manifest.json') !== null && zip.file('database.db') !== null

			// zip 里是否有 data descriptor 之类的怪东西：看 JSZip 解出来的
			// 未压缩大小是否与 bytes 长度一致
			console.log('__RESULT__' + JSON.stringify({
				names,
				manifestVersion: manifest.version,
				versionOk,
				hasBoth,
				sqliteHeader,
				dbBytes: dbBytes.length,
				manifestKeys: Object.keys(manifest).sort(),
				// JSZip 解出来的目录信息：压缩方法应为 STORE(0)
				compression: names.map((n) => ({ name: n, ...zip.files[n]._data })),
			}))
		})().catch((error) => {
			console.log('__RESULT__' + JSON.stringify({ error: error.message }))
		})
	`)

	const c = cross
	if (c.error) {
		check('JSZip 能读取我们的归档', false, c.error)
	} else {
		check('JSZip 能读取我们的归档（无错误）', true)
		check(
			'归档恰好两个条目，且名字逐字节精确',
			c.names.length === 2 &&
				c.names.includes('database.db') &&
				c.names.includes('manifest.json'),
			c.names.join(', '),
		)
		check(
			'database.db 解出来是 SQLite（头部 "SQLite format 3"）',
			String(c.sqliteHeader).startsWith('SQLite format 3'),
			JSON.stringify(String(c.sqliteHeader)),
		)
		check(
			'manifest.version 通过移动端的 === 2 闸门',
			c.versionOk === true,
			String(c.manifestVersion),
		)
		check(
			'manifest 顶层键与移动端的 BackupManifest 一致',
			['exportedAt', 'mmkv', 'orpheus', 'version'].every((k) =>
				c.manifestKeys.includes(k),
			),
			(c.manifestKeys ?? []).join(', '),
		)
		check(
			'条目使用 STORE（不压缩），与移动端导出一致',
			(c.compression ?? []).every(
				(entry) => entry?.compression?.magic === '\u0000\u0000',
			) || (c.compression ?? []).length === 0,
			(c.compression ?? [])
				.map((e) => `${e.name}=${JSON.stringify(e?.compression?.magic)}`)
				.join(' '),
		)
	}
}

// ===============================================================
// 4. 迁移表双向规范化（H1）
// ===============================================================

console.log('\n4. 迁移表双向规范化（两端结构不同的陷阱）\n')

const migrationShapes = runNode(`
	const { DatabaseSync } = require('node:sqlite')
	const backup = require('./src/backup.cjs')
	const fs = require('node:fs')
	const path = require('node:path')

	const dir = ${JSON.stringify(DATA_DIR)}
	const results = {}

	// --- 移动端形状 -> 桌面端形状（导入方向）---
	{
		const file = path.join(dir, 'mobile-shape.db')
		if (fs.existsSync(file)) fs.unlinkSync(file)
		const db = new DatabaseSync(file)
		db.exec('CREATE TABLE artists (id integer primary key autoincrement, name text)')
		// drizzle migrator 的真实建表语句
		db.exec('CREATE TABLE IF NOT EXISTS \\\`__drizzle_migrations\\\` (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)')
		db.prepare('INSERT INTO __drizzle_migrations ("hash","created_at") VALUES (?,?)').run('', 1700000000000)
		db.prepare('INSERT INTO __drizzle_migrations ("hash","created_at") VALUES (?,?)').run('', 1700000001000)

		const before = db.prepare('PRAGMA table_info(__drizzle_migrations)').all().map((r) => r.name)
		const normalized = backup.normalizeMigrationsForDesktop(db, '0000_baseline.sql')
		const after = db.prepare('PRAGMA table_info(__drizzle_migrations)').all().map((r) => r.name)
		const rows = db.prepare('SELECT id, applied_at FROM __drizzle_migrations').all()
		db.close()
		results.mobileToDesktop = { before, after, normalized, rows }
	}

	// --- 桌面端形状 -> 移动端形状（导出方向）---
	{
		const file = path.join(dir, 'desktop-shape.db')
		if (fs.existsSync(file)) fs.unlinkSync(file)
		const db = new DatabaseSync(file)
		db.exec('CREATE TABLE artists (id integer primary key autoincrement, name text)')
		db.exec('CREATE TABLE IF NOT EXISTS __drizzle_migrations (id TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)')
		db.prepare('INSERT INTO __drizzle_migrations (id, applied_at) VALUES (?, ?)').run('0000_baseline.sql', 1700000000000)

		const before = db.prepare('PRAGMA table_info(__drizzle_migrations)').all().map((r) => r.name)
		const normalized = backup.normalizeMigrationsForMobile(db)
		const after = db.prepare('PRAGMA table_info(__drizzle_migrations)').all().map((r) => r.name)
		const rows = db.prepare('SELECT id, hash, created_at FROM __drizzle_migrations').all()
		db.close()
		results.desktopToMobile = { before, after, normalized, rows }
	}

	// --- 已是移动端形状时导出，必须保持不动（幂等）---
	{
		const file = path.join(dir, 'mobile-idempotent.db')
		if (fs.existsSync(file)) fs.unlinkSync(file)
		const db = new DatabaseSync(file)
		db.exec('CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)')
		db.prepare('INSERT INTO __drizzle_migrations ("hash","created_at") VALUES (?,?)').run('', 1700000002000)
		const normalized = backup.normalizeMigrationsForMobile(db)
		const rows = db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get()
		db.close()
		results.idempotent = { normalized, count: Number(rows.n) }
	}

	console.log('__RESULT__' + JSON.stringify(results))
`)

const m = migrationShapes
check(
	'移动端形状 -> 桌面端：列变成 (id, applied_at)',
	m.mobileToDesktop?.after?.includes('applied_at') &&
		m.mobileToDesktop.after.includes('id'),
	`${(m.mobileToDesktop?.before ?? []).join(',')} -> ${(m.mobileToDesktop?.after ?? []).join(',')}`,
)
check(
	'移动端形状 -> 桌面端：基线被记为已应用（避免重放 0000_baseline.sql）',
	(m.mobileToDesktop?.rows ?? []).some((row) => row.id === '0000_baseline.sql'),
	JSON.stringify(m.mobileToDesktop?.rows),
)
check(
	'桌面端形状 -> 移动端：列变成 (id, hash, created_at)',
	m.desktopToMobile?.after?.includes('created_at') &&
		m.desktopToMobile.after.includes('hash'),
	`${(m.desktopToMobile?.before ?? []).join(',')} -> ${(m.desktopToMobile?.after ?? []).join(',')}`,
)
check(
	'桌面端形状 -> 移动端：行可被 drizzle 的三列查询读出',
	(m.desktopToMobile?.rows ?? []).length > 0 &&
		typeof (m.desktopToMobile?.rows ?? [])[0]?.created_at === 'number',
	JSON.stringify(m.desktopToMobile?.rows),
)
check(
	'已是移动端形状时导出不改动它（幂等，保留 drizzle 记账）',
	m.idempotent?.normalized?.changed === false && m.idempotent?.count === 1,
	JSON.stringify(m.idempotent),
)

// ===============================================================
// 5. 往返：恢复自己导出的备份
// ===============================================================

console.log('\n5. 往返恢复（导出 -> 恢复 -> 数据仍在）\n')

const roundTrip = (() => {
	// 「破坏数据」必须在**独立进程**里做：`db.cjs` 会经 `ports.cjs` 长期持有
	// 数据库连接，而 Windows 下打开着的文件不能被 rename。所以按真实使用
	// 顺序拆成两步：进程 A 破坏并退出（连接随之关闭），进程 B 恢复。
	runNode(`
		const fs = require('node:fs')
		const { DatabaseSync } = require('node:sqlite')
		const dbFile = ${JSON.stringify(DB_FILE)}

		const before = new DatabaseSync(dbFile)
		const beforeCounts = {
			playlists: Number(before.prepare('SELECT COUNT(*) AS n FROM playlists').get().n),
			tracks: Number(before.prepare('SELECT COUNT(*) AS n FROM tracks').get().n),
		}
		before.close()

		// 破坏：删掉所有歌单与曲目（恢复后必须回来）
		const wreck = new DatabaseSync(dbFile)
		wreck.exec('DELETE FROM playlist_tracks')
		wreck.exec('DELETE FROM playlists')
		wreck.exec('DELETE FROM tracks')
		wreck.close()

		// 校验破坏确实生效（否则「恢复成功」是假的）
		const check = new DatabaseSync(dbFile)
		const wreckedPlaylists = Number(check.prepare('SELECT COUNT(*) AS n FROM playlists').get().n)
		check.close()

		fs.writeFileSync(${JSON.stringify(path.join(DATA_DIR, 'before-counts.json'))}, JSON.stringify(beforeCounts))
		console.log('__RESULT__' + JSON.stringify({ beforeCounts, wreckedPlaylists }))
	`)

	return runNode(`
		const fs = require('node:fs')
		const { DatabaseSync } = require('node:sqlite')
		const backup = require('./src/backup.cjs')

		const buffer = fs.readFileSync(${JSON.stringify(BACKUP_FILE)})
		const dbFile = ${JSON.stringify(DB_FILE)}
		const beforeCounts = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(DATA_DIR, 'before-counts.json'))}, 'utf8'))

		const result = backup.restoreBackup({
			buffer,
			dbFile,
			baselineName: '0000_baseline.sql',
			log: () => {},
		})

		const after = new DatabaseSync(dbFile)
		const afterCounts = {
			playlists: Number(after.prepare('SELECT COUNT(*) AS n FROM playlists').get().n),
			tracks: Number(after.prepare('SELECT COUNT(*) AS n FROM tracks').get().n),
		}
		const titles = after.prepare('SELECT title FROM playlists ORDER BY id').all().map((row) => row.title)
		const trackTitle = after.prepare('SELECT title FROM tracks LIMIT 1').get()?.title ?? null
		// 远端来源标记必须往返（哈希编码 + description 标记）
		const remoteRow = after.prepare('SELECT description FROM playlists WHERE title = ?').get('远端收藏夹')
		// 曲目与歌单的关联也必须回来
		const linked = Number(after.prepare('SELECT COUNT(*) AS n FROM playlist_tracks').get().n)
		const migrationCols = after.prepare('PRAGMA table_info(__drizzle_migrations)').all().map((row) => row.name)
		const baselineRow = after.prepare('SELECT id FROM __drizzle_migrations WHERE id = ?').get('0000_baseline.sql')
		after.close()

		console.log('__RESULT__' + JSON.stringify({
			beforeCounts,
			afterCounts,
			titles,
			trackTitle,
			remoteDescription: remoteRow?.description ?? null,
			linked,
			migrationCols,
			baselineRecorded: Boolean(baselineRow),
			backupOfPrevious: Boolean(result.backupOfPrevious),
			previousExists: result.backupOfPrevious ? fs.existsSync(result.backupOfPrevious) : false,
			dataMigrations: result.dataMigrations,
			warnings: result.warnings,
		}))
	`)
})()

const t = roundTrip
check(
	'恢复后歌单回来了',
	t.afterCounts?.playlists === t.beforeCounts?.playlists &&
		t.afterCounts.playlists > 0,
	`${t.beforeCounts?.playlists} -> ${t.afterCounts?.playlists}`,
)
check(
	'恢复后曲目回来了',
	t.afterCounts?.tracks === t.beforeCounts?.tracks && t.afterCounts.tracks > 0,
	`${t.beforeCounts?.tracks} -> ${t.afterCounts?.tracks}`,
)
check(
	'恢复后曲目与歌单的关联也回来了（playlist_tracks）',
	t.linked > 0,
	`${t.linked} 条关联`,
)
check('曲目标题正确', t.trackTitle === '测试曲目', String(t.trackTitle))
check(
	'远端来源标记（description 里的 [[bb:fav:...]]）往返成功',
	String(t.remoteDescription ?? '').includes('[[bb:fav:4026748432]]'),
	String(t.remoteDescription),
)
check(
	'恢复后迁移表是桌面端形状（桌面 runner 不会重放基线）',
	t.migrationCols?.includes('applied_at'),
	(t.migrationCols ?? []).join(', '),
)
check(
	'恢复后基线被记账，桌面 runner 不会重放 0000_baseline.sql',
	t.baselineRecorded === true,
)
check(
	'旧库被留存（恢复可回滚）',
	t.backupOfPrevious === true && t.previousExists === true,
)
check(
	'JS 数据迁移全部真的跑成功（不是「被调用但都失败」）',
	t.dataMigrations?.skipped === false &&
		Object.values(t.dataMigrations?.results ?? {}).every(
			(status: unknown) => status === 'ok',
		),
	JSON.stringify(t.dataMigrations?.results),
)
check(
	'恢复过程没有互通警告',
	(t.warnings ?? []).length === 0,
	JSON.stringify(t.warnings),
)

// ===============================================================
// 6. 负例：坏归档必须被拒
// ===============================================================

console.log('\n6. 负例：坏归档必须被明确拒绝\n')

const negatives = runNode(`
	const backup = require('./src/backup.cjs')

	const good = backup.createZip([
		{ name: 'database.db', data: Buffer.from('SQLite format 3\\u0000' + 'x'.repeat(100)) },
		{ name: 'manifest.json', data: Buffer.from(JSON.stringify({
			version: 2, exportedAt: new Date().toISOString(),
			mmkv: { 'app-storage': '', 'shared-playlist-members': '' },
			orpheus: { playerQueue: {}, loudness: {} },
		})) },
	])

	const results = {}
	const attempt = (name, fn) => {
		try { fn(); results[name] = null }
		catch (error) { results[name] = error.message }
	}

	// 1) 不是 ZIP
	attempt('notZip', () => backup.parseBackup(Buffer.from('this is not a zip at all')))

	// 2) 缺 manifest.json
	attempt('noManifest', () => backup.parseBackup(
		backup.createZip([{ name: 'database.db', data: Buffer.from('SQLite format 3\\u0000' + 'x'.repeat(50)) }])
	))

	// 3) 缺 database.db
	attempt('noDatabase', () => backup.parseBackup(
		backup.createZip([{ name: 'manifest.json', data: good.subarray(0,0) || Buffer.from(JSON.stringify({ version: 2 })) }])
	))

	// 4) version 是字符串 "2"（移动端用 !== 严格比较，也会拒）
	attempt('stringVersion', () => backup.parseBackup(
		backup.createZip([
			{ name: 'database.db', data: Buffer.from('SQLite format 3\\u0000' + 'x'.repeat(50)) },
			{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ version: '2' })) },
		])
	))

	// 5) version 是 1（旧版本）
	attempt('oldVersion', () => backup.parseBackup(
		backup.createZip([
			{ name: 'database.db', data: Buffer.from('SQLite format 3\\u0000' + 'x'.repeat(50)) },
			{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ version: 1 })) },
		])
	))

	// 6) database.db 不是 SQLite
	attempt('notSqlite', () => backup.parseBackup(
		backup.createZip([
			{ name: 'database.db', data: Buffer.from('PK\\u0003\\u0004definitely not sqlite') },
			{ name: 'manifest.json', data: Buffer.from(JSON.stringify({
				version: 2, mmkv: {}, orpheus: {},
			})) },
		])
	))

	// 7) manifest 不是合法 JSON
	attempt('badJson', () => backup.parseBackup(
		backup.createZip([
			{ name: 'database.db', data: Buffer.from('SQLite format 3\\u0000' + 'x'.repeat(50)) },
			{ name: 'manifest.json', data: Buffer.from('{ not json') },
		])
	))

	// 8) 合法归档不该被拒
	let okParsed = null
	try {
		okParsed = backup.parseBackup(good)
		results.valid = null
	} catch (error) { results.valid = error.message }

	console.log('__RESULT__' + JSON.stringify({
		results,
		validOk: okParsed !== null,
		validWarnings: okParsed?.warnings ?? [],
	}))
`)

const n = negatives
check('非 ZIP 被拒', typeof n.results?.notZip === 'string', n.results?.notZip)
check(
	'缺 manifest.json 被拒',
	typeof n.results?.noManifest === 'string',
	n.results?.noManifest,
)
check(
	'缺 database.db 被拒',
	typeof n.results?.noDatabase === 'string',
	n.results?.noDatabase,
)
check(
	'version 是字符串 "2" 被拒（严格比较，与移动端一致）',
	typeof n.results?.stringVersion === 'string',
	n.results?.stringVersion,
)
check(
	'version 是 1（旧版本）被拒',
	typeof n.results?.oldVersion === 'string',
	n.results?.oldVersion,
)
check(
	'database.db 不是 SQLite 被拒',
	typeof n.results?.notSqlite === 'string',
	n.results?.notSqlite,
)
check(
	'manifest 非法 JSON 被拒',
	typeof n.results?.badJson === 'string',
	n.results?.badJson,
)
check(
	'合法归档不被误拒',
	n.validOk === true && n.results?.valid === null,
	n.results?.valid ?? 'ok',
)

// ===============================================================
// 7. 负例：恢复失败必须**不破坏**现有库
// ===============================================================

console.log('\n7. 恢复失败时现有库必须完好\n')

const safety = runNode(`
	const fs = require('node:fs')
	const { DatabaseSync } = require('node:sqlite')
	const backup = require('./src/backup.cjs')

	// 用独立的小库，且**不经过 db.cjs**（避免 ports.cjs 打开它）
	const dbFile = ${JSON.stringify(path.join(DATA_DIR, 'safety.db'))}
	if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile)
	const seed = new DatabaseSync(dbFile)
	seed.exec('CREATE TABLE marker (value text)')
	seed.prepare('INSERT INTO marker (value) VALUES (?)').run('还在')
	seed.close()

	// 坏归档：连 ZIP 都不是 -> 必须在**任何写操作之前**就被拒
	let error = null
	try {
		backup.restoreBackup({
			buffer: Buffer.from('not a zip'),
			dbFile,
			baselineName: '0000_baseline.sql',
			log: () => {},
		})
	} catch (e) { error = e.message }

	// 关键：解析失败后原库必须原封不动
	const after = new DatabaseSync(dbFile)
	const value = after.prepare('SELECT value FROM marker').get()?.value ?? null
	after.close()

	// 第二个负例：归档合法但 database.db 不是 SQLite -> 同样不能动原库
	let error2 = null
	try {
		backup.restoreBackup({
			buffer: backup.createZip([
				{ name: 'database.db', data: Buffer.from('not a sqlite file at all, just text') },
				{ name: 'manifest.json', data: Buffer.from(JSON.stringify({
					version: 2, exportedAt: new Date().toISOString(),
					mmkv: { 'app-storage': '', 'shared-playlist-members': '' },
					orpheus: { playerQueue: {}, loudness: {} },
				})) },
			]),
			dbFile,
			baselineName: '0000_baseline.sql',
			log: () => {},
		})
	} catch (e) { error2 = e.message }

	const after2 = new DatabaseSync(dbFile)
	const value2 = after2.prepare('SELECT value FROM marker').get()?.value ?? null
	after2.close()

	console.log('__RESULT__' + JSON.stringify({ error, value, error2, value2 }))
`)

const s = safety
check('坏归档恢复被拒', typeof s.error === 'string', s.error)
check(
	'解析失败后原库**完好无损**（没有先删后建）',
	s.value === '还在',
	`marker=${s.value}`,
)
check(
	'归档结构合法但内层不是 SQLite 时也被拒',
	typeof s.error2 === 'string',
	s.error2,
)
check('第二次失败后原库仍然完好', s.value2 === '还在', `marker=${s.value2}`)

// ===============================================================
// 8. 断路器：关闭后不可再访问
// ===============================================================

console.log('\n8. 数据库断路器（关闭后拒绝访问）\n')

const breaker = runNode(`
	const ports = require('./src/ports.cjs')

	const beforeClose = (() => {
		try { ports.sqlite.getAllSync('SELECT 1'); return 'ok' }
		catch (error) { return 'error: ' + error.message }
	})()

	ports.closeDatabase()

	const afterClose = (() => {
		try { ports.sqlite.getAllSync('SELECT 1'); return 'ok' }
		catch (error) { return error.message }
	})()

	const afterClose2 = (() => {
		try { ports.sqlite.execSync('SELECT 1'); return 'ok' }
		catch (error) { return error.message }
	})()

	console.log('__RESULT__' + JSON.stringify({
		beforeClose,
		afterClose,
		afterClose2,
		isClosed: ports.isDatabaseClosed(),
		describe: ports.describePorts().dataDir ? 'ok' : 'missing',
	}))
`)

const b = breaker
check('关闭前可正常访问', b.beforeClose === 'ok', b.beforeClose)
check(
	'关闭后读取被拒且提示需重启',
	String(b.afterClose).includes('重启'),
	String(b.afterClose),
)
check(
	'关闭后执行也被拒',
	String(b.afterClose2).includes('重启'),
	String(b.afterClose2),
)
check('断路器状态可查询', b.isClosed === true)

// ===============================================================

console.log(`\n=== 结果：${passed} 通过, ${failed} 失败 ===`)
console.log(`（数据目录保留供检查：${DATA_DIR}）`)
process.exit(failed === 0 ? 0 : 1)
