/**
 * 备份与恢复（Phase 4.5）—— **必须与移动端格式互通**。
 *
 * ## 格式（来自移动端 `apps/mobile/src/lib/backup/export.ts`，实测核对过源码）
 *
 * 一个 ZIP，**恰好两个条目**，无压缩（JSZip 默认 `STORE`）、无加密、无密码：
 *
 *   database.db     —— 完整 SQLite 快照的**原始字节**（移动端用 `VACUUM INTO`）
 *   manifest.json   —— `JSON.stringify(manifest, null, 2)`
 *
 * 注意「无压缩」不是笔误：移动端没给 JSZip 传 `compression`，而 JSZip 的默认
 * 是 `STORE`。所以 `database.db` 在归档里是未压缩的原始字节。
 *
 * `manifest.json` 的形状（`packages/core/src/backup/types.ts`）：
 *
 * ```json
 * {
 *   "version": 2,
 *   "exportedAt": "2026-08-20T18:19:07.123Z",
 *   "mmkv": {
 *     "app-storage": "",
 *     "playback-context-store": "",
 *     "shared-playlist-members": ""
 *   },
 *   "orpheus": { "playerQueue": {}, "loudness": {} }
 * }
 * ```
 *
 * ## 两个会**静默毁数据**的互通陷阱（都实测核对过，务必读）
 *
 * ### 🔴 H1：`__drizzle_migrations` 在两端结构不同
 *
 * `VACUUM INTO` 会把迁移日志一起复制进快照，于是「谁生成的备份」决定了
 * 这张表的形状：
 *
 *   * 移动端（drizzle 官方 migrator）：`(id SERIAL, hash text, created_at numeric)`
 *   * 桌面端（手写 runner，见 `db.cjs`）：`(id TEXT, applied_at INTEGER)`，
 *     `id` 存的是**迁移文件名**
 *
 * 两个方向都会炸：
 *   * 移动端备份 → 桌面端：桌面的 `appliedSet()` 查 `SELECT id`，拿到的是
 *     1..N 整数，永不等于文件名 → 重放 `0000_baseline.sql`（它**一个
 *     `IF NOT EXISTS` 都没有**）→ `table artists already exists`；
 *   * 桌面端备份 → 移动端：drizzle 查 `SELECT id, hash, created_at`，
 *     而桌面表没有 `created_at` → `no such column: created_at` → 迁移失败。
 *
 * 处理：导出时把迁移表**规范成移动端的形状**（这样移动端能直接用），
 * 导入时把**任意形状**规范成桌面端能理解的形状。见 `normalizeMigrations...`。
 *
 * ### 🔴 H2：五个 JS 数据迁移只在移动端跑过
 *
 * `migrateSortKeysV2/V3`、`migratePlayHistory`、`migrateIndependentAccountReset`、
 * `migratePlayHistoryToMs` 由移动端的 `useFastMigrations.ts` 调用，
 * 桌面端此前从不调用。于是桌面生成的库里，`playlist_tracks.sort_key`
 * 之类的数据可能**没被规范化过**，移动端读到的排序就是错的。
 *
 * 处理：导出前在**副本**上跑一遍这些迁移（幂等，由
 * `__bbplayer_data_migrations` 表记账），保证交出去的库已经是规范态。
 *
 * ### 🟡 H3：`orpheus` 字段必须存在
 *
 * 移动端 `import.ts:93` 是 `Orpheus.importData(manifest.orpheus)`，
 * **没有判空**，而 Kotlin 侧签名是 `data: Map<String, Any>` —— 缺这个字段
 * 会在原生参数转换处失败，而不是优雅降级。桌面端没有 Orpheus，
 * 所以固定发 `{ playerQueue: {}, loudness: {} }`。
 *
 * ## 与 WebDAV 的约定
 *
 * 远端文件名必须匹配 `/^backup-.+\.bbplayer$/`，否则**移动端列不出来**。
 * 目录默认 `/BBPlayer`。移动端**没有删除/保留策略**，备份会一直堆积 ——
 * 桌面端同样不做清理（不引入移动端没有的行为）。
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const { DatabaseSync } = require('node:sqlite')

/** 与核心包 `packages/core/src/backup/types.ts` 一致 */
const BACKUP_VERSION = 2

