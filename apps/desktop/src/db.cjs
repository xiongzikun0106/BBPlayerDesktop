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

const { sqlite, core } = require('./ports.cjs')

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'drizzle')

/** drizzle 用这个注释分隔同一条迁移里的多条语句 */
const BREAKPOINT = '--> statement-breakpoint'

/**
 * 基线迁移的文件名。
 *
 * 桌面端**不用**上游那套增量链，而是单个基线（原因见下面的说明）。
 * 恢复移动端的备份时需要把这一条记为「已应用」，否则 runner 会重放基线，
 * 而基线里没有任何 `IF NOT EXISTS`，必然 `table artists already exists`。
 */
const BASELINE_MIGRATION = '0000_baseline.sql'

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

	const sortKeys = migrateLegacySortKeys()

	return { executed, sortKeys }
}

// ---------------------------------------------------------------
// 一次性数据迁移：旧版桌面 sort_key 约定 → 跨端统一约定
// ---------------------------------------------------------------
//
// 旧版桌面端生成 `a000001`、`a000002`…（越小越靠前）并按 `ASC` 读取；
// 统一约定是 fractional-indexing 键 + **越大越靠前** + `DESC` 读取。
// 两者的**显示顺序各自都是对的**，所以升级后必须把旧键重写成新键，
// 否则老用户的歌单会整体倒过来。
//
// ## 为什么靠「键的形状」判断，而不是只靠记账表
//
// 恢复备份会**整体替换数据库文件**，记账表跟着备份一起被换掉。如果只信
// 记账表，那么把**移动端**的备份恢复到桌面端之后，这个迁移会以为「没跑过」
// 而把已经正确的 fractional 键按 `ASC` 顺序重新分配一遍 ——
// 恰好把移动端的歌单**全部倒序**。
//
// 因此按歌单逐个体检：只要某个歌单的键**全部**是旧的 `a000000` 形状才重写，
// 出现任何一个新形状（或混合）就整体跳过并留日志。这样「跑没跑过」这件事
// 由数据本身回答，不依赖任何外部标记。

/** 旧版桌面端的 sort_key 形状：`a` + 6 位十进制 */
const LEGACY_SORT_KEY_PATTERN = /^a\d{6}$/

/** 与 core 的 `DataMigration` 共用同一张记账表（表结构一致，只是名字不同） */
const DATA_MIGRATIONS_TABLE = '__bbplayer_data_migrations'
const SORT_KEY_DESKTOP_MIGRATION = 'sort_key_desktop_v1'

