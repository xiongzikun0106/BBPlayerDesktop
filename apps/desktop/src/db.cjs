/**
 * 桌面端数据库层。
 *
 * schema 与移动端**完全一致**：建表 SQL 直接来自 drizzle 为
 * `packages/core/src/db/schema.ts` 生成的迁移文件（`apps/desktop/drizzle/*.sql`，
 * 从 `apps/mobile/drizzle/` 复制而来）。这样两端数据库文件可以互相打开，
 * 也是 Phase 4 备份互通的前提。
 *
 * 迁移运行器是手写的（不用 drizzle 的 expo 版 migrator，那是 RN 专用的）：
 * 按文件名顺序执行未应用的迁移，用 `__drizzle_migrations` 记录进度。
 */
const fs = require('node:fs')
const path = require('node:path')

const { sqlite } = require('./ports.cjs')

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'drizzle')

/** drizzle 用这个注释分隔同一条迁移里的多条语句 */
const BREAKPOINT = '--> statement-breakpoint'

/**
 * 上游迁移链的缺陷（已通过「改用基线迁移」绕开，保留说明以免后人重踩）。
 *
 * 原链在**空库**上跑不通：
 *   * `0000_productive_joystick.sql` 建的 `artists` 只有
 *     (id, name, avatar_url, signature, created_at)；
 *   * `0002_groovy_maximus.sql` 却 `INSERT INTO __new_artists(... source, remote_id ...)
 *     SELECT ... source, remote_id ... FROM artists`，假设这两列已存在；
 *   * 全仓搜索确认**没有任何迁移**给 `artists` 加过 `source` / `remote_id`；
 *   * `playlists.remote_sync_id` 同样只在 0002 被引用、从未被创建。
 *   → 跑到 0002 必然报 `no such column: "source"`。
 *
 * 处理方式：**不再逐条应用那套增量链**，改用 `drizzle-kit` 从
 * `packages/core/src/db/schema.ts` 生成的**单文件基线**
 * （`apps/desktop/drizzle/0000_baseline.sql`，9 张表 + 全部索引/外键）。
 * 最终 schema 与移动端一致，因此 Phase 4 的备份仍然互通。
 *
 * 注意：本目录的迁移与 `apps/mobile/drizzle/` 是**两条独立的链**，
 * 只保证最终结构一致，不保证迁移历史一致。
 */

function listMigrationFiles() {
	if (!fs.existsSync(MIGRATIONS_DIR)) {
		throw new Error(`[db] 找不到迁移目录：${MIGRATIONS_DIR}`)
	}
	return fs
		.readdirSync(MIGRATIONS_DIR)
		.filter((name) => name.endsWith('.sql'))
		.sort()
}

/** 记录已应用的迁移 */
function ensureMigrationTable() {
	sqlite.execSync(
		'CREATE TABLE IF NOT EXISTS __drizzle_migrations (id TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)',
	)
}

function appliedSet() {
	const rows = sqlite.getAllSync('SELECT id FROM __drizzle_migrations')
	return new Set(rows.map((row) => row.id))
}

/**
 * 应用全部未执行的迁移。返回本次实际执行的迁移列表。
 *
 * 每条迁移在自己的事务里跑；失败会回滚并抛出，避免留下半套 schema。
 * `PRAGMA` 与 `ALTER TABLE` 在 SQLite 里可以参与事务，因此整体回滚是有效的。
 */
function runMigrations() {
	ensureMigrationTable()
	const applied = appliedSet()
	const executed = []

	for (const file of listMigrationFiles()) {
		if (applied.has(file)) continue

		const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
		const statements = raw
			.split(BREAKPOINT)
			.map((s) => s.trim())
			.filter(Boolean)

		sqlite.withTransactionSync(() => {
			for (const statement of statements) {
				sqlite.execSync(statement)
			}
			sqlite.runSync(
				'INSERT INTO __drizzle_migrations (id, applied_at) VALUES (?, ?)',
				[file, Date.now()],
			)
		})

		executed.push(file)
	}

	return { executed }
}

