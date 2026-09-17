/**
 * 共享歌单（Phase 3.4）
 *
 * 与移动端 `apps/mobile/src/lib/facades/sharedPlaylist.ts` **语义对齐**，
 * 但按桌面端的形态重写（移动端那份依赖 drizzle + neverthrow + zustand，
 * 桌面端用的是 node:sqlite 与同步事务）。
 *
 * ## 数据在哪
 *
 * | 东西 | 位置 |
 * | --- | --- |
 * | 账号 / JWT | `bbplayer-account.cjs`（`bbplayer-account.json`） |
 * | 歌单与曲目 | 本地 SQLite，和普通歌单**同一批表** |
 * | 共享状态 | `playlists.share_id` / `share_role` / `last_share_sync_at` |
 * | 待推送的本地改动 | `playlist_sync_queue`（outbox） |
 *
 * 这些列与表**本来就在基线 schema 里**（与移动端同源），所以这里不需要新迁移。
 *
 * ## 同步协议（读后端的代码得到，不是猜的）
 *
 * 1. **建共享时一次性全量上传**：`POST /playlists` 的 body 直接带
 *    `tracks: [{track, sort_key}]`，服务端在一个事务里建歌单 + 写 owner 成员 +
 *    写曲目。**不经过 outbox**。
 * 2. **之后的本地改动进 outbox**，由 `flushOutbox` 成批发成
 *    `POST /playlists/:id/changes`。
 * 3. **增量拉取**用 `last_share_sync_at` 当 `since` 游标（**服务端时钟**，
 *    单位毫秒）。首次订阅用 `since=0` 全量拉。
 * 4. **冲突解决在服务端**（LWW，按 `operation_at`）。客户端**不做**时间戳比较
 *    —— 服务端已经把结果算好了，本地照着写就行。
 *
 * ## 三个必须记住的协议细节（踩过才知道）
 *
 * 1. **写用 `remove`，读回是 `delete`。** `POST /changes` 的校验器只认
 *    `op: 'remove'`，而 `GET /changes` 返回的 `op` 是 `'delete'`。
 *    当成同一个词写会在「拉回来的删除被当成未知 op」处静默丢掉。
 * 2. **`track_count` 是字符串。** Postgres 的 `count(*)` 走 `pg` 回来是 bigint
 *    字符串，路由原样透出。断言 `=== 1` 会永远失败。
 * 3. **集合路径不能带尾斜杠。** Hono 的路由是 strict 的，
 *    `POST /playlists/` 是 **404**，`POST /playlists` 才是 201。
 *
 * ## 与移动端的**有意的差异**
 *
 * - 移动端在「订阅」时如果本地已经有同 `share_id` 的行就直接返回 —— 于是
 *   「用邀请码升级为编辑者」这条路径**永远走不到**（它的按钮在 UI 上存在，
 *   但函数提前 return 了）。桌面端把「已存在」当成「补一次 subscribe 请求」：
 *   邀请码匹配时服务端会把 subscriber 升成 editor，这正是用户点那个按钮的意图。
 * - 移动端拉取时用**重新生成**的 `unique_key` 去查本地曲目（
 *   `isMultiPage = !!bilibili_cid`），服务端给的键只要和重新生成的差一点就被
 *   **静默丢弃**。桌面端**以服务端给的 `unique_key` 为准**（它就是身份），
 *   只在写 `bilibili_metadata` 时解析出 bvid。
 */

const { sqlite, logger } = require('./ports.cjs')

/** 桌面端把这个后端能力叫「共享」；role 的取值与后端 enum 一致 */
const ROLES = ['owner', 'editor', 'subscriber']

/** 可以写（增删改曲目）的角色 */
const WRITABLE_ROLES = new Set(['owner', 'editor'])

/** 分享链接的官方形态（移动端 `share/playlist.tsx` 生成的链接） */
const SHARE_LINK_ORIGIN = 'https://bbplayer.roitium.com'

/** 后端 uuid 的形状 */
const SHARE_ID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const OUTBOX_OPERATIONS = new Set([
	'add_tracks',
	'remove_tracks',
	'reorder_track',
	'update_metadata',
])

// ---------------------------------------------------------------
// 纯函数（离线可测）
// ---------------------------------------------------------------

/**
 * 从「分享链接 / 裸 uuid / 带邀请码的链接」里解析出 `{shareId, inviteCode}`。
 *
 * 链接里的 **query 参数优先于路径**：官方链接是
 * `…/share/playlist?shareId=<uuid>&inviteCode=<code>`，而 uuid 也出现在路径里时
 * 两者应当一致；真不一致时以显式声明的 `shareId` 为准。
 */
function parseShareInput(input) {
	const raw = String(input ?? '').trim()
	if (!raw)
		return { shareId: null, inviteCode: null, error: '请输入分享链接或 ID' }

	// 裸 uuid
	if (SHARE_ID_RE.test(raw))
		return { shareId: raw.toLowerCase(), inviteCode: null }

	// 带 scheme 或形似 URL 的
	let url = null
	try {
		url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
	} catch {
		url = null
	}

	if (url) {
		const queryShareId =
			url.searchParams.get('shareId') ?? url.searchParams.get('share_id')
		const queryInvite =
			url.searchParams.get('inviteCode') ?? url.searchParams.get('invite_code')
		if (queryShareId && SHARE_ID_RE.test(queryShareId.trim())) {
			return {
				shareId: queryShareId.trim().toLowerCase(),
				inviteCode: queryInvite?.trim() || null,
			}
		}
		// 路径里找 uuid
		const inPath = url.pathname
			.split('/')
			.find((part) => SHARE_ID_RE.test(part))
		if (inPath) {
			return {
				shareId: inPath.toLowerCase(),
				inviteCode: queryInvite?.trim() || null,
			}
		}
	}

	// 整段文本里捞 uuid（用户常常连着一句分享文案一起粘贴）
	const loose = raw.match(
		/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
	)
	if (loose) return { shareId: loose[0].toLowerCase(), inviteCode: null }

	return {
		shareId: null,
		inviteCode: null,
		error: '没认出分享 ID（应当是一段形如 8-4-4-4-12 的十六进制）',
	}
}

