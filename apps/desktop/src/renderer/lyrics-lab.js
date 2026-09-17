/**
 * 歌词测试台的控制脚本（仅 lyrics-lab.html 使用）。
 *
 * 三件事：
 *  1. 用内置 / 离线合成的歌词驱动面板，验证「高亮 + 居中 + 偏移」；
 *  2. 通过 `window.bbplayerLyricsLab`（由 lyrics-lab-main.cjs 暴露）拉真实
 *     网络歌词，走的是主进程里注册好的 core 端口；
 *  3. 把面板与助手挂到 window，便于脚本 / CDP 断言。
 */
;(function runLyricsLab(global) {
	'use strict'

	const $ = (id) => document.getElementById(id)
	const statusEl = $('lab-status')

	function setStatus(text, isError) {
		if (!statusEl) return
		statusEl.textContent = text
		statusEl.classList.toggle('lab__error', Boolean(isError))
	}

	// ── 内置示例歌词（离线，保证页面本身总是能看到东西）──────────
	const DEMO_LINES = [
		{
			startTime: 0,
			content: '作词 : Stock Aitken Waterman',
			translation: null,
		},
		{
			startTime: 12000,
			content: "We're no strangers to love",
			translation: '我们对爱并不陌生',
		},
		{
			startTime: 18000,
			content: 'You know the rules and so do I',
			translation: '你知道规则，我也一样',
		},
		{
			startTime: 24000,
			content: "A full commitment's what I'm thinking of",
			translation: '我想要的是一份完全的承诺',
		},
		{
			startTime: 30000,
			content: "You wouldn't get this from any other guy",
			translation: '这是别人给不了你的',
		},
		{ startTime: 36000, content: '', translation: null },
		{
			startTime: 42000,
			content: 'Never gonna give you up',
			translation: '永远不会放弃你',
		},
		{
			startTime: 48000,
			content: 'Never gonna let you down',
			translation: '永远不会让你失望',
		},
		{
			startTime: 54000,
			content: 'Never gonna run around and desert you',
			translation: '永远不会转身离开你',
		},
		{
			startTime: 60000,
			content: 'Never gonna make you cry',
			translation: '永远不会让你哭泣',
		},
		{
			startTime: 66000,
			content: 'Never gonna say goodbye',
			translation: '永远不会说再见',
		},
		{
			startTime: 72000,
			content: 'Never gonna tell a lie and hurt you',
			translation: '永远不会说谎伤害你',
		},
		{ startTime: 80000, content: '', translation: null },
		{
			startTime: 86000,
			content: "We've known each other for so long",
			translation: '我们相识已经很久',
		},
		{
			startTime: 92000,
			content: "Your heart's been aching but you're too shy to say it",
			translation: '你的心在隐隐作痛，却羞于启齿',
		},
		{
			startTime: 98000,
			content: "Inside we both know what's been going on",
			translation: '我们都知道发生了什么',
		},
		{
			startTime: 104000,
			content: 'We know the game and we\u2019re gonna play it',
			translation: '我们知道规则，也愿意参与',
		},
	]

	let panel = null
	let lastPosition = 0

	function ensurePanel() {
		if (!panel) {
			panel = global.createLyricsPanel($('lyrics-panel'), {
				emptyText: '暂无歌词（点上方按钮载入）',
			})
			global.__lyricsPanel = panel
			// 点击某行 -> 模拟 seek
			$('lyrics-panel').addEventListener('lyricseek', (event) => {
				const seconds = event.detail.startTime / 1000
				setPosition(seconds)
				setStatus(
					`点击第 ${event.detail.index + 1} 行，跳到 ${seconds.toFixed(1)}s`,
				)
			})
		}
		return panel
	}

	function setPosition(seconds) {
		lastPosition = seconds
		const scrub = $('scrub')
		if (scrub) scrub.value = String(seconds)
		const scrubValue = $('scrub-value')
		if (scrubValue) scrubValue.textContent = seconds.toFixed(1)
		if (panel) panel.setPosition(seconds)
	}

	/** 把接口返回的 LRC 文本解析成面板需要的行（复用 splash 的解析结果） */
	function linesFromParsed(parsedLines) {
		return parsedLines.map((line) => ({
			startTime: line.startTime,
			content: line.content,
			translation: line.translation ?? null,
		}))
	}

	function loadLines(lines, label) {
		const api = ensurePanel()
		api.setLyrics(lines)
		const max =
			lines.length > 0 ? lines[lines.length - 1].startTime / 1000 + 5 : 30
		const scrub = $('scrub')
		if (scrub) scrub.max = String(Math.ceil(max))
		setPosition(0)
		setStatus(`${label}：${lines.length} 行`)
	}

	// ── 按钮连线 ────────────────────────────────────────────

	function bind(id, handler) {
		const el = $(id)
		if (el) el.addEventListener('click', handler)
	}

	bind('btn-demo', () => loadLines(DEMO_LINES, '已载入内置示例歌词'))
	bind('btn-offline', () => {
		// 用公式合成 40 行，验证长列表下的滚动与二分查找
		const synthetic = []
		for (let i = 0; i < 40; i++) {
			synthetic.push({
				startTime: i * 4000,
				content: `第 ${i + 1} 行歌词`,
				translation: i % 3 === 0 ? `line ${i + 1}` : null,
			})
		}
		loadLines(synthetic, '已合成示例歌词')
	})

	bind('btn-tick', () => setPosition(lastPosition + 5))
	bind('btn-first', () => setPosition(0))
	bind('btn-mid', () => setPosition(60))

	const scrub = $('scrub')
	if (scrub) {
		scrub.addEventListener('input', () => {
			setPosition(Number(scrub.value))
		})
	}

	// ── 真实网络：经主进程 ──────────────────────────────────

	const lab = global.bbplayerLyricsLab

	function renderCandidates(ranked) {
		const list = $('candidates')
		if (!list) return
		list.textContent = ''
		for (let i = 0; i < ranked.length; i++) {
			const item = ranked[i]
			const li = document.createElement('li')
			li.className = 'lab__candidate'
			li.dataset.testid = 'candidate'
			li.dataset.remoteId = String(item.candidate.remoteId)
			li.dataset.score = item.score.toFixed(3)
			if (i === 0) li.classList.add('is-best')

			const text = document.createElement('span')
			text.textContent = `${item.candidate.title} — ${item.candidate.artist}`

			const score = document.createElement('span')
			score.className = 'lab__score'
			score.textContent = item.score.toFixed(3)

			li.append(text, score)
			li.addEventListener('click', () => {
				void fetchLyrics(item.candidate.remoteId)
			})
			list.append(li)
		}
	}

	async function fetchLyrics(remoteId) {
		if (!lab) {
			setStatus('当前没有主进程桥（请用 lyrics-lab-main.cjs 启动）', true)
			return
		}
		setStatus(`正在取歌词 id=${remoteId} …`)
		const result = await lab.lyrics({ songId: Number(remoteId) })
		if (!result.ok) {
			setStatus(`取歌词失败：${result.error}`, true)
			return
		}
		if (result.isInstrumental || !result.lines || result.lines.length === 0) {
			setStatus(`id=${remoteId} 没有歌词（纯音乐或未收录）`, true)
			return
		}
		loadLines(
			linesFromParsed(result.lines),
			`真实歌词（网易云 id=${remoteId}，${result.rawLrcLength} 字符）`,
		)
	}

	async function doSearch() {
		const keyword = $('search-input')?.value?.trim()
		if (!keyword) {
			setStatus('请输入关键词', true)
			return
		}
		if (!lab) {
			setStatus('当前没有主进程桥（请用 lyrics-lab-main.cjs 启动）', true)
			return
		}
		setStatus(`搜索 “${keyword}” …`)
		const result = await lab.search({ keyword })
		if (!result.ok) {
			setStatus(`搜索失败：${result.error}`, true)
			return
		}
		renderCandidates(result.ranked ?? [])
		setStatus(`搜索到 ${result.ranked.length} 条候选（已按置信度排序）`)
		if (result.ranked.length > 0) {
			await fetchLyrics(result.ranked[0].candidate.remoteId)
		}
	}

	bind('btn-search', () => {
		void doSearch()
	})
	bind('btn-ipc', () => {
		void doSearch()
	})

	// ── 页面初始化 ──────────────────────────────────────────

	function boot() {
		ensurePanel()
		loadLines(DEMO_LINES, '已载入内置示例歌词（可点「从主进程拉真实歌词」）')
		if (!lab) {
			setStatus(
				'已载入示例歌词；当前没有主进程桥，真实网络取词不可用（用 lyrics-lab-main.cjs 启动即可）',
			)
		}
		global.__lyricsLab = {
			ready: true,
			loadDemo: () => loadLines(DEMO_LINES, '示例'),
			setPosition,
			search: doSearch,
			getState: () => ensurePanel().getState(),
			panel: () => ensurePanel(),
		}
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot, { once: true })
	} else {
		boot()
	}
})(window)