/** 列出所有表（验证用） */
function listTables() {
	return sqlite
		.getAllSync(
			"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
		)
		.map((row) => row.name)
}

// ---------------------------------------------------------------
// 播放列表
// ---------------------------------------------------------------

function generateSortKey(index) {
	// 与移动端一致的思路：用可排序的定长前缀
	// （完整实现应使用 fractional-indexing，这里 Phase 1 用递增前缀即可）
	return `a${String(index).padStart(6, '0')}`
}

/**
 * upsert 作者。
 *
 * `artists` 上有 CHECK 约束：
 *   (source = 'local' AND remote_id IS NULL) OR (source != 'local' AND remote_id IS NOT NULL)
 * 所以带 mid 的用 `bilibili`，没有 mid 的只能落成 `local`（remote_id 必须为 NULL）。
 */
function upsertArtist({ name, remoteId = null }) {
	if (!name) return null
	const existing = sqlite.getFirstSync(
		'SELECT id FROM artists WHERE name = ?',
		[name],
	)
	if (existing) return existing.id

	const source = remoteId ? 'bilibili' : 'local'
	const now = Date.now()
	sqlite.runSync(
		'INSERT INTO artists (name, source, remote_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
		[name, source, remoteId, now, now],
	)
	return sqlite.getFirstSync('SELECT id FROM artists WHERE name = ?', [name]).id
}