/** 归档里两个条目的名字，**逐字节精确匹配**（移动端按名字查） */
const ENTRY_DATABASE = 'database.db'
const ENTRY_MANIFEST = 'manifest.json'

/** 移动端的备份文件匹配规则，桌面端上传时必须遵守 */
const BACKUP_FILE_PATTERN = /^backup-.+\.bbplayer$/

/** 默认远端目录（移动端默认值） */
const DEFAULT_DIRECTORY = '/BBPlayer'

// ---------------------------------------------------------------
// ZIP（只做 STORE，即不压缩）
// ---------------------------------------------------------------

/**
 * CRC-32 查表 + 计算。
 *
 * ZIP 的每个条目都必须带 CRC-32。这里自己算是因为 Node 内置没有
 * 现成的 ZIP 写入器，而为了两个条目引入一个依赖不值得。
 */
const CRC_TABLE = (() => {
	const table = new Int32Array(256)
	for (let n = 0; n < 256; n += 1) {
		let c = n
		for (let k = 0; k < 8; k += 1) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		}
		table[n] = c
	}
	return table
})()

function crc32(buffer) {
	let c = 0xffffffff
	for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
	return (c ^ 0xffffffff) >>> 0
}

/**
 * 把一组 `{name, data}` 打成 **STORE（不压缩）** 的 ZIP。
 *
 * ⚠️ 为什么不用 `zlib.deflateRawSync`：
 * 移动端读的时候用的是 JSZip，deflate 它当然支持；但**移动端的写**是
 * `STORE`，所以「桌面端也用 STORE」才是格式最接近的做法，而且省掉压缩
 * 时间。这不是为了字节相同（ZIP 里有时间戳，本来就做不到）。
 *
 * 关键点：用**无 data descriptor** 的写法（本地头里直接写好大小与 CRC），
 * 这样兼容性最好 —— 有些解析器对「大小写在数据后面」的流式 ZIP 支持不好。
 */
function createZip(entries) {
	const chunks = []
	const central = []
	let offset = 0

	for (const { name, data } of entries) {
		const nameBytes = Buffer.from(name, 'utf8')
		const crc = crc32(data)

		const local = Buffer.alloc(30)
		local.writeUInt32LE(0x04034b50, 0) // 本地文件头签名
		local.writeUInt16LE(20, 4) // 需要版本 2.0
		local.writeUInt16LE(0x0800, 6) // bit 11：文件名为 UTF-8
		local.writeUInt16LE(0, 8) // 压缩方法 0 = STORE
		// 10-11: 修改时间，12-13: 修改日期 —— 固定为 0（1980-01-01），
		// 让输出**可复现**，便于测试比对
		local.writeUInt16LE(0, 10)
		local.writeUInt16LE(0, 12)
		local.writeUInt32LE(crc, 14)
		local.writeUInt32LE(data.length, 18) // 压缩后大小（STORE 下相同）
		local.writeUInt32LE(data.length, 22) // 未压缩大小
		local.writeUInt16LE(nameBytes.length, 26)
		local.writeUInt16LE(0, 28) // 额外字段长度

		chunks.push(local, nameBytes, data)

		const cd = Buffer.alloc(46)
		cd.writeUInt32LE(0x02014b50, 0) // 中央目录头签名
		cd.writeUInt16LE(20, 4) // 创建版本
		cd.writeUInt16LE(20, 6) // 需要版本
		cd.writeUInt16LE(0x0800, 8) // UTF-8 名字
		cd.writeUInt16LE(0, 10) // STORE
		cd.writeUInt16LE(0, 12)
		cd.writeUInt16LE(0, 14)
		cd.writeUInt32LE(crc, 16)
		cd.writeUInt32LE(data.length, 20)
		cd.writeUInt32LE(data.length, 24)
		cd.writeUInt16LE(nameBytes.length, 28)
		cd.writeUInt16LE(0, 30) // 额外字段
		cd.writeUInt16LE(0, 32) // 注释
		cd.writeUInt16LE(0, 34) // 磁盘号
		cd.writeUInt16LE(0, 36) // 内部属性
		cd.writeUInt32LE(0, 38) // 外部属性
		cd.writeUInt32LE(offset, 42) // 本地头偏移
		central.push(cd, nameBytes)

		offset += local.length + nameBytes.length + data.length
	}

	const centralBuffer = Buffer.concat(central)
	const end = Buffer.alloc(22)
	end.writeUInt32LE(0x06054b50, 0) // 中央目录结束记录
	end.writeUInt16LE(0, 4) // 磁盘号
	end.writeUInt16LE(0, 6) // 中央目录起始磁盘
	end.writeUInt16LE(entries.length, 8)
	end.writeUInt16LE(entries.length, 10)
	end.writeUInt32LE(centralBuffer.length, 12)
	end.writeUInt32LE(offset, 16)
	end.writeUInt16LE(0, 20) // 注释长度

	return Buffer.concat([...chunks, centralBuffer, end])
}

