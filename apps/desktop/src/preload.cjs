/**
 * Preload：只暴露必要的、受控的能力给渲染进程。
 *
 * `contextIsolation` 打开、`nodeIntegration` 关闭，渲染进程拿不到 Node，
 * 所有数据访问都通过下面这些 IPC 方法走主进程。
 */
const { contextBridge, ipcRenderer } = require('electron')

/** 把主进程推来的事件包成「注册回调」的形式，并返回取消订阅 */
const subscribe = (channel) => (handler) => {
	const listener = (_event, payload) => handler(payload)
	ipcRenderer.on(channel, listener)
	return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('bbplayer', {
	// ---------- 音频 ----------
	/** 解析一个 bvid 为可播放代理地址 */
	resolveAudio: (bvid) => ipcRenderer.invoke('audio:resolve', bvid),

	// ---------- 歌单（本地库） ----------
	listPlaylists: () => ipcRenderer.invoke('db:listPlaylists'),
	getPlaylistTracks: (playlistId) =>
		ipcRenderer.invoke('db:getPlaylistTracks', playlistId),
	/** 歌单内重排（更改列表顺序）：传下标，不传 sortKey */
	movePlaylistTrack: (payload) =>
		ipcRenderer.invoke('db:movePlaylistTrack', payload),
	createPlaylist: (payload) => ipcRenderer.invoke('db:createPlaylist', payload),
	/** 把曲目加入歌单（阶段 6c）；重复项被静默忽略，返回 {added,skipped,total} */
	addTracksToPlaylist: (payload) =>
		ipcRenderer.invoke('db:addTracksToPlaylist', payload),
	/** 歌单自定义封面：弹系统文件框选图，复制进数据目录并写库（阶段 C-2d） */
	pickPlaylistCover: (playlistId) =>
		ipcRenderer.invoke('playlist:pickCover', playlistId),
	/** 恢复默认封面（= 第一首曲目的封面） */
	clearPlaylistCover: (playlistId) =>
		ipcRenderer.invoke('playlist:clearCover', playlistId),

	// ---------- B 站 ----------
	search: (keyword) => ipcRenderer.invoke('bili:search', keyword),
	videoInfo: (bvid) => ipcRenderer.invoke('bili:videoInfo', bvid),
	/**
	 * 后台补封面：传一批**缺封面**的 bvid，主进程串行拉 `pic` 并写库。
	 * 返回 `{ updated: [{ bvid, cover }], failures }`。
	 */
	backfillCovers: (bvids) => ipcRenderer.invoke('covers:backfill', { bvids }),
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

	// ---------- 外部歌单导入（Phase 3.3）----------
	//
	// 流程：fetchPlaylist -> 逐首 matchTrack -> start。
	// 匹配由渲染进程驱动循环，所以进度是天然的、可中断的。
	externalImport: {
		fetchPlaylist: (input) => ipcRenderer.invoke('import:fetchPlaylist', input),
		matchTrack: (track) => ipcRenderer.invoke('import:matchTrack', track),
		start: (payload) => ipcRenderer.invoke('import:start', payload),
	},

	// ---------- 播放历史（Phase 3.5）----------
	history: {
		/** 开始一次播放会话，返回 historyId */
		startSession: (trackId) =>
			ipcRenderer.invoke('history:startSession', trackId),
		/** 更新已播时长（播放中定期调用）+ 是否播完 */
		updateSession: (payload) =>
			ipcRenderer.invoke('history:updateSession', payload),
		recent: (limit) => ipcRenderer.invoke('history:recent', limit),
		mostPlayed: (limit) => ipcRenderer.invoke('history:mostPlayed', limit),
		/** 「继续收听」：没听完的曲目 */
		resume: (limit) => ipcRenderer.invoke('history:resume', limit),
		summary: () => ipcRenderer.invoke('history:summary'),
		/** 热力图：`{ 'YYYY-MM-DD': 次数 }`（按**本地日期**分组） */
		heatmap: () => ipcRenderer.invoke('history:heatmap'),
		/** 某一天听过的曲目（热力图点一格进去） */
		byDate: (date, limit) =>
			ipcRenderer.invoke('history:byDate', { date, limit }),
		stats: (trackId) => ipcRenderer.invoke('history:stats', trackId),
		clear: () => ipcRenderer.invoke('history:clear'),
	},
	/** 按 bvid 找本地曲目 id（播放历史要用） */
	findTrackByBvid: (bvid) => ipcRenderer.invoke('db:findTrackByBvid', bvid),

	// ---------- 独立歌词窗口（Phase 4.1）----------
	//
	// 数据流：主窗口 -> 主进程 -> 歌词窗口。渲染进程之间不能直接通信，
	// 所以主进程只做转发（它不理解歌词内容）。
	lyricsWindow: {
		open: () => ipcRenderer.invoke('lyrics-window:open'),
		close: () => ipcRenderer.invoke('lyrics-window:close'),
		toggle: () => ipcRenderer.invoke('lyrics-window:toggle'),
		status: () => ipcRenderer.invoke('lyrics-window:status'),
		/** 推整首歌词（换曲或重新匹配时） */
		pushLyrics: (lines) => ipcRenderer.invoke('lw:update', lines),
		/** 推当前位置（高频） */
		pushPosition: (seconds) => ipcRenderer.invoke('lw:position', seconds),
		pushTrack: (info) => ipcRenderer.invoke('lw:track', info),
		pushProgress: (ratio) => ipcRenderer.invoke('lw:progress', ratio),
		/** 歌词窗口开/关、以及它就绪后主动要状态时的事件 */
		onOpened: subscribe('lyrics-window:opened'),
		onClosed: subscribe('lyrics-window:closed'),
		onRequestState: subscribe('lyrics-window:requestState'),
	},

	// ---------- 设置（Phase 4 收尾）----------
	settings: {
		/** 读全部设置 + 常量（主题列表、定时预设、淡出时长） */
		get: () => ipcRenderer.invoke('settings:get'),
		/** 合并式写入；返回写入后的完整设置 */
		update: (patch) => ipcRenderer.invoke('settings:update', patch),
	},
	/**
	 * 共享歌单（Phase 3.4）。
	 *
	 * 所有调用都返回 `{ok, data}` 或 `{ok:false, error, status, code}` ——
	 * 共享会失败在**很多种**原因上（没登录 / 网络 / 404 / 403 / 邀请码不对），
	 * 渲染进程必须能区分「重登」和「提示」，所以错误不吞成 undefined。
	 */
	share: {
		/** 账号状态 + 本地共享歌单列表 */
		status: () => ipcRenderer.invoke('share:status'),
		setBaseUrl: (url) => ipcRenderer.invoke('share:setBaseUrl', url),
		register: (payload) => ipcRenderer.invoke('share:register', payload),
		login: (payload) => ipcRenderer.invoke('share:login', payload),
		logout: () => ipcRenderer.invoke('share:logout'),
		me: () => ipcRenderer.invoke('share:me'),

		listPlaylists: () => ipcRenderer.invoke('share:listPlaylists'),
		/** 把一个本地歌单分享到云端（幂等） */
		share: (playlistId) => ipcRenderer.invoke('share:playlist', playlistId),
		/** 取消共享（owner 删远端歌单，其余角色退出协作） */
		unshare: (playlistId) => ipcRenderer.invoke('share:unshare', playlistId),
		/** 只清本地共享标记（远端已消失/被移出时用；歌单与曲目保留） */
		detach: (playlistId) => ipcRenderer.invoke('share:detach', playlistId),
		/** 公开预览：不需要登录 */
		preview: (input) => ipcRenderer.invoke('share:preview', input),
		subscribe: (payload) => ipcRenderer.invoke('share:subscribe', payload),
		sync: (playlistId) => ipcRenderer.invoke('share:sync', playlistId),
		syncAll: () => ipcRenderer.invoke('share:syncAll'),
		restore: () => ipcRenderer.invoke('share:restore'),
		invite: (playlistId) => ipcRenderer.invoke('share:invite', playlistId),
		rotateInvite: (playlistId) =>
			ipcRenderer.invoke('share:rotateInvite', playlistId),
		members: (playlistId) => ipcRenderer.invoke('share:members', playlistId),
	},
	playlist: {
		/** 从歌单移除一首曲目；共享歌单会顺带把删除推给协作者 */
		removeTrack: (payload) =>
			ipcRenderer.invoke('playlist:removeTrack', payload),
	},
	/**
	 * 诊断信息（实现细节唯一的去处）。
	 *
	 * 主界面不展示「密钥环 / 未加密 / 绝对路径」这类东西，但它们必须**可查** ——
	 * 集中在这里，由「设置 › 诊断信息」折叠区读取。
	 */
	diagnostics: () => ipcRenderer.invoke('diagnostics:info'),
	/** 重启应用（恢复备份后需要） */
	relaunch: () => ipcRenderer.invoke('app:relaunch'),
	/**
	 * 用系统浏览器打开链接（关于页的「前往 GitHub」）。
	 *
	 * ⚠️ 主进程侧有**白名单**校验 —— 不是任意 URL 都能开，
	 * 所以渲染进程即使被注入也拉不起别的网址。
	 */
	openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
	/**
	 * 订阅**顶部播放菜单**的动作（阶段 6）。
	 *
	 * 主进程只发明文组合键（`'space'` / `'shift+arrowleft'`…），
	 * 渲染进程用 `bbKeys.trigger(combo)` 转交给已注册的处理器 ——
	 * 菜单与快捷键因此**永远同源**，不会各写一套行为。
	 */
	onMenuAction: (callback) => {
		const listener = (_event, combo) => callback(combo)
		ipcRenderer.on('menu:action', listener)
		return () => ipcRenderer.removeListener('menu:action', listener)
	},
	/**
	 * 主题（阶段 1）。
	 *
	 * 主进程把设计令牌解析成 CSS 变量下发；渲染进程只负责应用。
	 * `onChanged` 在系统深浅色切换、或用户改了偏好时触发。
	 */
	theme: {
		describe: () => ipcRenderer.invoke('theme:describe'),
		onChanged: (handler) => {
			const listener = (_event, theme) => handler(theme)
			ipcRenderer.on('theme:changed', listener)
			return () => ipcRenderer.removeListener('theme:changed', listener)
		},
	},
})

/**
 * 自验证通道（`window.bbProbe`）。
 *
 * ⚠️ **只在探针模式下暴露**。
 *
 * 早期版本是无条件暴露的，理由是「反正渲染进程加载的是本地页面」——
 * 但这仍是没必要的能力面：`bbProbe.execute` 能在渲染进程里跑任意 JS，
 * 而渲染进程是要渲染**远端封面图**的（`<img src="https://i0.hdslb.com/...">`）。
 * 一个图片解码器的漏洞就足以把攻击面接到这些能力上，所以按最小权限关掉。
 *
 * 判断依据由主进程通过 `additionalArguments` 注入（见 `main.cjs`），
 * 而不是在这里读 `process.argv` —— 打包后 `process.env.NODE_ENV`
 * 之类的推断都不可靠，显式传入才是硬事实。
 */
const PROBE_ENABLED = process.argv.includes('--bb-probe-enabled')

if (PROBE_ENABLED) {
	contextBridge.exposeInMainWorld('bbProbe', {
		requestLog: () => ipcRenderer.invoke('probe:request-log'),
		ports: () => ipcRenderer.invoke('probe:ports'),
		screenshot: (name) => ipcRenderer.invoke('probe:screenshot', name),
		execute: (code) => ipcRenderer.invoke('probe:execute', code),
	})
}
