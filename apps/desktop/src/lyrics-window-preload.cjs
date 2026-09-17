/**
 * 独立歌词窗口的 preload。
 *
 * 刻意**不复用** `preload.cjs`：那个文件是主窗口的契约（暴露了设置、下载、
 * 备份等一大堆能力），而歌词窗口只需要「收歌词 + 报两个动作」。
 * 按最小权限原则单独一个文件 —— 歌词窗口内容最简单，被攻击的面也最小。
 */
const { contextBridge, ipcRenderer } = require('electron')

/** 把主进程推来的事件包成「注册回调」的形式，并返回取消订阅 */
const subscribe = (channel) => (handler) => {
	const listener = (_event, payload) => handler(payload)
	ipcRenderer.on(channel, listener)
	return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('bbLyricsWindowBridge', {
	// ---------- 收 ----------
	onLyrics: subscribe('lw:update'),
	onPosition: subscribe('lw:position'),
	onTrack: subscribe('lw:track'),
	onProgress: subscribe('lw:progress'),
	/** 主进程推来的锁定状态（窗口打开时同步一次） */
	onLocked: subscribe('lw:locked'),

	// ---------- 发 ----------
	close: () => ipcRenderer.invoke('lw:requestClose'),
	setLocked: (locked) => ipcRenderer.invoke('lw:setLocked', locked),
	/** 就绪握手：主动要一次当前歌词/曲目，避免等下一次推送 */
	ready: () => ipcRenderer.invoke('lw:ready'),
})
