/**
 * Preload：只暴露必要的、受控的能力给渲染进程。
 * contextIsolation 打开，渲染进程拿不到 Node。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bbplayer', {
	/** 解析一个 bvid 为可播放代理地址 */
	resolveAudio: (bvid) => ipcRenderer.invoke('audio:resolve', bvid),
})

/**
 * 自验证通道。
 * 只在开发/验证时使用；生产版本应删掉或加开关。
 */
contextBridge.exposeInMainWorld('bbProbe', {
	requestLog: () => ipcRenderer.invoke('probe:request-log'),
	screenshot: (name) => ipcRenderer.invoke('probe:screenshot', name),
	execute: (code) => ipcRenderer.invoke('probe:execute', code),
})
