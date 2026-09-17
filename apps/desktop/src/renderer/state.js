/**
 * 渲染进程的极简状态层。
 *
 * 刻意不引框架：桌面端 UI 的重写成本主要在这里，保持轻量便于迭代。
 * 采用「单一 store + 订阅」模式，与移动端的 Zustand 思路一致。
 */
;(function () {
	'use strict'

	const listeners = new Set()

	const state = {
		/** 当前视图：library | search | collection | playlist */
		view: 'library',
		/** 左栏选中的歌单 id（null 表示未选） */
		selectedPlaylistId: null,
		/** 当前视图的曲目列表 */
		tracks: [],
		/** 当前视图标题 */
		title: '音乐库',
		/** 播放队列（由 player 维护） */
		queue: [],
		queueIndex: -1,
		/** 最近一次搜索关键词 */
		lastQuery: '',
		/** 右栏面板：queue | lyrics */
		rightPanel: 'queue',
	}

	function get() {
		return state
	}

	/** 合并式更新，并通知订阅者 */
	function set(patch) {
		let changed = false
		for (const key of Object.keys(patch)) {
			if (state[key] !== patch[key]) {
				state[key] = patch[key]
				changed = true
			}
		}
		if (changed) emit()
	}

	function subscribe(fn) {
		listeners.add(fn)
		return () => listeners.delete(fn)
	}

	function emit() {
		for (const fn of listeners) {
			try {
				fn(state)
			} catch (error) {
				// 单个订阅者出错不应影响其他订阅者
				console.error('[state] 订阅者抛错:', error)
			}
		}
	}

	window.bbState = { get, set, subscribe }
})()
