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
 * 天然幂等；但 `item_count` 需要只在真正插入时累加，故用 changes() 判断。
 */
function addTrackToPlaylist(playlistId, trackId, index) {
	const before = sqlite.getFirstSync(
		'SELECT COUNT(*) AS n FROM playlist_tracks',
	)
	sqlite.runSync(
		'INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, sort_key) VALUES (?, ?, ?)',
		[playlistId, trackId, generateSortKey(index)],
	)
	const after = sqlite.getFirstSync('SELECT COUNT(*) AS n FROM playlist_tracks')
	const inserted = (after?.n ?? 0) > (before?.n ?? 0)

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

module.exports = {
	runMigrations,
	listTables,
	createPlaylist,
	getPlaylist,
	listPlaylists,
	upsertTrack,
	addTrackToPlaylist,
	getPlaylistTracks,
	MIGRATIONS_DIR,
}