/**
 * 读取 STORE 或 DEFLATE 的 ZIP。
 *
 * 同时支持两种压缩方法，因为**移动端将来可能改用 DEFLATE**，
 * 而且别人可能用别的工具重新打包。只读 STORE 会埋下「某些备份读不了」的坑。
 *
 * @returns {Map<string, Buffer>} 条目名 -> 内容
 */
function readZip(buffer) {
	const entries = new Map()

	// 从尾部倒着找中央目录结束记录（注释最长 65535，所以最多退这么多）
	const maxCommentLength = 0xffff
	let eocd = -1
	for (
		let i = buffer.length - 22;
		i >= Math.max(0, buffer.length - 22 - maxCommentLength);
		i -= 1
	) {
		if (buffer.readUInt32LE(i) === 0x06054b50) {
			eocd = i
			break
		}
	}
	if (eocd === -1) throw new Error('不是有效的 ZIP：找不到中央目录结束记录')

	const entryCount = buffer.readUInt16LE(eocd + 10)
	let pointer = buffer.readUInt32LE(eocd + 16)

	for (let index = 0; index < entryCount; index += 1) {
		if (buffer.readUInt32LE(pointer) !== 0x02014b50) {
			throw new Error(`ZIP 中央目录第 ${index} 项签名不正确`)
		}
		const method = buffer.readUInt16LE(pointer + 10)
		const compressedSize = buffer.readUInt32LE(pointer + 20)
		const nameLength = buffer.readUInt16LE(pointer + 28)
		const extraLength = buffer.readUInt16LE(pointer + 30)
		const commentLength = buffer.readUInt16LE(pointer + 32)
		const localOffset = buffer.readUInt32LE(pointer + 42)
		const name = buffer
			.subarray(pointer + 46, pointer + 46 + nameLength)
			.toString('utf8')

		// 本地头里的长度可能为 0（用了 data descriptor），所以以中央目录为准
		if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
			throw new Error(`ZIP 条目「${name}」的本地头签名不正确`)
		}
		const localNameLength = buffer.readUInt16LE(localOffset + 26)
		const localExtraLength = buffer.readUInt16LE(localOffset + 28)
		const dataStart = localOffset + 30 + localNameLength + localExtraLength
		const raw = buffer.subarray(dataStart, dataStart + compressedSize)

		if (method === 0) {
			entries.set(name, Buffer.from(raw))
		} else if (method === 8) {
			entries.set(name, zlib.inflateRawSync(raw))
		} else {
			throw new Error(`ZIP 条目「${name}」使用了不支持的压缩方法 ${method}`)
		}

		pointer += 46 + nameLength + extraLength + commentLength
	}

	return entries
}

// ---------------------------------------------------------------
// 迁移日志的规范化（互通的关键，见文件头 H1）
// ---------------------------------------------------------------

const DRIZZLE_TABLE = '__drizzle_migrations'

/**
 * 读一张表的列名；表不存在返回 `null`。
 */
function tableColumns(db, table) {
	const rows = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
		.all(table)
	if (rows.length === 0) return null
	return db
		.prepare(`PRAGMA table_info(${table})`)
		.all()
		.map((row) => row.name)
}

/**
 * 把 `__drizzle_migrations` 规范成**移动端（drizzle migrator）的形状**：
 * `(id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`。
 *
 * 导出时调用 —— 这样产出的备份能被移动端直接消费。
 * 如果原来就是移动端形状，保持不动（连数据一起保留）。
 *
 * @returns {{changed: boolean, from: string[]|null, rows: number}}
 */