/** 从 `bilibili::<bvid>` 或 `bilibili::<bvid>::<cid>` 里取 bvid */
function bvidFromUniqueKey(uniqueKey) {
	const parts = String(uniqueKey ?? '').split('::')
	return parts.length >= 2 && parts[1] ? parts[1] : null
}

/** 生成的分享链接（与移动端同一个站点，扫码/粘贴都能用） */
function buildShareLink(shareId, inviteCode) {
	const url = new URL('/share/playlist', SHARE_LINK_ORIGIN)
	url.searchParams.set('shareId', shareId)
	if (inviteCode) url.searchParams.set('inviteCode', inviteCode)
	return url.toString()
}

// ---------------------------------------------------------------
// 本地库
// ---------------------------------------------------------------

/** 读歌单行 */
function getPlaylistRow(playlistId) {
	return sqlite.getFirstSync('SELECT * FROM playlists WHERE id = ?', [
		playlistId,
	])
}

/** 按 `share_id` 找本地歌单 */
function findPlaylistByShareId(shareId) {
	return sqlite.getFirstSync('SELECT * FROM playlists WHERE share_id = ?', [
		shareId,
	])
}

/**
 * 上传/订阅时要发出去的曲目快照。
 *
 * 只取 `source='bilibili'` **且有 bvid** 的行 —— 共享的是「B 站曲目」，
 * 本地文件曲目没有可跨端定位的身份。移动端同样只发这一类，而且是**静默**过滤，
 * 所以一个纯本地文件的歌单分享出去会是空的、用户看不出为什么。
 *
 * 这里返回 `skipped`（= 歌单总条数 − 真正上传的条数），让 UI 能如实告知
 * 「有 N 首没能上传」，而不是让用户对着一个空歌单发呆。
 */
function listShareableTracks(playlistId) {
	const total = Number(
		sqlite.getFirstSync(
			'SELECT COUNT(*) AS n FROM playlist_tracks WHERE playlist_id = ?',
			[playlistId],
		)?.n ?? 0,
	)

	const rows = sqlite.getAllSync(
		`SELECT t.unique_key, t.title, t.cover_url, t.duration,
		        a.name AS artist_name, a.remote_id AS artist_remote_id,
		        bm.bvid, bm.cid, pt.sort_key
		 FROM playlist_tracks pt
		 JOIN tracks t ON t.id = pt.track_id
		 LEFT JOIN artists a ON a.id = t.artist_id
		 LEFT JOIN bilibili_metadata bm ON bm.track_id = t.id
		 WHERE pt.playlist_id = ? AND t.source = 'bilibili'
		 ORDER BY pt.sort_key DESC`,
		[playlistId],
	)

	const tracks = []
	for (const row of rows) {
		const bvid = row.bvid ?? bvidFromUniqueKey(row.unique_key)
		// 「B 站曲目但没有 bvid」理论上不该出现；真出现时也归入 skipped，
		// 绝不能发一个 `bilibili_bvid` 为空的曲目上去（后端 NOT NULL 会拒整批）
		if (!bvid) continue
		tracks.push({
			// 服务端契约：artist_id / bilibili_cid 是**字符串**，duration 是数字
			track: {
				unique_key: row.unique_key,
				title: row.title,
				artist_name: row.artist_name ?? undefined,
				artist_id: row.artist_remote_id ?? undefined,
				cover_url: row.cover_url ?? undefined,
				duration: row.duration ?? undefined,
				bilibili_bvid: bvid,
				bilibili_cid:
					row.cid === null || row.cid === undefined
						? undefined
						: String(row.cid),
			},
			sort_key: row.sort_key,
		})
	}

	return { tracks, skipped: total - tracks.length, total }
}

/** 本地已有的 `unique_key` → `track_id`，用于把服务端的键映射回本地行 */
function trackIdsByUniqueKeys(uniqueKeys) {
	if (uniqueKeys.length === 0) return new Map()
	const placeholders = uniqueKeys.map(() => '?').join(',')
	const rows = sqlite.getAllSync(
		`SELECT id, unique_key FROM tracks WHERE unique_key IN (${placeholders})`,
		uniqueKeys,
	)
	return new Map(rows.map((row) => [row.unique_key, row.id]))
}

/**
 * 按**服务端给的** `unique_key` 落库一首共享曲目。
 *
 * 刻意不复用 `db.upsertTrack`：那个函数总是用 `bilibili::<bvid>` 重新拼键，
 * 而服务端的键可能是 `bilibili::<bvid>::<cid>`（多 P 视频）。重新拼会让同一个
 * 视频在本地出现两行，且**把服务端发来的那首静默丢掉**（移动端就踩了这个）。
 */