function createPlaylist({
	title,
	type = 'local',
	description = null,
	coverUrl = null,
	authorId = null,
	remoteSyncId = null,
}) {
	const now = Date.now()
	sqlite.runSync(
		`INSERT INTO playlists
		   (title, description, cover_url, type, item_count, author_id, remote_sync_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
		[title, description, coverUrl, type, authorId, remoteSyncId, now, now],
	)
	return sqlite.getFirstSync('SELECT * FROM playlists ORDER BY id DESC LIMIT 1')
}

function getPlaylist(id) {
	return sqlite.getFirstSync('SELECT * FROM playlists WHERE id = ?', [id])
}

function listPlaylists() {
	// playlists 本身没有 sort_key（那是 playlist_tracks 的列），按置顶 + 创建时间排
	return sqlite.getAllSync(
		'SELECT * FROM playlists ORDER BY is_pinned DESC, created_at DESC',
	)
}

/** 插入一首 B 站曲目（含 bilibili_metadata），已存在则返回既有记录 */
function upsertTrack({
	uniqueKey,
	title,
	artistName,
	artistRemoteId = null,
	coverUrl,
	duration,
	bvid,
	cid,
	isMultiPage,
}) {
	const existing = sqlite.getFirstSync(
		'SELECT * FROM tracks WHERE unique_key = ?',
		[uniqueKey],
	)
	if (existing) return existing

	const now = Date.now()
	const artistId = upsertArtist({ name: artistName, remoteId: artistRemoteId })

	sqlite.runSync(
		`INSERT INTO tracks (unique_key, title, artist_id, cover_url, duration, source, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 'bilibili', ?, ?)`,
		[uniqueKey, title, artistId, coverUrl, duration, now, now],
	)

	const track = sqlite.getFirstSync(
		'SELECT * FROM tracks WHERE unique_key = ?',
		[uniqueKey],
	)

	// 注意列名是 `main_track_title` / `video_is_valid`，没有 `create_at`
	sqlite.runSync(
		`INSERT INTO bilibili_metadata (track_id, bvid, cid, is_multi_page, video_is_valid)
		 VALUES (?, ?, ?, ?, 1)`,
		[track.id, bvid, cid ?? null, isMultiPage ? 1 : 0],
	)

	return track
}

/**
 * 把曲目挂到播放列表（幂等）。
 *
 * `playlist_tracks` 的主键是 `(playlist_id, track_id)`，所以 `INSERT OR IGNORE`
 * 天然幂等；`item_count` 只在真正插入时累加。
 *
 * 早先这里靠「插入前后各 `COUNT(*)` 一次」判断是否真的插入 —— 对
 * 「同步一个 200 条的收藏夹」是 400 次全表扫描。现在直接用驱动返回的
 * `changes`（node:sqlite 的 `StatementSync.run()` 会给出），一次写就够。
 */
function addTrackToPlaylist(playlistId, trackId, index) {
	const result = sqlite.runSync(
		'INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, sort_key) VALUES (?, ?, ?)',
		[playlistId, trackId, generateSortKey(index)],
	)
	// `changes` 在 node:sqlite 下可能是 number 或 bigint，统一成 number
	const inserted = Number(result?.changes ?? 0) > 0

	if (inserted) {
		sqlite.runSync(
			'UPDATE playlists SET item_count = item_count + 1, updated_at = ? WHERE id = ?',
			[Date.now(), playlistId],
		)
	}
	return inserted
}

/** 读取播放列表里的曲目（按 sort_key） */
function getPlaylistTracks(playlistId) {
	return sqlite.getAllSync(
		`SELECT t.*, pt.sort_key, bm.bvid, bm.cid
		 FROM playlist_tracks pt
		 JOIN tracks t ON t.id = pt.track_id
		 LEFT JOIN bilibili_metadata bm ON bm.track_id = t.id
		 WHERE pt.playlist_id = ?
		 ORDER BY pt.sort_key ASC`,
		[playlistId],
	)
}

// ---------------------------------------------------------------
// 远端来源映射（收藏夹 / UP 合集 -> 本地歌单）
// ---------------------------------------------------------------
//
// 为什么不直接依赖 `playlists.title` 做「已导入」判断（P1 的做法）：
//   1. 用户可能自己改标题，之后就误判成「没导入过」，重复建歌单；
//   2. B 站允许两个收藏夹同名，或一个收藏夹与一个合集同名 —— 会撞车；
//   3. 增量同步需要记住**上次同步到哪一条**，标题给不了这个信息。
//
// 因此把「远端身份」编码进 `playlists.remote_sync_id`。
//
// ## 编码：**幂等键 + 哈希**（不用算术打包）
//
// 直觉做法是 `命名空间 * K + id`。实测两次都被真实数据打脸：
//   * 第一版 `命名空间 + id * 1000 + 后缀` 限制 `id < 1e9` ——
//     真实收藏夹 `media_id` 已到 **4026748432（约 40 亿）**，直接抛错；
//   * 第二版改成 `命名空间 * 1e9 + id` —— 40 亿的收藏夹 id 会**溢出到
//     合集命名空间**，解包出来变成「合集 3026748432」，**静默错包**
//     （被 `verify-bilibili-login.mts` 的往返断言抓住）。
//
// 根因：算术打包要求「命名空间宽度 > 真实 id 上界」，而 B 站 id 空间
// 没有对外承诺的上界，任何固定 K 都可能被将来的 id 越过。
//
// 因此改成**把身份前缀成字符串、再取 53 位哈希**：
//
//   remote_sync_id = 哈希("fav:4026748432")   // 5e15 ~ 2^53 之间
//
// 好处：
//   * 没有「宽度」这个会失效的假设，id 再大也不会溢出；
//   * 空间够大（约 4.5e15 个值），实际歌单数量下碰撞概率可忽略。
// 代价：
//   * 是**哈希**，所以解不出原始 id —— 因此真正的原始 id 单独存进
//     `playlists.description` 的前缀标记里（见 REMOTE_TAG_PREFIX），
//     解包时从那里读回来。这样既不依赖列宽，也不丢信息。
//
// ⚠️ 该值与移动端的语义不同（移动端 `remote_sync_id` 是后端歌单 id），
// 但**列与表都没动**，因此 Phase 4 的数据库互通仍然成立。

const REMOTE_SOURCE = {
	FAVORITE: 'fav',
	SEASON: 'season',
}

/** 描述字段里的来源标记前缀，形如 `[[bb:fav:4026748432]]` */
const REMOTE_TAG_PREFIX = '[[bb:'

/** 把字符串散列成 [5e15, 2^53) 区间的整数（FNV-1a 64 位截断到 53 位） */
function hashToSyncId(input) {
	// FNV-1a 64 位，用 BigInt 保证跨平台一致（不依赖 Node 的 64 位整数运算）
	let hash = 0xcbf29ce484222325n
	const prime = 0x100000001b3n
	const mask = 0xffffffffffffffffn

	for (const byte of Buffer.from(String(input), 'utf8')) {
		hash ^= BigInt(byte)
		hash = (hash * prime) & mask
	}

	// 截到 48 位，再加 5e15 偏移：结果落在 [5e15, 5e15 + 2.8e14)，远小于 2^53
	const sixtyBits = hash & 0xffffffffffffn
	return 5_000_000_000_000_000 + Number(sixtyBits)
}

/**
 * 把「远端来源 + 远端 id」编码成 remote_sync_id。
 *
 * @param {'fav'|'season'} source
 * @param {number|string} remoteId
 */
function encodeRemoteSyncId(source, remoteId) {
	if (!Object.values(REMOTE_SOURCE).includes(source)) {
		throw new Error(
			`未知的远端来源: ${source}（可用：${Object.values(REMOTE_SOURCE).join(', ')}）`,
		)
	}
	const id = String(remoteId)
	if (!/^\d+$/.test(id)) {
		throw new Error(`远端 id 必须是非负整数字符串，收到: ${remoteId}`)
	}
	return hashToSyncId(`${source}:${id}`)
}

/** 生成描述字段里的来源标记 */
function buildRemoteTag(source, remoteId) {
	return `${REMOTE_TAG_PREFIX}${source}:${remoteId}]]`
}

/**
 * 从描述里解析来源标记。
 *
 * @returns {{source: string, remoteId: number}|null}
 */
function parseRemoteTag(description) {
	if (!description) return null
	const match = /\[\[bb:([a-z]+):(\d+)\]\]/.exec(String(description))
	if (!match) return null
	return { source: match[1], remoteId: Number(match[2]) }
}

/**
 * 解包 `remote_sync_id`。
 *
 * 哈希本身不可逆，所以这里只能判断「是不是本模块的编码」（落在我们的
 * 值域里）；**真正的来源与 id 从 `description` 读**（`resolveRemoteSource`）。
 */
function decodeRemoteSyncId(value) {
	if (value === null || value === undefined) return null
	const packed = Number(value)
	if (!Number.isInteger(packed)) return null
	if (
		packed < 5_000_000_000_000_000 ||
		packed >= 5_000_000_000_000_000 + 2 ** 48
	) {
		return null
	}
	return { packed }
}

/**
 * 从一行 playlist 解析出完整的远端身份。
 *
 * @returns {{source: string, remoteId: number}|null}
 */
function resolveRemoteSource(playlist) {
	if (!playlist) return null
	// 只认我们写入的 remote_sync_id 值域，避免把移动端同步来的后端 id 误判成远端歌单
	if (!decodeRemoteSyncId(playlist.remote_sync_id)) return null
	return parseRemoteTag(playlist.description)
}

/**
 * 按远端来源找已导入的本地歌单。
 *
 * @returns {object|null} playlists 行
 */
function findPlaylistByRemote(source, remoteId) {
	const packed = encodeRemoteSyncId(source, remoteId)
	return sqlite.getFirstSync(
		'SELECT * FROM playlists WHERE remote_sync_id = ?',
		[packed],
	)
}

/**
 * 建一个绑定远端来源的歌单；已存在则**复用并更新标题/封面**。
 *
 * 复用而不是新建，是增量同步能一直追加到同一个歌单的前提。
 *
 * @param {object} input
 * @param {string} input.source `REMOTE_SOURCE` 里的值（'fav' | 'season'）
 * @param {number|string} input.remoteId 远端 id
 * @param {string} input.title
 * @param {string|null} [input.description] 用户可见描述；来源标记会追加在后面
 * @param {string|null} [input.coverUrl]
 */
function upsertRemotePlaylist({
	source,
	remoteId,
	title,
	description = null,
	coverUrl = null,
}) {
	const packed = encodeRemoteSyncId(source, remoteId)
	// 来源标记进 description：哈希不可逆，原始 id 只能存在这里。
	// 用数组 join 而不是模板字符串：oxlint 的 restrict-template-expressions
	// 会把「只有 null 默认值的参数」推成 never，进而误报（实测）。
	const tag = buildRemoteTag(source, remoteId)
	const storedDescription = description ? [description, tag].join('\n') : tag

	const existing = findPlaylistByRemote(source, remoteId)

	if (existing) {
		// 远端改了名/换了封面，本地跟着更新；用户改过的标题会被覆盖，
		// 这是刻意的取舍：远端是权威，避免「同步后标题对不上」。
		// `description` 若调用方没传，保留原值（里面存着来源标记）。
		sqlite.runSync(
			`UPDATE playlists
			 SET title = ?, description = ?, cover_url = COALESCE(?, cover_url), updated_at = ?, last_synced_at = ?
			 WHERE id = ?`,
			[
				title,
				description ? storedDescription : existing.description,
				coverUrl,
				Date.now(),
				Date.now(),
				existing.id,
			],
		)
		return { ...getPlaylist(existing.id), created: false }
	}

	const now = Date.now()
	sqlite.runSync(
		`INSERT INTO playlists
		   (title, description, cover_url, type, item_count, remote_sync_id, last_synced_at, created_at, updated_at)
		 VALUES (?, ?, ?, 'bilibili', 0, ?, ?, ?, ?)`,
		[title, storedDescription, coverUrl, packed, now, now, now],
	)
	// node:sqlite 的 runSync 返回 { lastInsertRowid }
	const inserted = sqlite.runSync('SELECT last_insert_rowid() AS id')
	return {
		...getPlaylist(inserted.lastInsertRowid ?? inserted.id),
		created: true,
	}
}

/** 取歌单里已有的 bvid 集合（增量同步时避免重复解析音频） */
function getPlaylistBvids(playlistId) {
	return new Set(
		sqlite
			.getAllSync(
				`SELECT bm.bvid AS bvid
				 FROM playlist_tracks pt
				 JOIN bilibili_metadata bm ON bm.track_id = pt.track_id
				 WHERE pt.playlist_id = ? AND bm.bvid IS NOT NULL`,
				[playlistId],
			)
			.map((row) => row.bvid),
	)
}

/** 取歌单当前的曲目数（用于计算新条目的 sort_key 起始位） */
function countPlaylistTracks(playlistId) {
	const row = sqlite.getFirstSync(
		'SELECT COUNT(*) AS n FROM playlist_tracks WHERE playlist_id = ?',
		[playlistId],
	)
	return row?.n ?? 0
}

/** 批量写歌单元信息（如 last_synced_at / item_count 校正） */
function markPlaylistSynced(playlistId) {
	const count = countPlaylistTracks(playlistId)
	const now = Date.now()
	sqlite.runSync(
		'UPDATE playlists SET last_synced_at = ?, item_count = ?, updated_at = ? WHERE id = ?',
		[now, count, now, playlistId],
	)
	return count
}

module.exports = {
	runMigrations,
	listTables,
	createPlaylist,
	getPlaylist,
	listPlaylists,
	upsertTrack,
	addTrackToPlaylist,
	getPlaylistTracks,
	findPlaylistByRemote,
	upsertRemotePlaylist,
	getPlaylistBvids,
	countPlaylistTracks,
	markPlaylistSynced,
	encodeRemoteSyncId,
	decodeRemoteSyncId,
	buildRemoteTag,
	parseRemoteTag,
	resolveRemoteSource,
	REMOTE_SOURCE,
	REMOTE_TAG_PREFIX,
	MIGRATIONS_DIR,
}
