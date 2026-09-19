/**
 * 主进程的 IPC handler 注册。
 *
 * 渲染进程只能通过 preload 暴露的这几个方法访问数据；所有 DB / 网络访问都在
 * 主进程完成（渲染进程没有 Node 权限，contextIsolation 打开）。
 */
const path = require('node:path')
const fs = require('node:fs')

const { ipcMain, nativeTheme, BrowserWindow } = require('electron')

const bilibiliApi = require('./bilibili-api.cjs')
const db = require('./db.cjs')
const {
	requestLog,
	resolveAudio,
	clearAudioCache,
} = require('./audio-proxy.cjs')
const { core, describePorts, DATA_DIR, logger } = require('./ports.cjs')
const { loadTsFile } = require('./core-loader.cjs')
const { getLoginManager } = require('./bilibili-login-holder.cjs')
const { createAccountModule } = require('./bbplayer-account.cjs')
const { createSharedPlaylistModule } = require('./shared-playlist.cjs')

/**
 * 懒创建下载管理器与备份管理器。
 *
 * 为什么不在这里直接建：
 *   * 下载管理器会 `mkdirSync` 下载目录；纯 Node 验证脚本（如
 *     `verify-desktop-db.mjs`）只调 `registerIpcHandlers()`、并不需要下载功能，
 *     提前创建会多出无用目录。
 *   * 备份管理器要读 KV 与 `safeStorage`，而 `safeStorage` 要 app ready 后才可用。
 */
/**
 * 取 core 的 StoragePort，并适配成 `getItem/setItem` 风格的键值接口。
 *
 * ⚠️ 两个坑都在这里踩过：
 *
 * 1. **不能在模块顶部解构 `storage`。** `ports.cjs` 初始化时会
 *    `registerCorePorts(desktopPorts)`，而 `desktopPorts.storage` 在那之前是
 *    undefined；模块顶部解构拿到的是当时的快照，表现为每个 handler 都报
 *    `storage.getItem is not a function`。
 *
 * 2. **端口的真实方法名是 `getString` / `set`**（见
 *    `packages/core/src/ports/index.ts` 的 `StoragePort`），不是
 *    `getItem` / `setItem`。备份管理器与设置层用的是后者这套名字，
 *    所以这里做一层**显式适配**，而不是让两处各写一套语义相近但名字不同的
 *    接口 —— 后者正是第一版把 `getString` 当成 `getItem` 的原因。
 */
function getStorage() {
	const port = require('./ports.cjs').desktopPorts.storage
	if (!port) {
		throw new Error('StoragePort 尚未注册（ports.cjs 初始化未完成？）')
	}
	return {
		/** 读字符串；未设置时返回 null（与 StoragePort.getString 的 undefined 区分） */
		getItem: (key) => port.getString(key) ?? null,
		setItem: (key, value) => port.set(key, value),
		deleteItem: (key) => port.delete(key),
		/** 原样转发，便于需要 getBoolean 等能力时使用 */
		port,
	}
}

let downloadManager = null
let backupManager = null
let settingsManager = null

function getSettings() {
	if (!settingsManager) {
		const { createSettings } = require('./settings.cjs')
		settingsManager = createSettings({
			storage: getStorage(),
			log: (message) => core?.logger?.info?.(message),
		})
	}
	return settingsManager
}

function getDownloadManager() {
	if (!downloadManager) {
		const { createDownloadManager } = require('./download.cjs')
		downloadManager = createDownloadManager({
			downloadDir: path.join(DATA_DIR, 'downloads'),
			maxParallel: 2,
			log: (message) => core?.logger?.info?.(message),
		})
	}
	return downloadManager
}

function getBackupManager() {
	if (!backupManager) {
		const { createBackupManager } = require('./backup-manager.cjs')
		backupManager = createBackupManager({
			dataDir: DATA_DIR,
			dbFile: path.join(DATA_DIR, 'bbplayer.db'),
			baselineName: db.BASELINE_MIGRATION,
			storage: getStorage(),
			log: (message) => core?.logger?.info?.(message),
		})
	}
	return backupManager
}

/**
 * 取登录管理器；未初始化时抛出明确错误。
 *
 * 管理器在 `main.cjs` 的 `app.whenReady()` 里注册。验证脚本直接调
 * `registerIpcHandlers()` 而不走 Electron 启动流程，那种场景下不会有管理器 ——
 * 所以登录相关 handler 必须容忍「没有管理器」，返回可读的错误而不是崩。
 */
function requireLoginManager() {
	const manager = getLoginManager()
	if (!manager) {
		throw new Error('登录管理器未初始化（未经过 Electron 启动流程？）')
	}
	return manager
}

/** 建库（幂等），应用启动时调用一次 */
function ensureDatabase() {
	const result = db.runMigrations()
	return result
}