function migrateLegacySortKeys() {
	sqlite.execSync(
		`CREATE TABLE IF NOT EXISTS ${DATA_MIGRATIONS_TABLE} (name TEXT PRIMARY KEY NOT NULL)`,
	)

	if (
		sqlite.getFirstSync(
			`SELECT name FROM ${DATA_MIGRATIONS_TABLE} WHERE name = ?`,
			[SORT_KEY_DESKTOP_MIGRATION],
		)
	) {
		return { converted: 0, skipped: 0, alreadyApplied: true }
	}

	let converted = 0
	let skipped = 0
	let rewrittenPlaylists = 0

	sqlite.withTransactionSync(() => {
		const playlists = sqlite.getAllSync('SELECT id FROM playlists')
		for (const playlist of playlists) {
			const rows = sqlite.getAllSync(
				'SELECT track_id, sort_key FROM playlist_tracks WHERE playlist_id = ? ORDER BY sort_key ASC',
				[playlist.id],
			)
			if (rows.length === 0) continue

			if (!rows.every((row) => LEGACY_SORT_KEY_PATTERN.test(row.sort_key))) {
				// 已经是新约定（或混了两种）：不动它 —— 乱动会真的把顺序搞坏
				skipped += 1
				continue
			}

			// 旧约定下 `ASC` 就是显示顺序；新约定要求 index 0 拿最大的键
			const ordered = rows.map((row) => row.track_id)
			const keys = core.generateSortKeySequence(ordered.length)
			for (let i = 0; i < ordered.length; i++) {
				sqlite.runSync(
					'UPDATE playlist_tracks SET sort_key = ? WHERE playlist_id = ? AND track_id = ?',
					[keys[i], playlist.id, ordered[i]],
				)
				converted += 1
			}
			rewrittenPlaylists += 1
		}

		sqlite.runSync(
			`INSERT OR IGNORE INTO ${DATA_MIGRATIONS_TABLE} (name) VALUES (?)`,
			[SORT_KEY_DESKTOP_MIGRATION],
		)

		// **同时**把 core 的 `sort_key_v3` 记成已完成。
		//
		// `sortKeysV3` 的语义是「把非 local 歌单的 sort_key 从旧方向翻转成
		// fractional + DESC」。桌面端这一次迁移是**对全部歌单**达成同一个
		// 不变式，因此 v3 的目标已经满足 —— 而且**不能再让它跑**：
		// 导出备份时 `backup.cjs` 会在副本上调用 v3，如果不记账，
		// 它会把这些**已经正确**的非 local 歌单再翻一次，直接翻坏。
		//
		// 记账表的含义是「该不变式已成立」，不是「这段代码逐行执行过」，
		// 所以这样写是准确的。
		for (const name of ['sort_key_v2', 'sort_key_v3']) {
			sqlite.runSync(
				`INSERT OR IGNORE INTO ${DATA_MIGRATIONS_TABLE} (name) VALUES (?)`,
				[name],
			)
		}
	})

	return { converted, skipped, rewrittenPlaylists, alreadyApplied: false }
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

/**
 * 追加到歌单**末尾**所需的 sort_key。
 *
 * 约定由 `packages/core/src/utils/sortKey.ts` 唯一定义（**越大越靠前**，
 * 读取用 `DESC`）。桌面端此前是自写的 `a${index}` + `ASC`，方向与移动端
 * **完全相反** —— 单端看不出问题，但备份是整库搬家，移动端按 `DESC` 读
 * 就会把整单倒过来。详见 `scripts/verify-sortkey-interop.mts`。
 *
 * 这里保留「新加的落在末尾」这个**用户可见行为**（旧实现即如此），
 * 用 `generateKeyForBottom` 取一个比现有最小键更小的键。
 */
function generateSortKey(playlistId) {
	const bottom = sqlite.getFirstSync(
		'SELECT MIN(sort_key) AS key FROM playlist_tracks WHERE playlist_id = ?',
		[playlistId],
	)
	return core.generateKeyForBottom(bottom?.key ?? null)
}

/**
 * 歌单内**重排一首曲目**（用户明确要求的功能：更改列表顺序）。
 *
 * ## 为什么整表重写，而不是只算相邻两个键
 *
 * 表上用 `sort_key` 做 **fractional indexing**，理论上"移到两项之间"只需要
 * 算一个新键（`generateKeyBetweenPositions`）。但那个接口要求调用方传
 * **字典序的下界与上界**，而本仓库的约定是「**键越大越靠前**」——
 * 视觉上的"前一项"反而是**上界**。传反了会抛 `Invalid key order`。
 *
 * 这里选择**整表重写**：读出现有顺序 → 内存里 splice → 用
 * `generateSortKeySequence` 重新发一遍键。理由：
 *   * 语义**显然正确**，不需要每个调用方都理解键方向的约定；
 *   * 歌单是几百首量级，一次事务里几百条 UPDATE 是毫秒级；
 *   * 不会出现"反复往同一位置插导致键越来越长"的长尾问题。
 *
 * 以后真有上万首的歌单，再换成只算相邻键的版本。
 *
 * @param {number} playlistId
 * @param {number} from 原下标
 * @param {number} to 目标下标（移动后所在位置）
 * @returns {{ok: boolean, reason?: string, moved?: boolean}}
 */
function movePlaylistTrack(playlistId, from, to) {
	const rows = sqlite.getAllSync(
		'SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY sort_key DESC',
		[playlistId],
	)
	if (from < 0 || from >= rows.length) return { ok: false, reason: 'from' }
	if (to < 0 || to >= rows.length) return { ok: false, reason: 'to' }
	if (from === to) return { ok: true, moved: false }

	const ids = rows.map((row) => row.track_id)
	const [moved] = ids.splice(from, 1)
	ids.splice(to, 0, moved)

	// ⚠️ 顺序约定：**下标 0 拿最大的键**（见文件顶部的迁移注释，以及
	// `getPlaylistTracks` 的 `ORDER BY sort_key DESC`）。
	// `generateSortKeySequence` 已按这个约定生成，顺序赋值即可。
	const keys = core.generateSortKeySequence(ids.length)
	sqlite.withTransactionSync(() => {
		for (let i = 0; i < ids.length; i++) {
			sqlite.runSync(
				'UPDATE playlist_tracks SET sort_key = ? WHERE playlist_id = ? AND track_id = ?',
				[keys[i], playlistId, ids[i]],
			)
		}
	})
	return { ok: true, moved: true }
}

/**
 * upsert 作者。
 *
 * `artists` 上有 CHECK 约束：
 *   (source = 'local' AND remote_id IS NULL) OR (source != 'local' AND remote_id IS NOT NULL)
 * 所以带 mid 的用 `bilibili`，没有 mid 的只能落成 `local`（remote_id 必须为 NULL）。
 *
 * ## 为什么先按 `(source, remote_id)` 查，再按 `name` 查
 *
 * 早先只按 `name` 查，然后无条件 INSERT —— 一旦**同一个 UP 改过名**（B 站很常见）
 * 或同一首曲目先以名字 A 落库、后又以名字 B 带着同一个 mid 出现，
 * 就会撞上 `source_remote_id_unq` 唯一索引并**抛异常**，整批导入失败。
 * 带 mid 时 mid 才是身份，名字只是显示用的属性，所以先按 mid 找。
 */
function upsertArtist({ name, remoteId = null }) {
	if (!name) return null

	if (remoteId) {
		const byRemoteId = sqlite.getFirstSync(
			"SELECT id FROM artists WHERE source != 'local' AND remote_id = ?",
			[String(remoteId)],
		)
		if (byRemoteId) return byRemoteId.id
	}

	const byName = sqlite.getFirstSync('SELECT id FROM artists WHERE name = ?', [
		name,
	])
	if (byName) return byName.id

	const source = remoteId ? 'bilibili' : 'local'
	const now = Date.now()
	// `OR IGNORE` 兜住并发/重入：真的撞上唯一索引时，下面的 SELECT 仍能取回那一行
	sqlite.runSync(
		'INSERT OR IGNORE INTO artists (name, source, remote_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
		[name, source, remoteId === null ? null : String(remoteId), now, now],
	)

	if (remoteId) {
		const inserted = sqlite.getFirstSync(
			"SELECT id FROM artists WHERE source != 'local' AND remote_id = ?",
			[String(remoteId)],
		)
		if (inserted) return inserted.id
	}
	return (
		sqlite.getFirstSync('SELECT id FROM artists WHERE name = ?', [name])?.id ??
		null
	)
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
	/*
	 * playlists 本身没有 sort_key（那是 playlist_tracks 的列），按置顶 + 创建时间排。
	 *
	 * ⚠️ `cover_url` 用 `COALESCE(自己的, 第一首曲目的)`：
	 * 用户要求"没设封面就默认用**第一个视频**的封面"。
	 * * "第一个视频" = 播放列表里显示在最上面的那一首 —— 本仓库的约定是
	 *   `sort_key` **越大越靠前**（见 `getPlaylistTracks` 的 `ORDER BY sort_key DESC`），
	 *   所以子查询取 `sort_key DESC LIMIT 1`。
	 * * 自己设过封面就以自己的为准（自定义优先于默认）。
	 */
	return sqlite.getAllSync(
		`SELECT p.*,
		        COALESCE(
		          p.cover_url,
		          (SELECT t.cover_url
		             FROM playlist_tracks pt
		             JOIN tracks t ON t.id = pt.track_id
		            WHERE pt.playlist_id = p.id
		              AND t.cover_url IS NOT NULL
		              AND t.cover_url != ''
		            ORDER BY pt.sort_key DESC
		            LIMIT 1)
		        ) AS cover_url
		   FROM playlists p
		  ORDER BY p.is_pinned DESC, p.created_at DESC`,
	)
}

/** 设置 / 清除歌单封面（`coverUrl = null` 即恢复默认 = 第一首曲目的封面） */
function setPlaylistCover(playlistId, coverUrl) {
	const result = sqlite.runSync(
		'UPDATE playlists SET cover_url = ?, updated_at = ? WHERE id = ?',
		[coverUrl ?? null, Date.now(), playlistId],
	)
	return Number(result?.changes ?? 0) > 0
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
	/*
	 * ⚠️ 命中已有行**不能直接 `return existing`** —— 那样它根本不是 upsert。
	 *
	 * 原来的写法就是直接 return，后果是：一首歌只要**第一次**以"没有封面 /
	 * 没有作者 / 时长为 0"的方式落库（不同的导入路径带的字段不一样），
	 * 后面即使接口明确返回了这些字段也**永远不会补上** —— 重新导入也没用。
	 * 用户看到的就是"曲目表的封面全是标题首字"，而且怎么折腾都不变。
	 *
	 * 只补**原值为空、新值非空**的字段：不覆盖已有数据（已有值可能是用户
	 * 自己的选择，或来自更可信的来源）。
	 */
	if (existing) {
		const patches = []
		const args = []
		if (coverUrl && !existing.cover_url) {
			patches.push('cover_url = ?')
			args.push(coverUrl)
		}
		if (duration && !existing.duration) {
			patches.push('duration = ?')
			args.push(duration)
		}
		if (!existing.artist_id && artistName) {
			const artistId = upsertArtist({
				name: artistName,
				remoteId: artistRemoteId,
			})
			if (artistId) {
				patches.push('artist_id = ?')
				args.push(artistId)
			}
		}
		if (patches.length > 0) {
			patches.push('updated_at = ?')
			args.push(Date.now())
			sqlite.runSync(`UPDATE tracks SET ${patches.join(', ')} WHERE id = ?`, [
				...args,
				existing.id,
			])
		}

		// 老行可能没有 bilibili_metadata（由别的路径插入的）—— 没有它就没有
		// bvid，播放与"按 bvid 找曲目"都会失效，这里顺手补上
		if (bvid) {
			// ⚠️ `bilibili_metadata` 的主键是 `track_id`，**没有 `id` 列**
			// （第一版写成 `SELECT id FROM bilibili_metadata` → 一条已有曲目
			// 再导入时直接 `no such column: id`，"加入歌单"整条路径报错）
			const meta = sqlite.getFirstSync(
				'SELECT track_id FROM bilibili_metadata WHERE track_id = ?',
				[existing.id],
			)
			if (!meta) {
				sqlite.runSync(
					`INSERT INTO bilibili_metadata (track_id, bvid, cid, is_multi_page, video_is_valid)
					 VALUES (?, ?, ?, ?, 1)`,
					[existing.id, bvid, cid ?? null, isMultiPage ? 1 : 0],
				)
			}
		}

		return sqlite.getFirstSync('SELECT * FROM tracks WHERE id = ?', [
			existing.id,
		])
	}

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
function addTrackToPlaylist(playlistId, trackId) {
	const result = sqlite.runSync(
		'INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, sort_key) VALUES (?, ?, ?)',
		[playlistId, trackId, generateSortKey(playlistId)],
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

/**
 * 把若干曲目加入某个歌单（阶段 6c「添加到歌单」的写库路径）。
 *
 * ## 语义（与移动端对齐）
 *
 * * **重复静默忽略** —— `addTrackToPlaylist` 底层是 `INSERT OR IGNORE`，
 *   与移动端 `playlistService` 的 `onConflictDoNothing` 同一个语义：
 *   不报错、也不重复添加。这里把 `added` / `skipped` 分开报，
 *   好让 UI 能说清「新增 3 首，2 首已在歌单里」，而不是笼统的"添加成功"
 *   （移动端那条"添加成功"就是信息量不够的例子）。
 * * **追加到末尾** —— `generateSortKey` 取比现有最小键更小的键。
 * * 新曲目走 `upsertTrack`，`unique_key` 用 `bilibili::BVxxx` ——
 *   与既有导入路径**同一个约定**，所以同一首歌从两个入口进来不会变成两条。
 *
 * ⚠️ 整批放在**一个事务**里：中途失败不能留下"加了一半"的歌单。
 * ⚠️ 事务与 DB 细节留在这一层 —— IPC 层不该编排事务。
 *
 * @param {number} playlistId
 * @param {Array<{bvid: string, title?: string, artist?: string, upperName?: string,
 *   artistMid?: number|null, cover?: string|null, duration?: number, cid?: number|null}>} items
 * @returns {{added: number, skipped: number, total: number}}
 */
function addTracksToPlaylist(playlistId, items) {
	const list = Array.isArray(items) ? items : []
	if (!playlistId) throw new Error('缺少 playlistId')
	if (list.length === 0) throw new Error('没有要添加的曲目')

	let added = 0
	let skipped = 0
	sqlite.withTransactionSync(() => {
		for (const item of list) {
			// 没有 bvid 的条目（例如失效视频）静默跳过，不算失败
			if (!item?.bvid) continue
			const track = upsertTrack({
				uniqueKey: `bilibili::${item.bvid}`,
				title: item.title ?? '(无标题)',
				artistName: item.artist ?? item.upperName ?? '未知作者',
				artistRemoteId: item.artistMid ?? null,
				coverUrl: item.cover ?? null,
				duration: item.duration ?? 0,
				bvid: item.bvid,
				cid: item.cid ?? null,
				isMultiPage: false,
			})
			if (addTrackToPlaylist(playlistId, track.id)) added += 1
			else skipped += 1
		}
	})
	return { added, skipped, total: list.length }
}

/**
 * 从播放列表里移除一首曲目（幂等），并重算 `item_count`。
 *
 * 共享歌单需要这个动作来驱动 outbox（`remove_tracks`），因此**不在这里**
 * 顺手写 outbox —— 数据库层不认识共享语义，由 `shared-playlist.cjs` 的调用方
 * 决定是否入队，避免 db 层反向依赖共享模块。
 */
function removeTrackFromPlaylist(playlistId, trackId) {
	const result = sqlite.runSync(
		'DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?',
		[playlistId, trackId],
	)
	const removed = Number(result?.changes ?? 0) > 0
	if (removed) {
		sqlite.runSync(
			`UPDATE playlists
			 SET item_count = (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = ?), updated_at = ?
			 WHERE id = ?`,
			[playlistId, Date.now(), playlistId],
		)
	}
	return removed
}

/**
 * 读取播放列表里的曲目（按 sort_key）。
 *
 * ⚠️ **必须 join `artists`**：`tracks` 表里存的是外键 `artist_id`，
 * 作者名字在 `artists.name`。只返回 `t.*` 的话，作者名根本不在结果里，
 * 界面上的「作者」列就永远是「—」—— 用户明确抱怨过这一条
 * （「你没有拉取到作者信息」）。
 *
 * 这与收藏夹预览那条路径**是两回事**：那边是 B 站接口直接给的
 * `media.upper.name`（映射成 `upperName`），字段名不同但都是"作者"，
 * 渲染层两个都认。这里是**数据库路径**，从前一条注释里漏了 join，
 * 所以两个字段名都没有 —— 那是"永远「—」"的真正原因。
 */
function getPlaylistTracks(playlistId) {
	return sqlite.getAllSync(
		`SELECT t.*, a.name AS artist_name, pt.sort_key, bm.bvid, bm.cid
		 FROM playlist_tracks pt
		 JOIN tracks t ON t.id = pt.track_id
		 LEFT JOIN artists a ON a.id = t.artist_id
		 LEFT JOIN bilibili_metadata bm ON bm.track_id = t.id
		 WHERE pt.playlist_id = ?
		 ORDER BY pt.sort_key DESC`,
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
	/** 外部歌单导入（Phase 3.3）：网易云 / QQ 等。哈希里带平台前缀时用这个值 */
	NETEASE: 'netease',
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

// ---------------------------------------------------------------
// 播放历史（Phase 3.5）
// ---------------------------------------------------------------
//
// `play_history` 是共用 schema 里的表，但桌面端此前**只建表、从不写入**
// （移动端的 playHistory.ts 也查不到调用点）。这里把它接上。
//
// ## 一条记录 = 一次「播放会话」
//
// 语义与移动端一致（`start_time` 是**毫秒**时间戳 —— 移动端有
// `migratePlayHistoryToMs` 把早期的秒值迁成毫秒，桌面端从一开始就用毫秒）：
//
//   * 开始播放一首 -> 插入一行（`duration_played = 0`，`completed = 0`）
//   * 播放中定期更新 `duration_played`
//   * 播完（或切歌）时定稿：`completed` 表示「听到了结尾」
//
// ## 为什么不每首歌只留一行
//
// 「同一首歌听了 10 次」是有用信息（用于「最常播放」），而只留一行就丢失了。
// 因此按「会话」记录，需要聚合时按 `track_id` group。

/**
 * 开始一次播放会话，返回该行的 id。
 *
 * @param {number} trackId
 * @param {number} [startTime] 毫秒时间戳；默认现在
 * @returns {number} play_history.id
 */
function startPlaySession(trackId, startTime = Date.now()) {
	const result = sqlite.runSync(
		'INSERT INTO play_history (track_id, start_time, duration_played, completed) VALUES (?, ?, 0, 0)',
		[trackId, startTime],
	)
	// node:sqlite 的 run() 返回 { changes, lastInsertRowid }
	return Number(result?.lastInsertRowid ?? 0)
}

/**
 * 更新一次会话的已播时长。
 *
 * 播放中会高频调用（每几秒一次），所以只做一条 UPDATE —— 不要在这里做
 * 「先查再写」那种两次往返。`duration_played` 取**最大值**而不是累加：
 * 调用方传的是「本次会话累计已播秒数」，取 max 可以容忍乱序/重复调用
 * （例如暂停后又恢复、或者同一位置被上报两次）。
 */
function updatePlaySession(
	historyId,
	durationPlayedSeconds,
	completed = false,
) {
	if (!historyId) return false
	sqlite.runSync(
		`UPDATE play_history
		 SET duration_played = MAX(duration_played, ?),
		     completed = CASE WHEN ? = 1 THEN 1 ELSE completed END
		 WHERE id = ?`,
		[
			Math.max(0, Math.round(durationPlayedSeconds)),
			completed ? 1 : 0,
			historyId,
		],
	)
	return true
}

/**
 * 最近播放的曲目（按会话去重，同一首歌只出现一次）。
 *
 * 用 `GROUP BY track_id` + `MAX(start_time)` 而不是 `DISTINCT`：
 * 我们要的是「每首歌最后一次播的时间」用于排序，同时带上历史次数。
 */
function listRecentlyPlayed({ limit = 50 } = {}) {
	return sqlite.getAllSync(
		`SELECT
		   t.*,
		   bm.bvid,
		   bm.cid,
		   MAX(ph.start_time) AS last_played_at,
		   COUNT(*) AS play_count,
		   MAX(ph.completed) AS ever_completed
		 FROM play_history ph
		 JOIN tracks t ON t.id = ph.track_id
		 LEFT JOIN bilibili_metadata bm ON bm.track_id = t.id
		 GROUP BY ph.track_id
		 ORDER BY last_played_at DESC
		 LIMIT ?`,
		[limit],
	)
}

/**
 * 最常播放的曲目。
 *
 * 只统计「有效播放」（`duration_played >= 30` 秒）—— 否则「点了就切」的
 * 误触会把排行冲乱。这个阈值与流媒体平台的惯例一致。
 */
function listMostPlayed({ limit = 50, minSeconds = 30 } = {}) {
	return sqlite.getAllSync(
		`SELECT
		   t.*,
		   bm.bvid,
		   bm.cid,
		   COUNT(*) AS play_count,
		   MAX(ph.start_time) AS last_played_at,
		   SUM(ph.duration_played) AS total_played_seconds
		 FROM play_history ph
		 JOIN tracks t ON t.id = ph.track_id
		 LEFT JOIN bilibili_metadata bm ON bm.track_id = t.id
		 WHERE ph.duration_played >= ?
		 GROUP BY ph.track_id
		 ORDER BY play_count DESC, last_played_at DESC
		 LIMIT ?`,
		[minSeconds, limit],
	)
}

/** 某首歌的播放统计；未播放过返回零值 */
function getTrackPlayStats(trackId) {
	const row = sqlite.getFirstSync(
		`SELECT COUNT(*) AS play_count,
		        MAX(start_time) AS last_played_at,
		        SUM(duration_played) AS total_played_seconds,
		        MAX(completed) AS ever_completed
		 FROM play_history WHERE track_id = ?`,
		[trackId],
	)
	return {
		playCount: Number(row?.play_count ?? 0),
		lastPlayedAt: row?.last_played_at ?? null,
		totalPlayedSeconds: Number(row?.total_played_seconds ?? 0),
		everCompleted: Boolean(row?.ever_completed),
	}
}

/**
 * 「继续收听」：最近播放过、但**没听完**的曲目。
 *
 * 这是播放历史最有用的一个派生视图 —— 移动端的 `play_history` 也主要用于
 * 恢复上次的进度。返回带 `last_position_seconds`（该会话已播到的位置），
 * 调用方据此 seek。
 */
function listResumeCandidates({ limit = 20, minSeconds = 10 } = {}) {
	return sqlite.getAllSync(
		`SELECT
		   t.*,
		   bm.bvid,
		   bm.cid,
		   ph.duration_played AS last_position_seconds,
		   ph.start_time AS last_played_at
		 FROM play_history ph
		 JOIN tracks t ON t.id = ph.track_id
		 LEFT JOIN bilibili_metadata bm ON bm.track_id = t.id
		 WHERE ph.completed = 0
		   AND ph.duration_played >= ?
		   AND t.duration > 0
		   -- 只保留「确实没听完」的：已播时长明显小于总时长
		   AND ph.duration_played < t.duration - 15
		   -- 只取每首歌最后一次会话
		   AND ph.start_time = (
		     SELECT MAX(inner_ph.start_time) FROM play_history inner_ph
		     WHERE inner_ph.track_id = ph.track_id
		   )
		 ORDER BY ph.start_time DESC
		 LIMIT ?`,
		[minSeconds, limit],
	)
}

/**
 * 听歌频率热力图的数据：**按本地日期**分组计数。
 *
 * ⚠️ 必须按 `localtime` 分组，不能用 UTC：`start_time` 存的是毫秒时间戳，
 * 若按 UTC 切天，晚上 8 点之后听的歌会算到"第二天"—— 用户看到的格子会
 * 整体右移一天，而且他自己没法察觉哪里不对。
 * 移动端查的是同一句 `date(start_time / 1000, 'unixepoch', 'localtime')`。
 *
 * @returns {Record<string, number>} `{ 'YYYY-MM-DD': 次数 }`
 */
function listPlayHistoryByDate() {
	const rows = sqlite.getAllSync(
		`SELECT date(start_time / 1000, 'unixepoch', 'localtime') AS date,
		        COUNT(*) AS count
		 FROM play_history
		 GROUP BY date`,
	)
	const byDate = {}
	for (const row of rows) {
		if (row.date) byDate[row.date] = Number(row.count)
	}
	return byDate
}

/**
 * 某一天（本地日期）听过的曲目。
 *
 * 热力图每一格**可点**就是落到这里 —— 移动端点一格是跳到
 * `/history/YYYY-MM-DD`，桌面端没有那个路由，所以直接把当天的会话查出来
 * 用同一张表渲染。
 *
 * ⚠️ 与 `listRecentTracks` 的区别：那个是"每首歌只出现一次、按最后一次播放
 * 排序"，所以**同一天听了两遍只算一条**。热力图点进来的语义是"那天听了什么"，
 * 所以这里按**会话**返回（同一天听两遍就是两行）—— 否则格子里的数字
 * 与表里的行数对不上，用户会以为记录丢了。
 */
function listPlayHistoryForDay(dateStr, { limit = 200 } = {}) {
	return sqlite.getAllSync(
		`SELECT t.*, a.name AS artist_name, bm.bvid, bm.cid,
		        ph.start_time AS last_played_at,
		        ph.duration_played AS last_position_seconds,
		        1 AS play_count
		 FROM play_history ph
		 JOIN tracks t ON t.id = ph.track_id
		 LEFT JOIN artists a ON a.id = t.artist_id
		 LEFT JOIN bilibili_metadata bm ON bm.track_id = t.id
		 WHERE date(ph.start_time / 1000, 'unixepoch', 'localtime') = ?
		 ORDER BY ph.start_time DESC
		 LIMIT ?`,
		[dateStr, limit],
	)
}

/**
 * 按 bvid 补一条曲目的封面（只补空值，不覆盖已有封面）。
 *
 * ⚠️ 只在 `cover_url` 为空时写：已有封面可能是用户自定义的，或来自更可信的来源。
 * @returns {number} 真正改动的行数
 */
function updateTrackCoverByBvid(bvid, coverUrl) {
	if (!bvid || !coverUrl) return 0
	const result = sqlite.runSync(
		`UPDATE tracks SET cover_url = ?, updated_at = ?
		 WHERE (cover_url IS NULL OR cover_url = '')
		   AND id = (SELECT track_id FROM bilibili_metadata WHERE bvid = ?)`,
		[coverUrl, Date.now(), String(bvid)],
	)
	return Number(result?.changes ?? 0)
}

/** 找出**缺封面**的曲目（按 bvid 去重，供后台回填） */
function listTracksMissingCover({ limit = 200 } = {}) {
	return sqlite.getAllSync(
		`SELECT bm.bvid
		 FROM tracks t
		 JOIN bilibili_metadata bm ON bm.track_id = t.id
		 WHERE (t.cover_url IS NULL OR t.cover_url = '')
		   AND bm.bvid IS NOT NULL
		 GROUP BY bm.bvid
		 LIMIT ?`,
		[limit],
	)
}

/** 汇总统计（用于界面上的概览） */
function getPlayHistorySummary() {
	const row = sqlite.getFirstSync(
		`SELECT COUNT(*) AS session_count,
		        COUNT(DISTINCT track_id) AS track_count,
		        SUM(duration_played) AS total_seconds,
		        MIN(start_time) AS first_played_at,
		        MAX(start_time) AS last_played_at
		 FROM play_history`,
	)
	return {
		sessionCount: Number(row?.session_count ?? 0),
		trackCount: Number(row?.track_count ?? 0),
		totalSeconds: Number(row?.total_seconds ?? 0),
		firstPlayedAt: row?.first_played_at ?? null,
		lastPlayedAt: row?.last_played_at ?? null,
	}
}

/**
 * 按 bvid 找本地曲目 id。
 *
 * 播放历史要用它：播放器只有 `bvid`（它操作的是队列项），而
 * `play_history.track_id` 要的是 `tracks.id`。没有这个映射，
 * 「记录播放」就得在渲染进程里多带一个 id，而那会让队列项的形状
 * 依赖「这首歌是否已落库」—— 搜索结果的曲目还没落库。
 *
 * @returns {number|null}
 */
function findTrackIdByBvid(bvid) {
	if (!bvid) return null
	const row = sqlite.getFirstSync(
		'SELECT track_id FROM bilibili_metadata WHERE bvid = ? LIMIT 1',
		[bvid],
	)
	return row?.track_id ?? null
}

/** 清空播放历史（只删历史，不动曲目与歌单） */
function clearPlayHistory() {
	const result = sqlite.runSync('DELETE FROM play_history')
	return Number(result?.changes ?? 0)
}

module.exports = {
	runMigrations,
	listTables,
	createPlaylist,
	getPlaylist,
	listPlaylists,
	upsertTrack,
	addTrackToPlaylist,
	addTracksToPlaylist,
	removeTrackFromPlaylist,
	/** 歌单内重排（更改列表顺序），见函数头注释 */
	movePlaylistTrack,
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
	startPlaySession,
	updatePlaySession,
	listRecentlyPlayed,
	listMostPlayed,
	listResumeCandidates,
	listPlayHistoryByDate,
	updateTrackCoverByBvid,
	listTracksMissingCover,
	setPlaylistCover,
	listPlayHistoryForDay,
	getTrackPlayStats,
	getPlayHistorySummary,
	findTrackIdByBvid,
	clearPlayHistory,
	REMOTE_SOURCE,
	REMOTE_TAG_PREFIX,
	BASELINE_MIGRATION,
	MIGRATIONS_DIR,
}