function upsertSharedTrack(track) {
	const existing = sqlite.getFirstSync(
		'SELECT * FROM tracks WHERE unique_key = ?',
		[track.unique_key],
	)
	if (existing) return existing.id

	const now = Date.now()
	let artistId = null
	if (track.artist_name) {
		artistId = upsertSharedArtist(track.artist_name, track.artist_id ?? null)
	}

	sqlite.runSync(
		`INSERT INTO tracks (unique_key, title, artist_id, cover_url, duration, source, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 'bilibili', ?, ?)`,
		[
			track.unique_key,
			track.title,
			artistId,
			track.cover_url ?? null,
			track.duration ?? null,
			now,
			now,
		],
	)
	const trackId = sqlite.getFirstSync(
		'SELECT id FROM tracks WHERE unique_key = ?',
		[track.unique_key],
	).id

	const bvid = track.bilibili_bvid ?? bvidFromUniqueKey(track.unique_key)
	const cid =
		track.bilibili_cid === undefined ? null : Number(track.bilibili_cid)
	if (bvid) {
		sqlite.runSync(
			`INSERT OR REPLACE INTO bilibili_metadata (track_id, bvid, cid, is_multi_page, video_is_valid)
			 VALUES (?, ?, ?, ?, 1)`,
			[trackId, bvid, Number.isFinite(cid) ? cid : null, cid === null ? 0 : 1],
		)
	}
	return trackId
}

/**
 * 与 `db.upsertArtist` 同规则，但 remote_id 来自后端（**字符串**）。
 *
 * 同样先按 `(source, remote_id)` 查：服务端的 `artist_id` 是 B 站 mid，
 * 而桌面端可能已经用**另一个名字**存过同一个 mid（UP 改名、或标题里带的
 * 作者名与 UP 主名不同）。只按名字查会撞唯一索引抛异常，把整批拉取打断。
 */
function upsertSharedArtist(name, remoteId) {
	const normalizedRemoteId = remoteId ? String(remoteId) : null

	if (normalizedRemoteId) {
		const byRemoteId = sqlite.getFirstSync(
			"SELECT id FROM artists WHERE source != 'local' AND remote_id = ?",
			[normalizedRemoteId],
		)
		if (byRemoteId) return byRemoteId.id
	}

	const byName = sqlite.getFirstSync('SELECT id FROM artists WHERE name = ?', [
		name,
	])
	if (byName) return byName.id

	// artists 上有 CHECK：(source='local' AND remote_id IS NULL) OR (source!='local' AND remote_id IS NOT NULL)
	const source = normalizedRemoteId ? 'bilibili' : 'local'
	const now = Date.now()
	sqlite.runSync(
		'INSERT OR IGNORE INTO artists (name, source, remote_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
		[name, source, normalizedRemoteId, now, now],
	)

	if (normalizedRemoteId) {
		const inserted = sqlite.getFirstSync(
			"SELECT id FROM artists WHERE source != 'local' AND remote_id = ?",
			[normalizedRemoteId],
		)
		if (inserted) return inserted.id
	}
	return (
		sqlite.getFirstSync('SELECT id FROM artists WHERE name = ?', [name])?.id ??
		null
	)
}

/** 重算 `item_count`（拉取会删行，靠累加会漂） */
function recountPlaylist(playlistId) {
	const row = sqlite.getFirstSync(
		'SELECT COUNT(*) AS n FROM playlist_tracks WHERE playlist_id = ?',
		[playlistId],
	)
	sqlite.runSync(
		'UPDATE playlists SET item_count = ?, updated_at = ? WHERE id = ?',
		[row.n, Date.now(), playlistId],
	)
	return row.n
}

// ---------------------------------------------------------------
// outbox
// ---------------------------------------------------------------

function enqueueOperation(
	playlistId,
	operation,
	payload,
	operationAt = Date.now(),
) {
	if (!OUTBOX_OPERATIONS.has(operation)) {
		throw new Error(`未知的同步操作: ${operation}`)
	}
	sqlite.runSync(
		`INSERT INTO playlist_sync_queue (playlist_id, operation, payload, status, operation_at, created_at)
		 VALUES (?, ?, ?, 'pending', ?, ?)`,
		[playlistId, operation, JSON.stringify(payload), operationAt, Date.now()],
	)
}

/**
 * 待同步（含失败待重试）的操作列表。
 *
 * 给探针和「同步失败」UI 用：只暴露条数是不够的，用户与验证脚本都需要看到
 * **是哪一条**卡住了。
 */
function listOutbox(playlistId) {
	const rows = sqlite.getAllSync(
		`SELECT * FROM playlist_sync_queue
		 WHERE playlist_id = ? AND status != 'done'
		 ORDER BY operation_at ASC, id ASC`,
		[playlistId],
	)
	return rows.map((row) => ({
		...row,
		payload: safeParseJson(row.payload),
	}))
}

function safeParseJson(text) {
	try {
		return JSON.parse(text)
	} catch {
		return null
	}
}

function setOutboxStatus(ids, status) {
	if (ids.length === 0) return
	const placeholders = ids.map(() => '?').join(',')
	sqlite.runSync(
		`UPDATE playlist_sync_queue SET status = ? WHERE id IN (${placeholders})`,
		[status, ...ids],
	)
}

function deleteOutbox(ids) {
	if (ids.length === 0) return
	const placeholders = ids.map(() => '?').join(',')
	sqlite.runSync(
		`DELETE FROM playlist_sync_queue WHERE id IN (${placeholders})`,
		ids,
	)
}

/**
 * 「正在同步」的行在进程被杀时会永远卡住（没人再管它）。
 * 与移动端 `recoverStuckRows()` 同义，在同步开始前调用。
 */
function recoverStuckOperations() {
	const result = sqlite.runSync(
		"UPDATE playlist_sync_queue SET status = 'pending' WHERE status = 'syncing'",
	)
	return Number(result?.changes ?? 0)
}