function registerIpcHandlers() {
	// ---------- 音频 ----------
	ipcMain.handle('audio:resolve', async (_event, bvid) => {
		try {
			const info = await resolveAudio(bvid)
			return {
				ok: true,
				data: {
					bvid: info.bvid,
					cid: info.cid,
					title: info.title,
					duration: info.duration,
					quality: info.quality,
					tier: info.tier,
					bandwidth: info.bandwidth,
					proxyUrl: `bbplayer-audio://track/${encodeURIComponent(info.bvid)}`,
					upstreamHost: info.upstreamHost,
					backupUrlCount: info.backupUrls.length,
				},
			}
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	// ---------- 歌单 ----------
	ipcMain.handle('db:listPlaylists', () => {
		try {
			return { ok: true, data: db.listPlaylists() }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('db:getPlaylistTracks', (_event, playlistId) => {
		try {
			return { ok: true, data: db.getPlaylistTracks(playlistId) }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	/**
	 * 歌单内重排（更改列表顺序）。
	 *
	 * 参数是**下标**而不是 sortKey：渲染进程看到的顺序就是
	 * `getPlaylistTracks` 的顺序，让它去算 fractional index 的键等于把存储细节
	 * 泄漏到界面层 —— 而且那个键方向还是反的（键越大越靠前）。
	 */
	ipcMain.handle('db:movePlaylistTrack', (_event, payload) => {
		try {
			const { playlistId, from, to } = payload ?? {}
			return { ok: true, data: db.movePlaylistTrack(playlistId, from, to) }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('db:createPlaylist', (_event, payload) => {
		try {
			return { ok: true, data: db.createPlaylist(payload) }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	// ---------- B 站 ----------
	ipcMain.handle('bili:search', async (_event, keyword) => {
		try {
			const items = await bilibiliApi.searchVideos(keyword)
			return { ok: true, data: items }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('bili:videoInfo', async (_event, bvid) => {
		try {
			return { ok: true, data: await bilibiliApi.getVideoInfo(bvid) }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('bili:userSeasons', async (_event, mid) => {
		try {
			return { ok: true, data: await bilibiliApi.listUserSeasons(mid) }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('bili:seasonArchives', async (_event, mid, seasonId) => {
		try {
			return {
				ok: true,
				data: await bilibiliApi.listSeasonArchives(mid, seasonId, {
					maxItems: 200,
				}),
			}
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	/**
	 * 把一批视频导入为本地歌单（Phase 1 的核心动作）。
	 *
	 * 逐个解析音频流以确保「拉得到且能播」，同时落库。单个视频失败不阻断整体。
	 */
	ipcMain.handle('bili:importSeasonToPlaylist', async (_event, payload) => {
		const { mid, seasonId, title } = payload
		try {
			const archives = await bilibiliApi.listSeasonArchives(mid, seasonId, {
				maxItems: 200,
			})

			// 避免重复导入：同名 local 歌单直接复用
			const existing = db
				.listPlaylists()
				.find((item) => item.title === title && item.type === 'local')
			const playlist = existing ?? db.createPlaylist({ title, type: 'local' })

			let added = 0
			const addedTrackIds = []
			const failures = []
			for (const archive of archives) {
				try {
					const info = await bilibiliApi.getVideoInfo(archive.bvid)
					const track = db.upsertTrack({
						uniqueKey: `bilibili::${archive.bvid}`,
						title: info.title,
						artistName: info.owner,
						artistRemoteId: info.ownerMid,
						coverUrl: info.cover,
						duration: info.duration,
						bvid: archive.bvid,
						cid: info.cid,
						isMultiPage: info.pages > 1,
					})
					if (db.addTrackToPlaylist(playlist.id, track.id)) {
						added += 1
						addedTrackIds.push(track.id)
					}
				} catch (error) {
					failures.push({ bvid: archive.bvid, error: error.message })
				}
			}

			// 歌单是共享的就把这次新增记进 outbox 并后台推送
			enqueueSharedAdd(playlist.id, addedTrackIds)

			return {
				ok: true,
				data: {
					playlistId: playlist.id,
					title: playlist.title,
					total: archives.length,
					added,
					failures,
				},
			}
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	// ---------- 歌词（网易云）----------
	//
	// 注意 API 形状：core 导出的是 `neteaseLyricsApiClient` **实例**
	// （方法 `searchLyrics` / `fetchLyricsById`），不是同名独立函数。
	// 解析器 `parseAndMergeLyrics` 在 `packages/splash` 里，core 未依赖它，
	// 因此这里直接按绝对路径加载（与 core-loader 同样的做法）。
	const loadSplashParser = () => {
		const entry = path.resolve(
			__dirname,
			'..',
			'..',
			'..',
			'packages',
			'splash',
			'src',
			'parser',
			'merge.ts',
		)
		return loadTsFile(entry)
	}

	ipcMain.handle('lyrics:search', async (_event, keyword, limit) => {
		try {
			const { neteaseLyricsApiClient, toLyricsCandidates } = core
			const result = await neteaseLyricsApiClient.searchLyrics(
				keyword,
				limit ?? 10,
			)
			if (result.isErr()) throw new Error(result.error.message)
			return { ok: true, data: toLyricsCandidates(result.value) }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('lyrics:fetch', async (_event, songId) => {
		try {
			const result = await core.neteaseLyricsApiClient.fetchLyricsById(songId)
			if (result.isErr()) throw new Error(result.error.message)
			return { ok: true, data: result.value }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	/**
	 * 自动匹配并**解析**歌词：搜索 -> 打分排序 -> 取词 -> 解析成行。
	 *
	 * 解析放在主进程做：core 已在这里加载（渲染进程没有模块系统，
	 * 把 `packages/splash` 的解析器搬进渲染进程反而要引入打包步骤）。
	 */
	ipcMain.handle('lyrics:autoMatch', async (_event, meta) => {
		try {
			const {
				neteaseLyricsApiClient,
				toLyricsCandidates,
				buildLyricsSearchKeyword,
				rankLyricsCandidates,
				AUTO_MATCH_THRESHOLD,
			} = core
			const { parseAndMergeLyrics } = loadSplashParser()

			const keyword =
				buildLyricsSearchKeyword(meta.title, meta.artist ?? undefined) ||
				meta.title
			const searchResult = await neteaseLyricsApiClient.searchLyrics(
				keyword,
				10,
			)
			if (searchResult.isErr()) throw new Error(searchResult.error.message)

			const candidates = toLyricsCandidates(searchResult.value)
			const ranked = rankLyricsCandidates(meta, candidates)
			const best = ranked[0] ?? null

			if (!best || best.score < AUTO_MATCH_THRESHOLD) {
				return {
					ok: true,
					data: {
						matched: false,
						threshold: AUTO_MATCH_THRESHOLD,
						bestScore: best ? best.score : 0,
						candidateCount: candidates.length,
						candidates: ranked.slice(0, 8),
					},
				}
			}

			const lyricResult = await neteaseLyricsApiClient.fetchLyricsById(
				best.candidate.remoteId,
			)
			if (lyricResult.isErr()) throw new Error(lyricResult.error.message)

			const payload = lyricResult.value
			const lines = parseAndMergeLyrics({
				lrc: payload.lrc,
				tlyric: payload.tlyric ?? undefined,
				romalrc: payload.romalrc ?? undefined,
			}).map((line) => ({
				startTime: line.startTime,
				content: line.content,
				translation: line.translation,
			}))

			return {
				ok: true,
				data: {
					matched: true,
					score: best.score,
					candidate: best.candidate,
					lineCount: lines.length,
					lines,
				},
			}
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	// ---------- 登录（Phase 3）----------

	ipcMain.handle('login:status', async () => {
		try {
			const manager = getLoginManager()
			if (!manager) {
				return {
					ok: true,
					data: { loggedIn: false, encrypted: false, available: false },
				}
			}
			return {
				ok: true,
				data: { ...(await manager.status()), available: true },
			}
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('login:qrCreate', async () => {
		try {
			const data = await requireLoginManager().createQrCode()
			return { ok: true, data }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('login:qrPoll', async (_event, qrcodeKey) => {
		try {
			const manager = requireLoginManager()
			const result = await manager.pollQrCode(qrcodeKey)

			if (result.state !== 'confirmed') {
				return { ok: true, data: result }
			}

			// 确认成功：收下 cookie，并让音频缓存失效
			// （登录后同一视频可能升级到杜比/Hi-Res，旧缓存会挡住升级）
			const adopted = await manager.confirmQrLogin(result.cookie)
			clearAudioCache()
			return {
				ok: true,
				data: { state: 'confirmed', ...adopted },
			}
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('login:password', async (_event, payload) => {
		try {
			const { username, password } = payload ?? {}
			const manager = requireLoginManager()
			const result = await manager.loginWithPassword(username, password)
			clearAudioCache()
			return { ok: true, data: result }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('login:importCookie', async (_event, input) => {
		try {
			const manager = requireLoginManager()
			const result = await manager.importCookie(input)
			clearAudioCache()
			return { ok: true, data: result }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('login:logout', () => {
		try {
			const manager = requireLoginManager()
			const data = manager.logout()
			clearAudioCache()
			return { ok: true, data }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	// ---------- 收藏夹（Phase 3）----------
	//
	// 注意：**公开收藏夹无需登录**（实测 `created/list-all` 与
	// `resource/list` 匿名均 `code=0`）。登录只影响能否看到私密收藏夹。

	ipcMain.handle('bili:favoriteFolders', async (_event, mid) => {
		try {
			return { ok: true, data: await bilibiliApi.listFavoriteFolders(mid) }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('bili:favoriteResources', async (_event, mediaId) => {
		try {
			return {
				ok: true,
				data: await bilibiliApi.listFavoriteResources(mediaId, {
					maxItems: 500,
				}),
			}
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	/**
	 * 把收藏夹同步成本地歌单（**增量**）。
	 *
	 * 「增量」的含义：已在本歌单里的 bvid 直接跳过，不重新请求 view/playurl。
	 * 首次同步 500 条会很慢（每条一次 `view` 请求），但之后每次只处理新增。
	 *
	 * 失败条目逐个记录而不是整体回滚：B 站收藏夹里常有已删除/受限视频，
	 * 一条失败不该让整个同步放弃。
	 */
	ipcMain.handle('bili:syncFavoriteToPlaylist', async (_event, payload) => {
		const { mediaId, title, cover, maxItems = 200 } = payload ?? {}
		try {
			if (!mediaId) throw new Error('缺少 mediaId')

			const resources = await bilibiliApi.listFavoriteResources(mediaId, {
				maxItems,
			})

			const playlist = db.upsertRemotePlaylist({
				source: db.REMOTE_SOURCE.FAVORITE,
				remoteId: mediaId,
				title: title ?? `收藏夹 ${mediaId}`,
				coverUrl: cover ?? null,
			})

			const known = db.getPlaylistBvids(playlist.id)
			const failures = []
			const addedTrackIds = []
			let added = 0
			let skipped = 0

			for (const resource of resources) {
				if (known.has(resource.bvid)) {
					skipped += 1
					continue
				}
				try {
					// 这里必须请求 view：collection 列表不带 cid，而播放要用
					const info = await bilibiliApi.getVideoInfo(resource.bvid)
					const track = db.upsertTrack({
						uniqueKey: `bilibili::${resource.bvid}`,
						title: info.title,
						artistName: info.owner ?? resource.upperName ?? '未知作者',
						artistRemoteId: info.ownerMid ?? resource.upperMid,
						coverUrl: info.cover ?? resource.cover,
						duration: info.duration ?? resource.duration,
						bvid: resource.bvid,
						cid: info.cid,
						isMultiPage: info.pages > 1,
					})
					if (db.addTrackToPlaylist(playlist.id, track.id)) {
						added += 1
						addedTrackIds.push(track.id)
					}
				} catch (error) {
					failures.push({ bvid: resource.bvid, error: error.message })
				}
			}

			enqueueSharedAdd(playlist.id, addedTrackIds)
			const total = db.markPlaylistSynced(playlist.id)

			return {
				ok: true,
				data: {
					playlistId: playlist.id,
					title: playlist.title,
					created: playlist.created,
					remoteTotal: resources.length,
					added,
					skipped,
					itemCount: total,
					failures,
				},
			}
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	// ---------- 系统媒体集成（Phase 4）----------
	//
	// 任务栏缩略图按钮与硬件媒体键都发生在主进程，但**队列状态在渲染进程**，
	// 所以主进程只负责把「动作名」推回去，由渲染进程决定怎么做。
	// 这样主进程不需要镜像一份播放状态（两份状态必然漂移）。

	ipcMain.handle('media:setThumbnailPlaying', (event, playing) => {
		try {
			const integration = require('./media-integration.cjs')
			return {
				ok: true,
				data: integration.setThumbarPlaying(event.sender, Boolean(playing)),
			}
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('media:setKeysEnabled', (event, enabled) => {
		try {
			const integration = require('./media-integration.cjs')
			if (!enabled) {
				integration.uninstallMediaKeys()
				return { ok: true, data: { registered: [], failed: [] } }
			}
			const result = integration.installMediaKeys((action) =>
				sendMediaAction(event.sender, action),
			)
			return { ok: true, data: result }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('media:info', () => {
		try {
			const integration = require('./media-integration.cjs')
			return { ok: true, data: integration.describe() }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	// ---------- 下载（Phase 4.3）----------

	ipcMain.handle('download:enqueue', (_event, track) => {
		try {
			return { ok: true, data: getDownloadManager().enqueue(track) }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('download:enqueueMany', (_event, tracks) => {
		try {
			return { ok: true, data: getDownloadManager().enqueueMany(tracks) }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('download:cancel', (_event, bvid) => {
		try {
			return { ok: true, data: getDownloadManager().cancel(bvid) }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('download:listTasks', () => {
		try {
			return { ok: true, data: getDownloadManager().listTasks() }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('download:listDownloaded', () => {
		try {
			return { ok: true, data: getDownloadManager().listDownloaded() }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('download:clearFinished', () => {
		try {
			return { ok: true, data: getDownloadManager().clearFinished() }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('download:info', () => {
		try {
			return { ok: true, data: getDownloadManager().describe() }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	/** 在系统文件管理器里打开下载目录（桌面端比移动端简单得多） */
	ipcMain.handle('download:openFolder', async () => {
		try {
			const { shell } = require('electron')
			const dir = getDownloadManager().downloadDir
			const error = await shell.openPath(dir)
			if (error) throw new Error(error)
			return { ok: true, data: { dir } }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	// ---------- 备份 / 恢复（Phase 4.5）----------
	//
	// ⚠️ `backup:restore` 会**关闭数据库连接**（Windows 上替换文件的前提），
	// 之后整个进程不能再访问数据库。所以恢复成功后 UI 必须提示重启。

	ipcMain.handle('backup:config', async () => {
		try {
			return { ok: true, data: await getBackupManager().describe() }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('backup:saveConfig', async (_event, payload) => {
		try {
			return {
				ok: true,
				data: await getBackupManager().saveConfig(payload ?? {}),
			}
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	/** 本地导出一份备份到数据目录下的 backups/ */
	ipcMain.handle('backup:exportLocal', async () => {
		try {
			const manager = getBackupManager()
			const config = await manager.describe()
			const result = manager.createBackupToFile(config.defaultExportDir)
			return { ok: true, data: result }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	/** 恢复本地文件；`path` 由渲染进程给出（用户选择或「最近导出」） */
	ipcMain.handle('backup:restoreLocal', async (_event, filePath) => {
		try {
			const buffer = fs.readFileSync(filePath)
			return { ok: true, data: getBackupManager().restoreFromBuffer(buffer) }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	/** 只校验，不动数据库（用于「先看看这份备份是什么」） */
	ipcMain.handle('backup:inspectLocal', async (_event, filePath) => {
		try {
			const buffer = fs.readFileSync(filePath)
			return { ok: true, data: getBackupManager().inspect(buffer) }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('backup:testConnection', async () => {
		try {
			return { ok: true, data: await getBackupManager().testConnection() }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('backup:listRemote', async () => {
		try {
			return { ok: true, data: await getBackupManager().listRemote() }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('backup:upload', async () => {
		try {
			return { ok: true, data: await getBackupManager().uploadLatest() }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	/**
	 * 在文件管理器里打开「本地导出」的目录。
	 *
	 * 为什么需要它：导出成功后**不应该**把绝对路径贴在界面上
	 * （`已导出 … → C:\Users\…\AppData\Local\Temp\…` 那是调试信息，
	 * 而且长到会把面板撑破）。给用户一个动作比给一串路径有用。
	 */
	ipcMain.handle('backup:openFolder', async () => {
		try {
			const { shell } = require('electron')
			const config = await getBackupManager().describe()
			const dir = config.defaultExportDir
			const error = await shell.openPath(dir)
			if (error) throw new Error(error)
			return { ok: true, data: { dir } }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	/**
	 * 重启应用。
	 *
	 * 恢复备份会**关闭数据库连接并替换数据文件**，之后必须重启才能继续用。
	 * 与其让用户自己去关掉再打开，不如直接给一个按钮 —— 这也是「界面只说
	 * 下一步做什么」的一个具体例子。
	 */
	ipcMain.handle('app:relaunch', () => {
		const { app } = require('electron')
		app.relaunch()
		app.exit(0)
		return { ok: true, data: { relaunching: true } }
	})

	/**
	 * 用**系统默认浏览器**打开一个链接（关于页的「前往 GitHub」）。
	 *
	 * ⚠️ 必须带**白名单**：这个 handler 会拉起系统浏览器，
	 * 而它接收的是渲染进程传来的字符串。不加限制的话，
	 * 一个被注入的渲染脚本就能让用户弹出任意 URL
	 * （钓鱼页、`file:` 协议、自定义协议拉起别的应用…）。
	 *
	 * 白名单只放**确实需要外链**的几个站，且强制 https。
	 * 以后要加外链，往这里加 —— 不要在渲染进程里拼 URL 绕过它。
	 */
	const EXTERNAL_ALLOWLIST = [
		'https://github.com/xiongzikun0106/BBPlayerDesktop',
		'https://github.com/xiongzikun0106/BBPlayer',
	]
	ipcMain.handle('app:openExternal', (_event, url) => {
		try {
			const target = String(url ?? '')
			const allowed = EXTERNAL_ALLOWLIST.some(
				// 允许带路径（如 /releases、/issues），但**不允许**换域名或换协议
				(prefix) => target === prefix || target.startsWith(`${prefix}/`),
			)
			if (!allowed) throw new Error('这个链接不在允许打开的名单里')
			const { shell } = require('electron')
			void shell.openExternal(target)
			return { ok: true, data: { opened: target } }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	/**
	 * 诊断信息：**实现细节唯一的去处**。
	 *
	 * 主流程里不出现「密钥环 / 明文 / 格式 / 绝对路径」，但用户有权在自己想看的
	 * 时候查。渲染进程只读地展示，不做任何判断。
	 */
	ipcMain.handle('diagnostics:info', async () => {
		try {
			const ports = describePorts()
			const shared = getShared()
			const account = shared.accountStatus()
			const versions = process.versions
			return {
				ok: true,
				data: {
					dataDir: ports.dataDir,
					dbFile: ports.dbFile,
					logFile: ports.logFile,
					// B 站凭据的落盘方式（`describePorts()` 已经报过，不重复查一次）
					bilibiliCredentialEncrypted: ports.login?.encrypted ?? null,
					// BBPlayer 账号（共享歌单用）的后端与令牌存储
					shareBaseUrl: account.baseUrl,
					shareBaseUrlIsDefault: account.baseUrl === account.defaultBaseUrl,
					shareTokenEncrypted: account.encrypted,
					shareLoggedIn: account.loggedIn,
					versions: {
						app: require('../package.json').version,
						electron: versions.electron,
						chrome: versions.chrome,
						node: versions.node,
						platform: `${process.platform} ${process.arch}`,
					},
				},
			}
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('backup:downloadRemote', async (_event, remotePath) => {
		try {
			const buffer = await getBackupManager().downloadRemote(remotePath)
			return { ok: true, data: getBackupManager().restoreFromBuffer(buffer) }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	// ---------- 设置（Phase 4 收尾）----------
	//
	// 设置存在 core 的 StoragePort 里（桌面端是 JSON 文件 KV），
	// 键名与移动端的 `app-storage` 语义对齐，方便将来备份互通。

	ipcMain.handle('settings:get', async () => {
		try {
			return { ok: true, data: await getSettings().describe() }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('settings:update', async (_event, patch) => {
		try {
			const settings = getSettings()
			await settings.update(patch ?? {})
			// 主题偏好 / 材质强度 / 配色种子可能刚被改掉，立刻把解析后的变量
			// 推给所有窗口，不等下一次 `theme:describe`
			if (
				patch &&
				('theme' in patch ||
					'materialLevel' in patch ||
					'accentMode' in patch ||
					'accentColor' in patch)
			) {
				broadcastTheme()
			}
			return { ok: true, data: await settings.describe() }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	// ---------- 主题（阶段 1）----------
	//
	// 令牌包里的语义值 → CSS 变量。渲染进程只负责把 `css` 塞进一个
	// `<style>`、把 `mode` 写进 `documentElement.dataset.theme`。
	//
	// 「跟随系统」由主进程解析：`nativeTheme.shouldUseDarkColors` 就是系统级的
	// 深浅色事实，`nativeTheme.on('updated')` 在系统切换时触发。

	ipcMain.handle('theme:describe', async () => {
		try {
			return { ok: true, data: await describeCurrentTheme() }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	nativeTheme.on('updated', () => {
		// 系统深浅色变了。只有偏好是 `system` 时才需要重推，但这里不做判断 ——
		// 推一次的成本是一个 IPC，而漏推的后果是「跟随系统」失效。
		broadcastTheme()
	})

	// ---------- 播放历史（Phase 3.5）----------
	//
	// `play_history` 是共用 schema 里的表，此前桌面端只建表、从不写入。
	// 这里把它接上：一次「播放会话」一行，播放中定期更新已播时长。

	ipcMain.handle('history:startSession', (_event, trackId) => {
		try {
			return { ok: true, data: { historyId: db.startPlaySession(trackId) } }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('history:updateSession', (_event, payload) => {
		try {
			const { historyId, durationPlayed, completed } = payload ?? {}
			return {
				ok: true,
				data: db.updatePlaySession(
					historyId,
					durationPlayed ?? 0,
					Boolean(completed),
				),
			}
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('history:recent', (_event, limit) => {
		try {
			return { ok: true, data: db.listRecentlyPlayed({ limit: limit ?? 50 }) }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('history:mostPlayed', (_event, limit) => {
		try {
			return { ok: true, data: db.listMostPlayed({ limit: limit ?? 50 }) }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('history:resume', (_event, limit) => {
		try {
			return { ok: true, data: db.listResumeCandidates({ limit: limit ?? 20 }) }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('history:summary', () => {
		try {
			return { ok: true, data: db.getPlayHistorySummary() }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('history:stats', (_event, trackId) => {
		try {
			return { ok: true, data: db.getTrackPlayStats(trackId) }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('history:clear', () => {
		try {
			return { ok: true, data: { removed: db.clearPlayHistory() } }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	/** 按 bvid 找本地曲目 id（播放历史要用它，而播放器只有 bvid） */
	ipcMain.handle('db:findTrackByBvid', (_event, bvid) => {
		try {
			return { ok: true, data: db.findTrackIdByBvid(bvid) }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	// ---------- 外部歌单导入（Phase 3.3）----------
	//
	// 分三步，**由渲染进程驱动循环**：
	//   1. `import:fetchPlaylist` 拉远端歌单（一次）
	//   2. `import:matchTrack` 逐首匹配（渲染进程一首一次 IPC）
	//   3. `import:start` 把用户确认后的结果落库
	//
	// 为什么不把匹配做成「一次调用整批」：那样进度只能靠推送通道回传，
	// 而多一条推送通道就多一处状态同步。逐首 IPC 让渲染进程天然知道进度，
	// 而且用户能中途停（不发下一次调用即可）。

	ipcMain.handle('import:fetchPlaylist', async (_event, input) => {
		try {
			const { fetchPlaylist } = require('./netease-playlist.cjs')
			return { ok: true, data: await fetchPlaylist(input) }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	ipcMain.handle('import:matchTrack', async (_event, track) => {
		try {
			const { matchTrack } = require('./track-matcher.cjs')
			return { ok: true, data: await matchTrack(track) }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	})

	/**
	 * 落库导入结果。
	 *
	 * `items` 由渲染进程给出（用户可能改过匹配、或剔除了几首），所以这里
	 * **不再重新匹配** —— 尊重用户的选择。
	 */
	ipcMain.handle('import:start', async (_event, payload) => {
		try {
			const { title, remoteId, cover, items, source } = payload ?? {}
			if (!Array.isArray(items) || items.length === 0) {
				throw new Error('没有要导入的曲目')
			}
			const { importMatched } = require('./track-matcher.cjs')
			const data = await importMatched({
				title: title ?? `导入歌单 ${remoteId ?? ''}`,
				remoteId: remoteId ?? '',
				cover: cover ?? null,
				items,
				// 复用 bilibili-api 的 view 接口取 cid/作者（与收藏夹导入同一路径）
				resolveInfo: (bvid) => bilibiliApi.getVideoInfo(bvid),
				db,
			})
			// 歌单是共享的就把这次新增记进 outbox 并后台推送
			enqueueSharedAdd(data.playlistId, data.addedTrackIds)

			return { ok: true, data: { ...data, source: source ?? 'netease' } }
		} catch (error) {
			return { ok: false, error: error.message }
		}
	}) // ---------- 诊断 ----------
	ipcMain.handle('probe:request-log', () => requestLog)
	ipcMain.handle('probe:ports', () => describePorts())
	registerShareHandlers()
}

// ===============================================================
// 共享歌单（Phase 3.4）
// ===============================================================
//
// 与 B 站登录态并存但**互相独立**：共享用的是 BBPlayer 自己后端的账号
// （见 `bbplayer-account.cjs` 的说明）。因此这里不去动 `login:*` 的任何东西。

/**
 * 懒创建「账号 + 共享」门面。
 *
 * 和下载/备份管理器同样的理由：`bbplayer-account.cjs` 会去读 `safeStorage`
 * （要 app ready 之后才可用），纯 Node 的验证脚本不该被迫走这一步。
 */
let sharedModule = null

function getShared() {
	if (!sharedModule) {
		sharedModule = createSharedPlaylistModule({
			account: createAccountModule(),
		})
	}
	return sharedModule
}

/**
 * 把一次本地改动入队并在后台推上去。
 *
 * 调用方（导入收藏夹 / 合集 / 外部歌单）只关心「我往歌单里加了哪些曲目」，
 * 不需要知道共享的存在；这里做「如果是共享歌单就记一笔并同步」。
 *
 * **后台推**：推送是网络操作，不能挡在导入的返回路径上；失败也只是把 outbox
 * 标成 `failed` 等下次重试，用户仍能看到导入成功。
 */
function enqueueSharedAdd(playlistId, trackIds) {
	if (!trackIds || trackIds.length === 0) return
	try {
		const shared = getShared()
		const result = shared.queueLocalChange(playlistId, 'add_tracks', {
			trackIds,
		})
		if (result.queued) syncSharedInBackground(shared, playlistId)
	} catch (error) {
		// 共享是附加能力：它出问题不能把导入本身弄失败
		logger.warn(`[share] 入队失败: ${error.message}`)
	}
}

/**
 * 后台推一次。
 *
 * 刻意不 `await`：同步要发网络请求，而它的成败不该决定「导入是否成功」。
 * 失败时 outbox 里那些行已经是 `failed`，用户点「同步」就能重试。
 */
function syncSharedInBackground(shared, playlistId) {
	shared.syncPlaylist(playlistId).catch((error) => {
		logger.warn(`[share] 后台同步失败: ${error.message}`)
	})
}

/**
 * 统一把异常转成 `{ok, error, status, code}`。
 *
 * 放在模块作用域（不在 `registerShareHandlers` 里面）：它不捕获任何局部变量，
 * 每次注册都新建一个函数对象没有意义。
 */
const wrapShareHandler =
	(fn) =>
	async (_event, ...args) => {
		try {
			return { ok: true, data: await fn(...args) }
		} catch (error) {
			return {
				ok: false,
				error: error.message,
				status: error.status ?? null,
				code: error.code ?? null,
			}
		}
	}

/**
 * 解析当前主题（偏好来自设置，系统事实来自 `nativeTheme`）。
 *
 * `theme.cjs` 是纯函数模块，这里只负责把两个输入喂给它。
 *
 * ⚠️ `settings.describe()` 返回的是 `{ settings, themes, sleepPresets, … }`，
 * 偏好藏在 **`settings.settings.theme`** 里。第一版按扁平结构读了
 * `described.theme`，拿到 `undefined` → `normalizePreference` 回退成 `system`
 * → **改主题偏好完全不起作用**（界面永远跟随系统）。
 * 由 `verify:desktop:settings` 的「切回深色生效」断言抓到。
 */
async function describeCurrentTheme() {
	const { describeTheme } = require('./theme.cjs')
	const described = await getSettings().describe()
	const settings = described.settings ?? {}
	return describeTheme(
		settings.theme,
		nativeTheme.shouldUseDarkColors,
		settings.materialLevel,
		resolveAccentSeed(settings),
	)
}

/**
 * 解析配色**种子色**（阶段 4）。
 *
 * * `accentMode === 'custom'` → 用用户选的颜色；
 * * 否则 → 用**系统强调色**（Windows 的个性化强调色）。
 *
 * ⚠️ `systemPreferences.getAccentColor()` **只在 Windows 上可用**，
 * 而且返回的是**带 alpha 的 8 位**（例如 `d0bcffff`）。Linux 上这个方法
 * 不存在或返回空串。所以：
 *   * 先判方法在不在；
 *   * 拿不到就返回 null，让 `resolveColors` 用基线调色板 ——
 *     **不做平台判断**（问能力，不问平台），这样将来别的平台支持了自动生效。
 */
function resolveAccentSeed(settings) {
	if (settings.accentMode === 'custom') {
		return settings.accentColor ?? null
	}
	try {
		const { systemPreferences } = require('electron')
		if (typeof systemPreferences?.getAccentColor !== 'function') return null
		const raw = systemPreferences.getAccentColor()
		return typeof raw === 'string' && raw.length >= 6 ? raw : null
	} catch {
		// 取不到系统强调色不是错误，退回基线
		return null
	}
}

/** 把解析后的主题推给所有窗口（系统切换 / 用户改偏好时调用） */
function broadcastTheme() {
	void describeCurrentTheme()
		.then((theme) => {
			for (const window of BrowserWindow.getAllWindows()) {
				if (!window.isDestroyed()) {
					window.webContents.send('theme:changed', theme)
				}
			}
		})
		.catch((error) => logger.warn(`[theme] 推送失败: ${error.message}`))
}

function registerShareHandlers() {
	/** 统一把异常转成 `{ok,error,status}`，避免渲染进程收到 Electron 的序列化错误 */
	ipcMain.handle(
		'share:status',
		wrapShareHandler(async () => {
			const shared = getShared()
			return {
				...shared.accountStatus(),
				sharedPlaylists: shared.listSharedPlaylists(),
			}
		}),
	)

	ipcMain.handle(
		'share:setBaseUrl',
		wrapShareHandler(async (url) => ({ baseUrl: getShared().setBaseUrl(url) })),
	)
	ipcMain.handle(
		'share:register',
		wrapShareHandler(async (payload) => getShared().register(payload)),
	)
	ipcMain.handle(
		'share:login',
		wrapShareHandler(async (payload) => getShared().login(payload)),
	)
	ipcMain.handle(
		'share:logout',
		wrapShareHandler(async () => getShared().logout()),
	)
	ipcMain.handle(
		'share:me',
		wrapShareHandler(async () => getShared().me()),
	)

	ipcMain.handle(
		'share:listPlaylists',
		wrapShareHandler(async () => getShared().listSharedPlaylists()),
	)
	ipcMain.handle(
		'share:playlist',
		wrapShareHandler(async (playlistId) =>
			getShared().sharePlaylist(playlistId),
		),
	)
	ipcMain.handle(
		'share:unshare',
		wrapShareHandler(async (playlistId) =>
			getShared().unsharePlaylist(playlistId),
		),
	)
	/**
	 * 只清本地共享标记（歌单与曲目保留）。
	 *
	 * 用在「远端歌单已经没了 / 我们被移出成员」的场景 —— 那时再发请求只会拿到
	 * 404/403，用户需要的是把这一行从共享列表里摘掉，而不是丢掉整个歌单。
	 */
	ipcMain.handle(
		'share:detach',
		wrapShareHandler(async (playlistId) =>
			getShared().detachSharedPlaylist(playlistId),
		),
	)
	ipcMain.handle(
		'share:preview',
		wrapShareHandler(async (input) => getShared().preview(input)),
	)
	ipcMain.handle(
		'share:subscribe',
		wrapShareHandler(async ({ input, inviteCode }) =>
			getShared().subscribe(input, { inviteCode }),
		),
	)
	ipcMain.handle(
		'share:sync',
		wrapShareHandler(async (playlistId) =>
			getShared().syncPlaylist(playlistId),
		),
	)
	ipcMain.handle(
		'share:syncAll',
		wrapShareHandler(async () => getShared().syncAll()),
	)
	ipcMain.handle(
		'share:restore',
		wrapShareHandler(async () => getShared().restoreFromCloud()),
	)
	ipcMain.handle(
		'share:invite',
		wrapShareHandler(async (playlistId) =>
			getShared().getInviteCode(playlistId),
		),
	)
	ipcMain.handle(
		'share:rotateInvite',
		wrapShareHandler(async (playlistId) =>
			getShared().rotateInviteCode(playlistId),
		),
	)
	ipcMain.handle(
		'share:members',
		wrapShareHandler(async (playlistId) => getShared().listMembers(playlistId)),
	)

	/**
	 * 从歌单里移除一首曲目。
	 *
	 * 这是「本地改动 → outbox」的**唯一**入口：数据库层只负责删行，
	 * 共享语义（要不要推送、推什么）留在这里，免得 db 层反向依赖共享模块。
	 */
	ipcMain.handle(
		'playlist:removeTrack',
		wrapShareHandler(async ({ playlistId, trackId }) => {
			const removed = db.removeTrackFromPlaylist(playlistId, trackId)
			if (removed) {
				const shared = getShared()
				const queued = shared.queueLocalChange(playlistId, 'remove_tracks', {
					removedTrackIds: [trackId],
				})
				if (queued.queued) syncSharedInBackground(shared, playlistId)
			}
			return { removed }
		}),
	)
}

module.exports = { registerIpcHandlers, ensureDatabase }