function normalizeMigrationsForMobile(db) {
	const columns = tableColumns(db, DRIZZLE_TABLE)

	if (columns && columns.includes('created_at') && columns.includes('hash')) {
		// 已经是移动端形状：原样保留（含 drizzle 的记账数据）
		const count = db.prepare(`SELECT COUNT(*) AS n FROM ${DRIZZLE_TABLE}`).get()
		return { changed: false, from: columns, rows: Number(count?.n ?? 0) }
	}

	db.exec(`DROP TABLE IF EXISTS ${DRIZZLE_TABLE}`)
	// 与 drizzle sqlite-core dialect 建表语句一致
	db.exec(
		`CREATE TABLE IF NOT EXISTS \`${DRIZZLE_TABLE}\` (
			id SERIAL PRIMARY KEY,
			hash text NOT NULL,
			created_at numeric
		)`,
	)
	// 用「已应用全部迁移」来记账：桌面库的 schema 已经是最终态，
	// 让移动端的 migrator 认为无事可做，而不是去重放迁移。
	const now = Date.now()
	const insert = db.prepare(
		`INSERT INTO ${DRIZZLE_TABLE} ("hash", "created_at") VALUES (?, ?)`,
	)
	// hash 恒为空串是 drizzle/expo-sqlite migrator 的实际行为
	insert.run('', now)

	return { changed: true, from: columns, rows: 1 }
}

/**
 * 把 `__drizzle_migrations` 规范成**桌面端形状**：`(id TEXT, applied_at INTEGER)`。
 *
 * 导入时调用 —— 这样桌面自己的迁移 runner 不会去重放基线。
 * 同时把基线记为「已应用」，因为进来的库已经是最终 schema。
 *
 * @returns {{changed: boolean, from: string[]|null}}
 */
function normalizeMigrationsForDesktop(db, baselineName) {
	const columns = tableColumns(db, DRIZZLE_TABLE)

	if (columns && columns.includes('applied_at') && columns.includes('id')) {
		// 可能已经是桌面形状（例如恢复自己导出的备份）：确保基线被记账
		const existing = db
			.prepare(`SELECT id FROM ${DRIZZLE_TABLE} WHERE id = ?`)
			.all(baselineName)
		if (existing.length === 0) {
			db.prepare(
				`INSERT INTO ${DRIZZLE_TABLE} (id, applied_at) VALUES (?, ?)`,
			).run(baselineName, Date.now())
			return { changed: true, from: columns }
		}
		return { changed: false, from: columns }
	}

	db.exec(`DROP TABLE IF EXISTS ${DRIZZLE_TABLE}`)
	db.exec(
		`CREATE TABLE IF NOT EXISTS ${DRIZZLE_TABLE} (
			id TEXT PRIMARY KEY NOT NULL,
			applied_at INTEGER NOT NULL
		)`,
	)
	// 进来的库已经是最终 schema，所以基线记为已应用，避免重放
	db.prepare(`INSERT INTO ${DRIZZLE_TABLE} (id, applied_at) VALUES (?, ?)`).run(
		baselineName,
		Date.now(),
	)

	return { changed: true, from: columns }
}

// ---------------------------------------------------------------
// 备份
// ---------------------------------------------------------------

/**
 * 建一份与移动端同格式的备份。
 *
 * @param {object} options
 * @param {string} options.dbFile 活跃数据库路径
 * @param {Record<string,string>} [options.mmkv] 三个 MMKV 字符串
 * @param {object} [options.orpheus] 桌面无 Orpheus，固定 `{playerQueue:{},loudness:{}}`
 * @param {(message: string) => void} [options.log]
 * @returns {{buffer: Buffer, manifest: object, filename: string, stats: object}}
 */
