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

	// ---------- 登录（Phase 3）----------
	//
	// ⚠️ cookie 的值**从不**回传渲染进程：`loginStatus` 给的是账号摘要，
	// `qrCreate` 给的是二维码 PNG，`importCookie` 是单向写入。
	loginStatus: () => ipcRenderer.invoke('login:status'),
	loginQrCreate: () => ipcRenderer.invoke('login:qrCreate'),
	loginQrPoll: (qrcodeKey) => ipcRenderer.invoke('login:qrPoll', qrcodeKey),
	loginWithPassword: (username, password) =>
		ipcRenderer.invoke('login:password', { username, password }),
	importCookie: (input) => ipcRenderer.invoke('login:importCookie', input),
	logout: () => ipcRenderer.invoke('login:logout'),

	// ---------- 收藏夹（Phase 3）----------
	favoriteFolders: (mid) => ipcRenderer.invoke('bili:favoriteFolders', mid),
	favoriteResources: (mediaId) =>
		ipcRenderer.invoke('bili:favoriteResources', mediaId),
	syncFavoriteToPlaylist: (payload) =>
		ipcRenderer.invoke('bili:syncFavoriteToPlaylist', payload),

	// ---------- 歌词（网易云）----------
	searchLyrics: (keyword, limit) =>
		ipcRenderer.invoke('lyrics:search', keyword, limit),
	fetchLyrics: (songId) => ipcRenderer.invoke('lyrics:fetch', songId),
	autoMatchLyrics: (meta) => ipcRenderer.invoke('lyrics:autoMatch', meta),

	// ---------- 系统媒体集成（Phase 4）----------
	//
	// 主进程会在任务栏缩略图按钮 / 硬件媒体键被按下时推一个动作名过来；
	// 渲染进程只认识动作名（`toggle` / `next` / ...），不知道来源。
	onMediaAction: (handler) => {
		const listener = (_event, action) => handler(action)
		ipcRenderer.on('media:action', listener)
		// 返回取消订阅，便于测试里卸载
		return () => ipcRenderer.removeListener('media:action', listener)
	},
	/** 同步任务栏按钮的播放/暂停图标 */
	setThumbnailPlaying: (playing) =>
		ipcRenderer.invoke('media:setThumbnailPlaying', playing),
	/** 启用硬件媒体键兜底（默认关闭，见 media-integration.cjs 说明） */
	setMediaKeysEnabled: (enabled) =>
		ipcRenderer.invoke('media:setKeysEnabled', enabled),
	/** 媒体集成诊断 */
	mediaInfo: () => ipcRenderer.invoke('media:info'),

	// ---------- 下载（Phase 4.3）----------
	download: {
		enqueue: (track) => ipcRenderer.invoke('download:enqueue', track),
		enqueueMany: (tracks) => ipcRenderer.invoke('download:enqueueMany', tracks),
		cancel: (bvid) => ipcRenderer.invoke('download:cancel', bvid),
		listTasks: () => ipcRenderer.invoke('download:listTasks'),
		listDownloaded: () => ipcRenderer.invoke('download:listDownloaded'),
		clearFinished: () => ipcRenderer.invoke('download:clearFinished'),
		openFolder: () => ipcRenderer.invoke('download:openFolder'),
		info: () => ipcRenderer.invoke('download:info'),
		/**
		 * 订阅下载进度。
		 *
		 * 主进程目前**不主动推**进度（渲染进程按需轮询 `listTasks`）——
		 * 桌面端是本地磁盘写入，轮询 500ms 的开销可忽略，
		 * 而少一条推送通道就少一处状态同步 bug。
		 */
	},

	// ---------- 备份 / 恢复（Phase 4.5）----------
	//
	// ⚠️ `restore*` 成功后数据库连接会被关闭，**必须重启应用**。
	backup: {
		config: () => ipcRenderer.invoke('backup:config'),
		saveConfig: (payload) => ipcRenderer.invoke('backup:saveConfig', payload),
		testConnection: () => ipcRenderer.invoke('backup:testConnection'),
		exportLocal: () => ipcRenderer.invoke('backup:exportLocal'),
		inspectLocal: (filePath) =>
			ipcRenderer.invoke('backup:inspectLocal', filePath),
		restoreLocal: (filePath) =>
			ipcRenderer.invoke('backup:restoreLocal', filePath),
		listRemote: () => ipcRenderer.invoke('backup:listRemote'),
		upload: () => ipcRenderer.invoke('backup:upload'),
		downloadRemote: (remotePath) =>
			ipcRenderer.invoke('backup:downloadRemote', remotePath),
	},

	// ---------- 设置（Phase 4 收尾）----------
	settings: {
		/** 读全部设置 + 常量（主题列表、定时预设、淡出时长） */
		get: () => ipcRenderer.invoke('settings:get'),
		/** 合并式写入；返回写入后的完整设置 */
		update: (patch) => ipcRenderer.invoke('settings:update', patch),
	},
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
