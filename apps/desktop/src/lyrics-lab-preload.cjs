/**
 * 歌词测试台专用的 preload。
 *
 * 刻意**不复用** `preload.cjs`：那个文件是主应用的契约（且正在被别人改），
 * 测试台只需要歌词相关的三个方法。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bbplayerLyricsLab', {
	/** 搜索网易云歌词候选：{ keyword, limit?, song? } -> { ok, ranked } */
	search: (payload) => ipcRenderer.invoke('lyrics-lab:search', payload),
	/** 取歌词并解析：{ songId } -> { ok, lines, isInstrumental } */
	lyrics: (payload) => ipcRenderer.invoke('lyrics-lab:lyrics', payload),
	/** 截图落盘：name -> { ok, file } */
	capture: (name) => ipcRenderer.invoke('lyrics-lab:capture', name),
})