// ---------------------------------------------------------------
// 主体
// ---------------------------------------------------------------

/**
 * @param {object} deps
 * @param {ReturnType<import('./bbplayer-account.cjs').createAccountModule>} deps.account
 */
function createSharedPlaylistModule({ account }) {
	/** 最近一次拉取拿到的成员列表（`share_id` → 成员数组）。
	 *
	 * 订阅者拿不到 `GET /:id/members`（403），只能靠 `GET /:id/changes` 里那份
	 * （**只含 owner + editor**）。这里缓存它，让 UI 至少能显示协作者。
	 */
	const memberCache = new Map()

	function log(level, message) {
		try {
			logger[level]?.(message)
		} catch {
			// 日志失败不影响同步
		}
	}

	const api = {
		preview: (shareId) =>
			account.request(`/playlists/${shareId}/preview`, { auth: false }),
		create: (body) => account.request('/playlists', { method: 'POST', body }),
		patch: (shareId, body) =>
			account.request(`/playlists/${shareId}`, { method: 'PATCH', body }),
		pushChanges: (shareId, changes) =>
			account.request(`/playlists/${shareId}/changes`, {
				method: 'POST',
				body: { changes },
			}),
		pullChanges: (shareId, since) =>
			account.request(`/playlists/${shareId}/changes?since=${Number(since)}`),
		subscribe: (shareId, inviteCode) =>
			account.request(`/playlists/${shareId}/subscribe`, {
				method: 'POST',
				body: inviteCode ? { invite_code: inviteCode } : {},
			}),
		getInvite: (shareId) => account.request(`/playlists/${shareId}/invite`),
		rotateInvite: (shareId) =>
			account.request(`/playlists/${shareId}/invite/rotate`, {
				method: 'POST',
			}),
		listMembers: (shareId) => account.request(`/playlists/${shareId}/members`),
		leave: (shareId) =>
			account.request(`/playlists/${shareId}/members/me`, { method: 'DELETE' }),
		remove: (shareId) =>
			account.request(`/playlists/${shareId}`, { method: 'DELETE' }),
		myPlaylists: () => account.request('/me/playlists'),
	}

	// ---------------------------------------------------------------
	// 查询
	// ---------------------------------------------------------------

	/** 本地标记为共享的歌单（含角色与待推送条数） */
	function listSharedPlaylists() {
		const rows = sqlite.getAllSync(
			`SELECT p.*, (SELECT COUNT(*) FROM playlist_sync_queue q
			              WHERE q.playlist_id = p.id AND q.status != 'done') AS pending_count
			 FROM playlists p
			 WHERE p.share_id IS NOT NULL
			 ORDER BY p.updated_at DESC`,
		)
		return rows.map(describeShared)
	}

	function describeShared(row) {
		return {
			id: row.id,
			title: row.title,
			description: row.description,
			coverUrl: row.cover_url,
			itemCount: row.item_count,
			shareId: row.share_id,
			shareRole: row.share_role,
			lastShareSyncAt: row.last_share_sync_at,
			pendingCount: Number(row.pending_count ?? 0),
			canWrite: WRITABLE_ROLES.has(row.share_role),
			isOwner: row.share_role === 'owner',
			shareLink: buildShareLink(row.share_id, null),
			members: memberCache.get(row.share_id) ?? [],
		}
	}

	function setShareState(playlistId, { shareId, shareRole, lastShareSyncAt }) {
		sqlite.runSync(
			`UPDATE playlists
			 SET share_id = ?, share_role = ?, last_share_sync_at = ?, updated_at = ?
			 WHERE id = ?`,
			[shareId, shareRole, lastShareSyncAt ?? null, Date.now(), playlistId],
		)
	}

	/**
	 * 本地改动入队。只有可写角色才需要推，订阅者是只读的。
	 *
	 * `operationAt` 是**用户真正做这个操作的时间**，它是服务端 LWW 的裁决依据。
	 * 默认取当前时间；离线攒了多个操作时调用方可以传真实发生时间，
	 * 否则「先离线改 A 再改 B」会被压成同一时刻而丢掉顺序。
	 */
	function queueLocalChange(
		playlistId,
		operation,
		payload,
		operationAt = Date.now(),
	) {
		const row = getPlaylistRow(playlistId)
		if (!row?.share_id) return { queued: false, reason: 'not_shared' }
		if (!WRITABLE_ROLES.has(row.share_role)) {
			return { queued: false, reason: 'readonly' }
		}
		enqueueOperation(playlistId, operation, payload, operationAt)
		return { queued: true, reason: null, shareId: row.share_id }
	}

	// ---------------------------------------------------------------
	// 分享（本地 → 远端）
	// ---------------------------------------------------------------

	/**
	 * 把一个本地歌单变成共享歌单：建远端歌单 + **一次性全量上传**当前曲目。
	 *
	 * 幂等：已经有 `share_id` 就直接返回，不重复创建（重复创建会在服务端留下
	 * 一堆同名孤儿歌单，而用户只会看到一个）。
	 */
	async function sharePlaylist(localPlaylistId) {
		const row = getPlaylistRow(localPlaylistId)
		if (!row) throw new Error('歌单不存在')
		if (row.share_id) {
			return { shareId: row.share_id, alreadyShared: true }
		}

		const { tracks, skipped } = listShareableTracks(localPlaylistId)
		log(
			'info',
			`分享歌单「${String(row.title)}」：上传 ${tracks.length} 首，跳过 ${skipped} 首（无 B 站 bvid）`,
		)

		const result = await api.create({
			title: row.title,
			description: row.description ?? undefined,
			cover_url: row.cover_url ?? undefined,
			tracks,
		})
		const remote = result?.playlist
		if (!remote?.id) {
			throw new Error('后端没有返回共享歌单 id（响应结构不符）')
		}

		// 游标取远端 `updatedAt`：刚上传完的内容不用再拉一遍
		const cursor = remote.updatedAt
			? new Date(remote.updatedAt).getTime()
			: Date.now()
		setShareState(localPlaylistId, {
			shareId: remote.id,
			shareRole: 'owner',
			lastShareSyncAt: cursor,
		})

		return {
			shareId: remote.id,
			alreadyShared: false,
			uploaded: tracks.length,
			skipped,
			shareLink: buildShareLink(remote.id, null),
		}
	}

	/**
	 * 取消共享。
	 *
	 * owner 走 `DELETE /playlists/:id`（服务端软删歌单并清空成员）；
	 * editor / subscriber 走 `DELETE /playlists/:id/members/me`（只退出关系）。
	 * 无论远端结果如何都清掉本地标记 —— 否则用户会卡在「一个永远同步失败的
	 * 共享歌单」上。远端失败时把原因如实返回。
	 */
	async function unsharePlaylist(localPlaylistId) {
		const row = getPlaylistRow(localPlaylistId)
		if (!row?.share_id) return { unshared: false, reason: 'not_shared' }

		const shareId = row.share_id
		let remoteError = null
		try {
			if (row.share_role === 'owner') await api.remove(shareId)
			else await api.leave(shareId)
		} catch (error) {
			// 404/403 表示远端已经没有这个关系了，等同于成功
			if (error.status !== 404 && error.status !== 403)
				remoteError = error.message
		}

		setShareState(localPlaylistId, {
			shareId: null,
			shareRole: null,
			lastShareSyncAt: null,
		})
		memberCache.delete(shareId)
		deleteOutbox(
			sqlite
				.getAllSync(
					'SELECT id FROM playlist_sync_queue WHERE playlist_id = ?',
					[localPlaylistId],
				)
				.map((r) => r.id),
		)

		return { unshared: true, remoteError }
	}

	// ---------------------------------------------------------------
	// 订阅（远端 → 本地）
	// ---------------------------------------------------------------

	/** 公开预览：**不需要登录**，用来在订阅前给用户看内容 */
	async function preview(input) {
		const { shareId, inviteCode, error } = parseShareInput(input)
		if (!shareId) throw new Error(error)

		const data = await api.preview(shareId)
		const playlist = data?.playlist
		if (!playlist) throw new Error('后端没有返回歌单（响应结构不符）')

		return {
			shareId,
			inviteCode,
			title: playlist.title,
			description: playlist.description ?? null,
			coverUrl: playlist.cover_url ?? null,
			// ⚠️ Postgres 的 count(*) 经 pg 回来是**字符串**
			trackCount: Number(playlist.track_count ?? 0),
			updatedAt: playlist.updated_at ?? null,
			owner: data.owner
				? {
						accountId: data.owner.account_id,
						name: data.owner.name,
						avatarUrl: data.owner.avatar_url ?? null,
					}
				: null,
			tracks: (data.tracks ?? []).map((t) => ({
				uniqueKey: t.unique_key,
				title: t.title,
				artistName: t.artist_name ?? null,
				coverUrl: t.cover_url ?? null,
				duration: t.duration ?? null,
				bvid: t.bilibili_bvid,
				sortKey: t.sort_key,
			})),
			previewLimit: Number(data.preview_limit ?? 0),
			shareLink: buildShareLink(shareId, inviteCode),
		}
	}

	/**
	 * 订阅（或补一次订阅以升级角色），然后把全量内容落到本地。
	 */
	async function subscribe(input, { inviteCode: explicitCode } = {}) {
		const parsed = parseShareInput(input)
		if (!parsed.shareId) throw new Error(parsed.error)
		const inviteCode = explicitCode ?? parsed.inviteCode
		const shareId = parsed.shareId

		const existing = findPlaylistByShareId(shareId)

		// 已存在时**仍然发一次 subscribe**：
		// 服务端在邀请码匹配时会把 subscriber 升成 editor。移动端在这里提前
		// return，于是「升级为协作编辑者」这个按钮实际上永远不生效。
		const result = await api.subscribe(shareId, inviteCode)
		const role = ROLES.includes(result?.role) ? result.role : 'subscriber'

		if (existing) {
			if (existing.share_role !== role) {
				setShareState(existing.id, {
					shareId,
					shareRole: role,
					lastShareSyncAt: existing.last_share_sync_at,
				})
			}
			await pullInto(existing.id, { full: false })
			return {
				localPlaylistId: existing.id,
				shareId,
				role,
				alreadySubscribed: true,
				upgraded: Boolean(result?.upgraded),
			}
		}

		// 先建本地空壳，再拉全量。标题等元数据来自 `GET /changes`（`subscribe`
		// 的响应里只有角色），因此先落一个占位标题，拉完会被覆盖。
		const playlist = createLocalPlaceholder(shareId, role)

		const pulled = await pullInto(playlist.id, { full: true })
		return {
			localPlaylistId: playlist.id,
			shareId,
			role,
			alreadySubscribed: false,
			upgraded: Boolean(result?.upgraded),
			applied: pulled.applied,
		}
	}

	function createLocalPlaceholder(shareId, role) {
		const now = Date.now()
		sqlite.runSync(
			`INSERT INTO playlists
			   (title, description, cover_url, type, item_count, share_id, share_role, last_share_sync_at, created_at, updated_at)
			 VALUES (?, NULL, NULL, 'local', 0, ?, ?, 0, ?, ?)`,
			['共享歌单', shareId, role, now, now],
		)
		return sqlite.getFirstSync(
			'SELECT * FROM playlists WHERE share_id = ? ORDER BY id DESC LIMIT 1',
			[shareId],
		)
	}

	// ---------------------------------------------------------------
	// 拉取
	// ---------------------------------------------------------------

	/**
	 * 把一个共享歌单的增量（或全量）写进本地库。
	 *
	 * 应用顺序：元数据 → 曲目 → 成员。**不做时间戳比较** ——
	 * 服务端已经在 LWW 里算好了结果，本地再比一次只会引入第二个真相。
	 */
	async function pullInto(localPlaylistId, { full = false } = {}) {
		const row = getPlaylistRow(localPlaylistId)
		if (!row?.share_id) throw new Error('这个歌单不是共享歌单')

		const since = full ? 0 : (row.last_share_sync_at ?? 0)
		const data = await api.pullChanges(row.share_id, since)

		let applied = 0
		sqlite.withTransactionSync(() => {
			const metadata = data?.metadata
			if (metadata) {
				// `title` 只在非空时覆盖；`description`/`cover_url` 用 `undefined`
				// 区分「没提」与「置空」—— 后者是合法的清空操作
				const nextTitle = metadata.title ?? row.title
				const nextDescription =
					metadata.description === undefined
						? row.description
						: metadata.description
				const nextCover =
					metadata.cover_url === undefined ? row.cover_url : metadata.cover_url
				sqlite.runSync(
					'UPDATE playlists SET title = ?, description = ?, cover_url = ?, updated_at = ? WHERE id = ?',
					[nextTitle, nextDescription, nextCover, Date.now(), localPlaylistId],
				)
			}

			const trackIds = []
			for (const change of data?.tracks ?? []) {
				// ⚠️ 读回来是 `delete`，写出去才是 `remove`
				if (change.op === 'delete') {
					const map = trackIdsByUniqueKeys([change.track_unique_key])
					const trackId = map.get(change.track_unique_key)
					if (trackId !== undefined) {
						sqlite.runSync(
							'DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?',
							[localPlaylistId, trackId],
						)
						applied += 1
					}
					continue
				}
				if (change.op !== 'upsert' || !change.track) continue
				const trackId = upsertSharedTrack(change.track)
				// 服务端的 `sort_key` 直接采用（约定已统一：越大越靠前）
				sqlite.runSync(
					`INSERT INTO playlist_tracks (playlist_id, track_id, sort_key, created_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(playlist_id, track_id) DO UPDATE SET sort_key = excluded.sort_key`,
					[localPlaylistId, trackId, change.sort_key, Date.now()],
				)
				trackIds.push(trackId)
				applied += 1
			}

			if (applied > 0) recountPlaylist(localPlaylistId)

			if (Array.isArray(data?.members)) {
				memberCache.set(
					row.share_id,
					data.members.map((m) => ({
						accountId: m.account_id,
						role: m.role,
						name: m.name,
						avatarUrl: m.avatar_url ?? null,
					})),
				)
			}

			// 游标用**服务端时间**。用本地时间会在时钟偏慢时永远拉不到新改动
			if (typeof data?.server_time === 'number') {
				sqlite.runSync(
					'UPDATE playlists SET last_share_sync_at = ? WHERE id = ?',
					[data.server_time, localPlaylistId],
				)
			}
		})

		return { applied, serverTime: data?.server_time ?? null }
	}

	// ---------------------------------------------------------------
	// 推送（outbox → 远端）
	// ---------------------------------------------------------------

	/**
	 * 把 outbox 里的待推送操作拼成一批 `changes` 发出去。
	 *
	 * 返回 `{ pushed, dropped, failed }`：
	 *  - `pushed` 成功发出的操作条数
	 *  - `dropped` 因为「角色不可写 / 已经不是共享歌单」被丢弃的条数
	 *    （丢弃是**永久**的，否则它们会每轮重试到天荒地老）
	 *  - `failed` 因为网络/服务端错误保留为 `failed`，可重试
	 */
	async function flushOutbox(playlistId) {
		recoverStuckOperations()

		const row = getPlaylistRow(playlistId)
		if (!row) return { pushed: 0, dropped: 0, failed: 0, reason: 'missing' }

		const pending = sqlite
			.getAllSync(
				"SELECT * FROM playlist_sync_queue WHERE playlist_id = ? AND status = 'pending' ORDER BY operation_at ASC, id ASC",
				[playlistId],
			)
			.map((r) => ({ ...r, payload: safeParseJson(r.payload) }))
		if (pending.length === 0) return { pushed: 0, dropped: 0, failed: 0 }

		// 不再是共享歌单 / 角色只读 → 全部永久丢弃
		if (!row.share_id || !WRITABLE_ROLES.has(row.share_role)) {
			deleteOutbox(pending.map((r) => r.id))
			return { pushed: 0, dropped: pending.length, failed: 0 }
		}

		const changes = []
		const usedIds = []
		let dropped = 0
		for (const item of pending) {
			// 元数据只走 owner 的 PATCH；editor 的元数据改动会被服务端 403，
			// 移动端也是丢弃，这里保持一致
			if (item.operation === 'update_metadata') {
				if (row.share_role === 'owner') {
					try {
						await api.patch(row.share_id, {
							title: item.payload?.title,
							description: item.payload?.description,
							cover_url: item.payload?.coverUrl,
						})
						usedIds.push(item.id)
					} catch (error) {
						log('warn', `推送歌单元数据失败: ${error.message}`)
						return failOutbox(pending, usedIds)
					}
				} else {
					dropped += 1
					usedIds.push(item.id)
				}
				continue
			}

			const mapped = mapOperationToChanges(playlistId, row, item)
			if (mapped === null) {
				dropped += 1
				usedIds.push(item.id)
				continue
			}
			changes.push(...mapped)
			usedIds.push(item.id)
		}

		if (changes.length === 0) {
			deleteOutbox(usedIds)
			return { pushed: 0, dropped, failed: 0 }
		}

		setOutboxStatus(usedIds, 'syncing')
		try {
			const result = await api.pushChanges(row.share_id, changes)
			deleteOutbox(usedIds)
			// 推送成功后游标推到服务端的 `applied_at`，避免把自己的改动再拉回来
			if (typeof result?.applied_at === 'number') {
				sqlite.runSync(
					'UPDATE playlists SET last_share_sync_at = ? WHERE id = ?',
					[result.applied_at, playlistId],
				)
			}
			return { pushed: changes.length, dropped, failed: 0 }
		} catch (error) {
			setOutboxStatus(usedIds, 'failed')
			log('warn', `推送共享歌单改动失败（已保留待重试）: ${error.message}`)
			return {
				pushed: 0,
				dropped,
				failed: changes.length,
				error: error.message,
			}
		}
	}

	function failOutbox(pending, usedIds) {
		const failedIds = pending
			.map((r) => r.id)
			.filter((id) => !usedIds.includes(id))
		setOutboxStatus(failedIds, 'failed')
		deleteOutbox(usedIds)
		return { pushed: 0, dropped: 0, failed: failedIds.length }
	}

	/** 把一条 outbox 记录翻译成服务端的 `changes` 数组 */
	function mapOperationToChanges(playlistId, _playlistRow, item) {
		const payload = item.payload ?? {}
		const at = item.operation_at

		const toTrack = (r) => ({
			unique_key: r.unique_key,
			title: r.title,
			artist_name: r.artist_name ?? undefined,
			artist_id: r.artist_remote_id ?? undefined,
			cover_url: r.cover_url ?? undefined,
			duration: r.duration ?? undefined,
			bilibili_bvid: r.bvid ?? bvidFromUniqueKey(r.unique_key),
			bilibili_cid:
				r.cid === null || r.cid === undefined ? undefined : String(r.cid),
		})

		if (item.operation === 'add_tracks' || item.operation === 'reorder_track') {
			const trackIds =
				item.operation === 'add_tracks'
					? (payload.trackIds ?? [])
					: [payload.trackId]
			const out = []
			for (const trackId of trackIds) {
				const row = sqlite.getFirstSync(
					`SELECT t.unique_key, t.title, t.cover_url, t.duration,
					        a.name AS artist_name, a.remote_id AS artist_remote_id,
					        bm.bvid, bm.cid, pt.sort_key
					 FROM playlist_tracks pt
					 JOIN tracks t ON t.id = pt.track_id
					 LEFT JOIN artists a ON a.id = t.artist_id
					 LEFT JOIN bilibili_metadata bm ON bm.track_id = t.id
					 WHERE pt.playlist_id = ? AND pt.track_id = ?`,
					[playlistId, trackId],
				)
				if (!row) continue
				out.push({
					op: 'upsert',
					track: toTrack(row),
					sort_key: payload.nextSortKey ?? row.sort_key,
					operation_at: at,
				})
			}
			return out.length > 0 ? out : null
		}

		if (item.operation === 'remove_tracks') {
			const out = []
			for (const trackId of payload.removedTrackIds ?? []) {
				const row = sqlite.getFirstSync(
					'SELECT unique_key FROM tracks WHERE id = ?',
					[trackId],
				)
				if (!row) continue
				// ⚠️ 发出去用 `remove`（读回来才是 `delete`）
				out.push({
					op: 'remove',
					track_unique_key: row.unique_key,
					operation_at: at,
				})
			}
			return out.length > 0 ? out : null
		}

		return null
	}

	// ---------------------------------------------------------------
	// 一眼可见的顶层动作
	// ---------------------------------------------------------------

	/**
	 * 推完再拉：顺序很重要 —— 反过来的话本地改动会被自己的旧快照覆盖。
	 *
	 * ## 远端歌单消失时**不自动删本地副本**
	 *
	 * 后端在 owner 删除歌单后，其他成员再拉会拿到 **404**（`deleted_at` 已置位），
	 * 被移出成员的拿到 **403**。移动端在这两种情况下会**直接删掉本地歌单**。
	 * 桌面端刻意不这么做：那会**静默丢掉用户本地的一整个歌单**（里面可能还有
	 * 本地曲目、播放次数、自定义顺序），而用户根本没点过删除。
	 *
	 * 因此这里返回 `{ gone: true, reason }` 让 UI **明确告知**并给一个
	 * 「移除本地副本」的动作，把决定权交回用户。
	 */
	async function syncPlaylist(localPlaylistId) {
		const row = getPlaylistRow(localPlaylistId)
		if (!row?.share_id) throw new Error('这个歌单不是共享歌单')

		const flush = await flushOutbox(localPlaylistId)

		let pull
		try {
			pull = await pullInto(localPlaylistId)
		} catch (error) {
			if (error.status === 404) {
				return { ...flush, applied: 0, gone: true, goneReason: 'deleted' }
			}
			if (error.status === 403) {
				return { ...flush, applied: 0, gone: true, goneReason: 'forbidden' }
			}
			throw error
		}

		return { ...flush, applied: pull.applied, gone: false, goneReason: null }
	}

	/**
	 * 用户确认后移除一个已经失效的共享歌单的**共享标记**（保留本地歌单本身）。
	 *
	 * 与 `unsharePlaylist` 的区别：那个会先尝试请求远端，这个只清本地，
	 * 用在「远端已经没了 / 我们已经被踢出」的场景。
	 */
	function detachSharedPlaylist(localPlaylistId) {
		const row = getPlaylistRow(localPlaylistId)
		if (!row) return { detached: false }
		setShareState(localPlaylistId, {
			shareId: null,
			shareRole: null,
			lastShareSyncAt: null,
		})
		if (row.share_id) memberCache.delete(row.share_id)
		deleteOutbox(
			sqlite
				.getAllSync(
					'SELECT id FROM playlist_sync_queue WHERE playlist_id = ?',
					[localPlaylistId],
				)
				.map((r) => r.id),
		)
		return { detached: true }
	}

	async function syncAll() {
		const targets = listSharedPlaylists()
		const results = []
		for (const target of targets) {
			try {
				results.push({
					id: target.id,
					title: target.title,
					...(await syncPlaylist(target.id)),
				})
			} catch (error) {
				// 单个歌单失败不阻断其它（移动端同样逐条 try/catch）
				results.push({
					id: target.id,
					title: target.title,
					error: error.message,
				})
			}
		}
		return results
	}

	/**
	 * 换设备后的恢复入口：把云端参与了、但本地没有的歌单拉下来。
	 *
	 * 与移动端一致：**只创建缺失的**，不刷新本地已有副本的角色与元数据
	 * （那需要用户在具体歌单上点同步，语义更清楚）。
	 */
	async function restoreFromCloud() {
		const remote = await api.myPlaylists()
		const list = remote?.playlists ?? []
		const localShareIds = new Set(
			sqlite
				.getAllSync('SELECT share_id FROM playlists WHERE share_id IS NOT NULL')
				.map((r) => r.share_id),
		)

		const restored = []
		const failed = []
		for (const item of list) {
			if (!item?.id || localShareIds.has(item.id)) continue
			try {
				const playlist = createLocalPlaceholder(
					item.id,
					item.role ?? 'subscriber',
				)
				const result = await pullInto(playlist.id, { full: true })
				restored.push({
					id: playlist.id,
					shareId: item.id,
					title: item.title,
					...result,
				})
			} catch (error) {
				failed.push({ shareId: item.id, error: error.message })
			}
		}
		return {
			restored,
			failed,
			remoteCount: list.length,
			localCount: localShareIds.size,
		}
	}

	/** owner 才拿得到邀请码；服务端允许返回 `null`（没生成过） */
	async function getInviteCode(localPlaylistId) {
		const row = getPlaylistRow(localPlaylistId)
		if (!row?.share_id) throw new Error('这个歌单不是共享歌单')
		const result = await api.getInvite(row.share_id)
		const code = result?.editor_invite_code ?? null
		return {
			shareId: row.share_id,
			inviteCode: code,
			shareLink: buildShareLink(row.share_id, code),
		}
	}

	async function rotateInviteCode(localPlaylistId) {
		const row = getPlaylistRow(localPlaylistId)
		if (!row?.share_id) throw new Error('这个歌单不是共享歌单')
		const result = await api.rotateInvite(row.share_id)
		const code = result?.editor_invite_code ?? null
		return {
			shareId: row.share_id,
			inviteCode: code,
			shareLink: buildShareLink(row.share_id, code),
		}
	}

	/**
	 * 成员列表。owner/editor 走专用接口（含订阅者）；
	 * subscriber 会拿到 403 —— 那就回落到最近一次拉取缓存的那份（只含协作者）。
	 */
	async function listMembers(localPlaylistId) {
		const row = getPlaylistRow(localPlaylistId)
		if (!row?.share_id) throw new Error('这个歌单不是共享歌单')
		try {
			const result = await api.listMembers(row.share_id)
			const members = (result?.members ?? []).map((m) => ({
				accountId: m.account_id,
				role: m.role,
				name: m.name,
				avatarUrl: m.avatar_url ?? null,
				joinedAt: m.joined_at ?? null,
			}))
			memberCache.set(row.share_id, members)
			return { members, from: 'api', canSeeSubscribers: true }
		} catch (error) {
			if (error.status === 403) {
				return {
					members: memberCache.get(row.share_id) ?? [],
					from: 'cache',
					canSeeSubscribers: false,
				}
			}
			throw error
		}
	}

	return {
		// 账号透传（渲染进程只跟一个门面打交道）
		accountStatus: () => account.status(),
		setBaseUrl: (url) => account.setBaseUrl(url),
		register: (payload) => account.register(payload),
		login: (payload) => account.login(payload),
		logout: () => account.logout(),
		me: () => account.me(),

		listSharedPlaylists,
		sharePlaylist,
		unsharePlaylist,
		detachSharedPlaylist,
		preview,
		subscribe,
		syncPlaylist,
		syncAll,
		restoreFromCloud,
		getInviteCode,
		rotateInviteCode,
		listMembers,

		queueLocalChange,
		/** 待同步条数（UI 上的小红点） */
		pendingCount: (playlistId) => listOutbox(playlistId).length,
		/** 待同步明细（探针与「同步失败」面板） */
		listOutbox,
		flushOutbox,
		recoverStuckOperations,
	}
}

module.exports = {
	ROLES,
	WRITABLE_ROLES,
	SHARE_LINK_ORIGIN,
	parseShareInput,
	buildShareLink,
	bvidFromUniqueKey,
	listShareableTracks,
	createSharedPlaylistModule,
}