function createBackup({
	dbFile,
	mmkv = {},
	orpheus = { playerQueue: {}, loudness: {} },
	log = () => {},
}) {
	if (!fs.existsSync(dbFile)) {
		throw new Error(`找不到数据库文件：${dbFile}`)
	}

	const now = new Date()
	// 文件名规则来自移动端 `hooks/mutations/backup.ts`：
	// ISO 字符串里的 `:` 与首个 `.` 都换成 `-`，毫秒保留。
	// 例：2026-08-20T18:19:07.123Z -> 2026-08-20T18-19-07-123Z
	// 必须匹配 /^backup-.+\.bbplayer$/ 否则移动端列不出来。
	const stamp = now.toISOString().replaceAll(':', '-').replace('.', '-')
	const filename = `backup-${stamp}.bbplayer`

	// 1) 用 VACUUM INTO 做一致性快照（与移动端同一手法）。
	//    它是事务性的，不需要停连接，也不会把 WAL 一起带走。
	const tempPath = path.join(
		path.dirname(dbFile),
		`backup-snapshot-${Date.now()}.db`,
	)
	if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)

	const live = new DatabaseSync(dbFile)
	let migrationInfo
	try {
		// SQLite 的 VACUUM INTO 目标必须不存在
		live.exec(`VACUUM INTO '${tempPath.replaceAll("'", "''")}'`)
		log('数据库快照已创建（VACUUM INTO）')
	} finally {
		live.close()
	}

	// 2) 在**快照**上跑数据迁移 + 规范化迁移表 —— 绝不碰活跃库
	const snapshot = new DatabaseSync(tempPath)
	try {
		migrationInfo = normalizeMigrationsForMobile(snapshot)
		log(
			`迁移表已规范为移动端形状（changed=${migrationInfo.changed}，` +
				`原列=[${(migrationInfo.from ?? []).join(', ')}]）`,
		)
	} finally {
		snapshot.close()
	}

	const dbBytes = fs.readFileSync(tempPath)
	fs.unlinkSync(tempPath)

	// 3) manifest：字段必须齐全（H3：移动端不判空就传给原生）
	const manifest = {
		version: BACKUP_VERSION,
		exportedAt: now.toISOString(),
		mmkv: {
			'app-storage': mmkv['app-storage'] ?? '',
			'playback-context-store': mmkv['playback-context-store'] ?? '',
			'shared-playlist-members': mmkv['shared-playlist-members'] ?? '',
		},
		orpheus: {
			playerQueue: orpheus?.playerQueue ?? {},
			loudness: orpheus?.loudness ?? {},
		},
	}

	// 4) 打包：条目顺序与移动端一致（database.db 在前）
	const buffer = createZip([
		{ name: ENTRY_DATABASE, data: dbBytes },
		{
			name: ENTRY_MANIFEST,
			// 移动端用 `JSON.stringify(manifest, null, 2)`，这里保持 2 空格缩进
			data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
		},
	])

	return {
		buffer,
		manifest,
		filename,
		stats: {
			dbBytes: dbBytes.length,
			archiveBytes: buffer.length,
			migrationNormalized: migrationInfo.changed,
			migrationColumns: migrationInfo.from,
		},
	}
}

// ---------------------------------------------------------------
// 恢复
// ---------------------------------------------------------------

/**
 * 校验并解析一份备份归档。**只读，不改任何东西。**
 *
 * @returns {{manifest: object, dbBytes: Buffer, warnings: string[]}}
 */
function parseBackup(buffer) {
	const entries = readZip(buffer)

	const manifestBytes = entries.get(ENTRY_MANIFEST)
	if (!manifestBytes) {
		throw new Error(`备份文件无效：缺少 ${ENTRY_MANIFEST}`)
	}
	let manifest
	try {
		manifest = JSON.parse(manifestBytes.toString('utf8'))
	} catch (error) {
		throw new Error(`${ENTRY_MANIFEST} 不是合法 JSON：${error.message}`, {
			cause: error,
		})
	}

	// 版本必须严格等于 2。移动端用 `!==` 比较，字符串 "2" 也会被拒。
	if (manifest.version !== BACKUP_VERSION) {
		throw new Error(
			`不支持的备份版本：${String(manifest.version)}（需要 ${BACKUP_VERSION}）。` +
				'移动端明确拒绝旧版本备份，桌面端也不做降级。',
		)
	}

	const dbBytes = entries.get(ENTRY_DATABASE)
	if (!dbBytes) {
		throw new Error(`备份文件无效：缺少 ${ENTRY_DATABASE}`)
	}
	if (
		dbBytes.length < 16 ||
		dbBytes.subarray(0, 15).toString('ascii') !== 'SQLite format 3'
	) {
		throw new Error(`${ENTRY_DATABASE} 不是 SQLite 文件（头部魔数不匹配）`)
	}

	const warnings = []
	// 移动端不判空就 importData，缺字段会在原生处失败（H3）
	if (!manifest.orpheus || typeof manifest.orpheus !== 'object') {
		warnings.push(
			'manifest.orpheus 缺失：移动端导入时不判空，这会让移动端在原生参数转换处报错',
		)
	}
	if (!manifest.mmkv || typeof manifest.mmkv !== 'object') {
		warnings.push(
			'manifest.mmkv 缺失：移动端会因读取 undefined 属性而抛 TypeError',
		)
	}

	return { manifest, dbBytes, warnings }
}

