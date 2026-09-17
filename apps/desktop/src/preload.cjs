/**
 * Preload：只暴露必要的、受控的能力给渲染进程。
 *
 * `contextIsolation` 打开、`nodeIntegration` 关闭，渲染进程拿不到 Node，
 * 所有数据访问都通过下面这些 IPC 方法走主进程。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bbplayer', {
	// ---------- 音频 ----------
	/** 解析一个 bvid 为可播放代理地址 */
	resolveAudio: (bvid) => ipcRenderer.invoke('audio:resolve', bvid),

	// ---------- 歌单（本地库） ----------
	listPlaylists: () => ipcRenderer.invoke('db:listPlaylists'),
	getPlaylistTracks: (playlistId) =>
		ipcRenderer.invoke('db:getPlaylistTracks', playlistId),
	createPlaylist: (payload) => ipcRenderer.invoke('db:createPlaylist', payload),

	// ---------- B 站 ----------
	search: (keyword) => ipcRenderer.invoke('bili:search', keyword),
	videoInfo: (bvid) => ipcRenderer.invoke('bili:videoInfo', bvid),
	userSeasons: (mid) => ipcRenderer.invoke('bili:userSeasons', mid),
	seasonArchives: (mid, seasonId) =>
		ipcRenderer.invoke('bili:seasonArchives', mid, seasonId),
	importSeasonToPlaylist: (payload) =>
		ipcRenderer.invoke('bili:importSeasonToPlaylist', payload),

	// ---------- 歌词（网易云）----------
	searchLyrics: (keyword, limit) =>
		ipcRenderer.invoke('lyrics:search', keyword, limit),
	fetchLyrics: (songId) => ipcRenderer.invoke('lyrics:fetch', songId),
	autoMatchLyrics: (meta) => ipcRenderer.invoke('lyrics:autoMatch', meta),
})

/**
 * 自验证通道。
 *
 * ⚠️ 目前无条件暴露。生产化时应加开关（如仅在 `--probe` 模式下暴露），
 * 或在打包配置里剔除。
 */
contextBridge.exposeInMainWorld('bbProbe', {
	requestLog: () => ipcRenderer.invoke('probe:request-log'),
	ports: () => ipcRenderer.invoke('probe:ports'),
	screenshot: (name) => ipcRenderer.invoke('probe:screenshot', name),
	execute: (code) => ipcRenderer.invoke('probe:execute', code),
})
