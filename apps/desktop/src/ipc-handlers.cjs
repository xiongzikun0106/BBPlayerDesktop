/**
 * 主进程的 IPC handler 注册。
 *
 * 渲染进程只能通过 preload 暴露的这几个方法访问数据；所有 DB / 网络访问都在
 * 主进程完成（渲染进程没有 Node 权限，contextIsolation 打开）。
 */
const path = require('node:path')

const { ipcMain } = require('electron')

const bilibiliApi = require('./bilibili-api.cjs')
const db = require('./db.cjs')
const { requestLog, resolveAudio } = require('./audio-proxy.cjs')
const { core, describePorts } = require('./ports.cjs')
const { loadTsFile } = require('./core-loader.cjs')

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
			const failures = []
			for (const [index, archive] of archives.entries()) {
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
					if (db.addTrackToPlaylist(playlist.id, track.id, index)) added += 1
				} catch (error) {
					failures.push({ bvid: archive.bvid, error: error.message })
				}
			}

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

	// ---------- 诊断 ----------
	ipcMain.handle('probe:request-log', () => requestLog)
	ipcMain.handle('probe:ports', () => describePorts())
}

module.exports = { registerIpcHandlers, ensureDatabase }