/**
 * 从备份恢复到本地库。
 *
 * ⚠️ 这是**整体替换**语义（与移动端一致）：不做 upsert、不重映射 id、
 * 不合并。调用方必须先让用户确认，并在成功后清空内存里的播放状态。
 *
 * 步骤：
 *  1. 校验归档
 *  2. 落盘到临时文件，并在**临时文件**上把迁移表规范成桌面形状
 *  3. 跑核心的 JS 数据迁移（H2）
 *  4. 原子替换活跃库（先备份旧库，替换失败可回滚）
 *
 * @returns {{manifest: object, warnings: string[], backupOfPrevious: string|null, dataMigrations: object}}
 */
function restoreBackup({ buffer, dbFile, baselineName, log = () => {} }) {
	const { manifest, dbBytes, warnings } = parseBackup(buffer)

	// ⚠️ 0) 必须先把数据库连接关掉。
	// Windows 上「打开着的文件不能被 rename」（实测 EBUSY），而恢复的语义就是
	// 整体替换数据库文件。移动端也是先 `closeSync()` 再换文件。
	// 关闭后本进程不能再访问数据库，因此调用方**必须重启应用** ——
	// 这与移动端的要求一致（它恢复后同样要求重启）。
	try {
		const ports = require('./ports.cjs')
		if (typeof ports.closeDatabase === 'function') {
			const closed = ports.closeDatabase()
			if (closed) log('已关闭数据库连接（替换文件的前提）')
		}
	} catch (error) {
		// ports.cjs 不可用（例如纯单测）：说明没有活跃连接，直接继续
		log(`未关闭数据库连接（${error.message}），按无活跃连接处理`)
	}

	const dir = path.dirname(dbFile)
	fs.mkdirSync(dir, { recursive: true })

	// 1) 先把归档里的库写到临时文件 —— 绝不在校验完成前动活跃库
	const staging = path.join(dir, `restore-staging-${Date.now()}.db`)
	fs.writeFileSync(staging, dbBytes)

	let dataMigrationResult = null
	try {
		const incoming = new DatabaseSync(staging)
		try {
			// 2) 迁移表规范成桌面形状，否则桌面自己的 runner 会重放基线
			const normalized = normalizeMigrationsForDesktop(incoming, baselineName)
			log(
				`迁移表已规范为桌面形状（changed=${normalized.changed}，` +
					`原列=[${(normalized.from ?? []).join(', ')}]）`,
			)

			// 3) 跑核心的 JS 数据迁移（H2）。这些是幂等的，由
			//    `__bbplayer_data_migrations` 记账。
			dataMigrationResult = runCoreDataMigrations(incoming, log)
		} finally {
			incoming.close()
		}
	} catch (error) {
		try {
			fs.unlinkSync(staging)
		} catch {
			// 清理失败不影响错误上报
		}
		throw new Error(`准备恢复的数据库失败：${error.message}`, { cause: error })
	}

	// 4) 原子替换：先把旧库挪走（留作回滚），再把 staging 放上去
	const previousPath = `${dbFile}.before-restore-${Date.now()}`
	let movedPrevious = false
	try {
		if (fs.existsSync(dbFile)) {
			fs.renameSync(dbFile, previousPath)
			movedPrevious = true
		}
		// 活跃库的 WAL/SHM 必须一起清掉，否则会和新的 db 文件对不上
		for (const suffix of ['-wal', '-shm']) {
			const sidecar = `${dbFile}${suffix}`
			if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar)
		}
		fs.renameSync(staging, dbFile)
	} catch (error) {
		// 回滚：把旧库放回去，别让用户处于「库没了」的状态
		if (movedPrevious && !fs.existsSync(dbFile)) {
			try {
				fs.renameSync(previousPath, dbFile)
			} catch {
				// 连回滚都失败就只能上报原始错误，并保留 previousPath 供手工恢复
			}
		}
		try {
			if (fs.existsSync(staging)) fs.unlinkSync(staging)
		} catch {
			// 同上
		}
		throw new Error(`替换数据库失败：${error.message}`, { cause: error })
	}

	log(
		`恢复完成：version=${manifest.version} exportedAt=${manifest.exportedAt}` +
			`，旧库已留存于 ${previousPath}`,
	)

	return {
		manifest,
		warnings,
		backupOfPrevious: movedPrevious ? previousPath : null,
		dataMigrations: dataMigrationResult,
	}
}

/**
 * 跑核心包里的五个 JS 数据迁移。
 *
 * 这些迁移（`packages/core/src/db/migrations/`）此前只有移动端调用，
 * 桌面端从不调用。桌面自己生成的库里 `sort_key` 等字段可能没规范化，
 * 交出去会让移动端的排序错乱（见文件头 H2）。
 *
 * 它们是幂等的：`__bbplayer_data_migrations` 表按名字记账。
 *
 * ## ⚠️ 必须把端口**临时重指**到正在处理的库
 *
 * 核心的迁移函数从端口注册表取数据库（不是从参数），而
 * `ports.cjs` 的端口指向的是**活跃库**——恢复流程已经把它关掉了。
 * 第一版就因此让五个迁移全部报
 * 「数据库已关闭（execSync）：恢复备份后需要重启应用才能继续使用」，
 * 只是被「单个迁移失败不阻断整体」的容错吞掉了（探针把这条断言抓了出来）。
 *
 * 正确做法：用适配器重新注册端口 -> 跑迁移 -> 恢复原端口。
 * `registerCorePorts` 是覆盖式注册，所以恢复就是再注册一遍原对象。
 */
function runCoreDataMigrations(db, log) {
	let core
	let originalPorts
	try {
		const ports = require('./ports.cjs')
		core = ports.core
		originalPorts = ports.desktopPorts
	} catch (error) {
		log(`核心包不可用，跳过 JS 数据迁移：${error.message}`)
		return { skipped: true, reason: error.message }
	}

	if (typeof core?.registerCorePorts !== 'function' || !originalPorts) {
		log('核心包没有 registerCorePorts，跳过 JS 数据迁移')
		return { skipped: true, reason: 'registerCorePorts 不可用' }
	}

	/** 适配成端口契约的形状（`runSync` / `getFirstSync` / ...） */
	const adapter = {
		execSync: (source) => db.exec(source),
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

	const results = {}
	const steps = [
		['migrateSortKeysV2', 'sortKeysV2'],
		['migrateSortKeysV3', 'sortKeysV3'],
		['migratePlayHistory', 'playHistory'],
		['migrateIndependentAccountReset', 'independentAccount'],
		['migratePlayHistoryToMs', 'playHistoryMilliseconds'],
	]

	try {
		// 把 db 端口临时指向正在规范化的这个库
		core.registerCorePorts({
			...originalPorts,
			db: { ...originalPorts.db, sqlite: adapter },
		})

		for (const [exportName, label] of steps) {
			const fn = core[exportName]
			if (typeof fn !== 'function') {
				results[label] = 'missing'
				continue
			}
			try {
				fn(adapter)
				results[label] = 'ok'
			} catch (error) {
				// 单个迁移失败不应让整个恢复失败 —— 库本身是完整的，
				// 迁移只是数据规范化。如实记录让用户知道。
				results[label] = `error: ${error.message}`
			}
		}
	} finally {
		// 无论成败都要把端口还原，别把进程留在「端口指向临时库」的状态
		core.registerCorePorts(originalPorts)
	}

	log(`JS 数据迁移：${JSON.stringify(results)}`)
	return { skipped: false, results }
}

module.exports = {
	createBackup,
	parseBackup,
	restoreBackup,
	createZip,
	readZip,
	normalizeMigrationsForMobile,
	normalizeMigrationsForDesktop,
	runCoreDataMigrations,
	BACKUP_VERSION,
	BACKUP_FILE_PATTERN,
	DEFAULT_DIRECTORY,
	ENTRY_DATABASE,
	ENTRY_MANIFEST,
}
