/* oxlint-disable no-console -- 探针脚本，以 stdout 输出验证过程 */
/**
 * 播放历史探针（Phase 3.5）：验证 **UI 层真的把历史记下来了**。
 *
 * SQL 层已由 `scripts/verify-play-history.mts` 覆盖（35 项）。这里验的是
 * 那条链路的两端：
 *   * 播放器事件 -> 会话开始/收尾 -> 落库（渲染进程的接线）
 *   * 历史视图 -> 三个页签 -> 表格渲染 -> 「继续收听」能接着上次播
 *
 * ## 为什么用「播放全部 + 手动收尾」
 *
 * 真实播完一首要几分钟，不可能等。所以：
 *   1. 导入一个真实合集（有落库的曲目，历史表有外键）
 *   2. 点「播放全部」-> 真的开始播放 -> 应自动开始一次会话
 *   3. 推进一下播放位置，再用 `flushPlaySession(false)` 手动收尾
 *      （否则要等 10 秒的节流上报）
 *   4. 断言库里真的多了一条记录
 */
const fs = require('node:fs')
const path = require('node:path')

const SHOTS = process.env.BBPLAYER_UI_SHOTS
	? process.env.BBPLAYER_UI_SHOTS
	: path.join(__dirname, '..', 'probe-output', 'history-shots')
const REPORT = path.join(__dirname, '..', 'probe-output', 'history-report.json')

const checks = []
const screenshots = []
const pending = []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function check(name, ok, detail) {
	checks.push({ name, ok: Boolean(ok), detail: detail ?? null })
	console.log(
		`[history] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`,
	)
}

async function evaluate(window, expression) {
	return await window.webContents.executeJavaScript(expression, true)
}

async function shot(window, name) {
	try {
		await sleep(350)
		const image = await window.webContents.capturePage()
		if (image.getSize().width === 0) return null
		fs.mkdirSync(SHOTS, { recursive: true })
		const file = path.join(SHOTS, `${name}.png`)
		fs.writeFileSync(file, image.toPNG())
		screenshots.push(file)
		console.log(`[history] 截图: ${file}`)
		return file
	} catch (error) {
		console.log(`[history] 截图失败 ${name}: ${error.message}`)
		return null
	}
}

async function waitFor(window, expression, timeoutMs, label) {
	const start = Date.now()
	let last
	while (Date.now() - start < timeoutMs) {
		try {
			last = await evaluate(
				window,
				`(() => { try { return ${expression} } catch (e) { return { __error: e.message } } })()`,
			)
			if (last === true || last?.ok === true) return { ok: true, value: last }
		} catch (error) {
			last = { error: error.message }
		}
		await sleep(300)
	}
	return { ok: false, value: last, label }
}

async function click(window, selector) {
	return await evaluate(
		window,
		`(() => {
			const el = document.querySelector(${JSON.stringify(selector)})
			if (!el) return false
			el.click()
			return true
		})()`,
	)
}

// ---------------------------------------------------------------

async function run(window) {
	console.log('[history] 开始 Phase 3.5 播放历史验收')

	const ready = await waitFor(
		window,
		'Boolean(window.__bbReady)',
		20_000,
		'ready',
	)
	check('渲染进程就绪', ready.ok)

	// ---------- 1. 模块与入口 ----------
	const modules = await evaluate(
		window,
		`(() => ({
			history: typeof window.bbHistory,
			bridge: typeof window.bbplayer?.history,
			finder: typeof window.bbplayer?.findTrackByBvid,
			navItem: Boolean(document.querySelector('[data-testid="nav-home"]')),
			session: window.bbUI?.playSession?.() ?? null,
		}))()`,
	)
	check('window.bbHistory 已暴露', modules.history === 'object')
	check('preload 暴露了 history 桥', modules.bridge === 'object')
	check('preload 暴露了 bvid 查找', modules.finder === 'function')
	check('侧栏有「最近播放」入口', modules.navItem)
	check(
		'初始没有进行中的会话',
		modules.session?.historyId === null,
		JSON.stringify(modules.session),
	)

	// ---------- 2. 空历史的视图 ----------
	await click(window, '[data-testid="nav-home"]')
	const emptyView = await waitFor(
		window,
		`(() => {
			const tabs = document.querySelectorAll('[data-testid="history-tabs"] .tab')
			return tabs.length === 3 ? { ok: true, count: tabs.length } : false
		})()`,
		15_000,
		'history-tabs',
	)
	check(
		'历史视图渲染出 3 个页签',
		emptyView.ok,
		emptyView.ok
			? `${emptyView.value.count} 个`
			: JSON.stringify(emptyView.value),
	)
	check(
		'三个页签都渲染了（继续收听 / 最近播放 / 最常播放）',
		(await evaluate(
			window,
			`['resume','recent','most'].every((k) => Boolean(document.querySelector('[data-testid="history-tab-' + k + '"]')))`,
		)) === true,
	)
	check(
		'默认停在「继续收听」',
		(await evaluate(
			window,
			`document.querySelector('[data-testid="history-tab-resume"]')?.classList.contains('is-active')`,
		)) === true,
	)
	const emptySummary = await evaluate(
		window,
		`document.querySelector('[data-testid="history-summary"]')?.textContent ?? null`,
	)
	check(
		'空历史时汇总显示「暂无记录」',
		String(emptySummary).includes('暂无'),
		String(emptySummary),
	)
	await shot(window, 'history-01-empty')

	// ---------- 3. 造数据：导入一个真实合集 ----------
	await click(window, '[data-testid="nav-library"]')
	await sleep(400)
	const seeded = await waitFor(
		window,
		`(() => {
			const btn = document.querySelector('[data-testid="btn-seed-demo"]')
			if (!btn) return window.bbLibrary.getTracks().length > 0 ? { ok: true, existing: true } : false
			return { ok: true, existing: false }
		})()`,
		15_000,
		'seed-button',
	)
	if (!seeded.value?.existing) {
		await click(window, '[data-testid="btn-seed-demo"]')
		const imported = await waitFor(
			window,
			`document.querySelectorAll('.track-table tbody tr').length > 0
				? { ok: true, rows: document.querySelectorAll('.track-table tbody tr').length }
				: false`,
			180_000,
			'import',
		)
		check(
			'导入了真实合集（历史表有外键，需要曲目先落库）',
			imported.ok,
			imported.ok
				? `${imported.value.rows} 首`
				: JSON.stringify(imported.value),
		)
	} else {
		check(
			'库里已有曲目，跳过导入',
			true,
			`${await evaluate(window, 'window.bbLibrary.getTracks().length')} 首`,
		)
	}

	// ---------- 4. 播放 -> 会话应该开始 ----------
	await click(window, '[data-testid="btn-play-all"]')
	const playing = await waitFor(
		window,
		`(() => {
			const a = window.bbPlayer.getAudio()
			return a && !a.paused && a.currentTime > 0.2
				? { ok: true, currentTime: a.currentTime }
				: false
		})()`,
		60_000,
		'playing',
	)
	check(
		'真实播放已开始（会话记录的前提）',
		playing.ok,
		playing.ok
			? `currentTime=${playing.value.currentTime?.toFixed?.(2)}`
			: JSON.stringify(playing.value),
	)

	const sessionStarted = await waitFor(
		window,
		`(() => {
			const s = window.bbUI.playSession()
			return s.historyId ? { ok: true, historyId: s.historyId, trackId: s.trackId } : false
		})()`,
		15_000,
		'session-start',
	)
	check(
		'播放触发了播放会话（historyId 已分配）',
		sessionStarted.ok,
		sessionStarted.ok
			? `historyId=${sessionStarted.value.historyId} trackId=${sessionStarted.value.trackId}`
			: JSON.stringify(sessionStarted.value),
	)

	// 会话必须真的落库（不是只有内存里的 id）
	const summaryAfterPlay = await evaluate(
		window,
		`window.bbplayer.history.summary().then((r) => r?.data ?? null)`,
	)
	check(
		'库里真的多了一条会话记录',
		summaryAfterPlay?.sessionCount >= 1,
		JSON.stringify(summaryAfterPlay),
	)

	// ---------- 5. 收尾会话（带一个可辨识的已播时长） ----------
	const flushed = await evaluate(
		window,
		`window.bbUI.flushPlaySession(false).then(() => window.bbUI.playSession())`,
	)
	check(
		'收尾后会话被清空',
		flushed?.historyId === null,
		JSON.stringify(flushed),
	)

	const stats = await evaluate(
		window,
		`(async () => {
			const s = window.bbUI.playSession()
			const found = await window.bbplayer.findTrackByBvid(window.bbPlayer.getCurrent().bvid)
			const st = await window.bbplayer.history.stats(found.data)
			return { trackId: found.data, stats: st.data }
		})()`,
	)
	check(
		'收尾写入了已播时长',
		stats?.stats?.playCount >= 1,
		JSON.stringify(stats),
	)

	// ---------- 6. 历史视图的三个页签都有内容 ----------
	//
	// 「继续收听」要真的有内容才验得到东西。上面那次播放是「听到一半就收尾」，
	// 但收尾时上报的是当时的 currentTime（可能很小），所以这里**显式造一条
	// 半途会话**：开始 -> 上报 80 秒 -> 不标记完成。
	const partial = await evaluate(
		window,
		`(async () => {
			const current = window.bbPlayer.getCurrent()
			if (!current?.bvid) return { error: '没有正在播放的曲目' }
			const found = await window.bbplayer.findTrackByBvid(current.bvid)
			if (!found?.data) return { error: '曲目未落库: ' + current.bvid }
			const started = await window.bbplayer.history.startSession(found.data)
			if (!started?.ok) return { error: started?.error }
			await window.bbplayer.history.updateSession({
				historyId: started.data.historyId,
				durationPlayed: 80,
				completed: false,
			})
			return { trackId: found.data, historyId: started.data.historyId }
		})()`,
	)
	check(
		'能造出一条「听到 80 秒、未听完」的会话',
		typeof partial?.historyId === 'number',
		JSON.stringify(partial),
	)

	await click(window, '[data-testid="nav-home"]')
	await click(window, '[data-testid="history-tab-resume"]')
	const resumeRows = await waitFor(
		window,
		`(() => {
			const rows = document.querySelectorAll('[data-testid="history-table"] tbody tr').length
			return rows > 0 ? { ok: true, rows } : false
		})()`,
		20_000,
		'resume-rows',
	)
	check(
		'「继续收听」列出了未听完的曲目',
		resumeRows.ok,
		resumeRows.ok
			? `${resumeRows.value.rows} 行`
			: JSON.stringify(resumeRows.value),
	)

	const resumeColumns = await evaluate(
		window,
		`Array.from(document.querySelectorAll('[data-testid="history-table"] thead th')).map((th) => th.textContent)`,
	)
	check(
		'「继续收听」表头包含「上次听到」',
		resumeColumns?.includes('上次听到'),
		JSON.stringify(resumeColumns),
	)
	// ⚠️ 同时只能有**一张**表。
	// 点导航与点页签都会触发 refresh()，两者并发时慢的那次会把表格追加到
	// 快的那次之后 —— 界面上出现两张表（第一版就是，读表头读到重复两组列）。
	check(
		'并发刷新只渲染一张表（没有重复表格）',
		(await evaluate(
			window,
			`document.querySelectorAll('[data-testid="history-table"]').length`,
		)) === 1,
		`${await evaluate(window, `document.querySelectorAll('[data-testid="history-table"]').length`)} 张表`,
	)
	check(
		'表头没有被重复渲染',
		resumeColumns?.length === 6,
		`${resumeColumns?.length} 列`,
	)
	const resumePosition = await evaluate(
		window,
		`document.querySelector('[data-testid="history-table"] tbody tr td.col-position')?.textContent ?? null`,
	)
	check(
		'「上次听到」列显示正确的位置（80 秒 -> 1:20）',
		resumePosition === '1:20',
		String(resumePosition),
	)
	await shot(window, 'history-02-resume')

	const recentRows = await waitFor(
		window,
		`(() => {
			const rows = document.querySelectorAll('[data-testid="history-table"] tbody tr').length
			return rows > 0 ? { ok: true, rows } : false
		})()`,
		20_000,
		'recent-rows',
	)
	check(
		'「最近播放」页签渲染完成',
		recentRows.ok ||
			(await evaluate(
				window,
				`Boolean(document.querySelector('[data-testid="history-empty"]'))`,
			)) === true,
		recentRows.ok ? `${recentRows.value.rows} 行` : '空态',
	)

	await click(window, '[data-testid="history-tab-recent"]')
	const recentTabRows = await waitFor(
		window,
		`(() => {
			const rows = document.querySelectorAll('[data-testid="history-table"] tbody tr').length
			return rows > 0 ? { ok: true, rows } : false
		})()`,
		20_000,
		'recent-tab',
	)
	check(
		'「最近播放」有记录（刚播过）',
		recentTabRows.ok,
		recentTabRows.ok
			? `${recentTabRows.value.rows} 行`
			: JSON.stringify(recentTabRows.value),
	)

	const recentColumns = await evaluate(
		window,
		`Array.from(document.querySelectorAll('[data-testid="history-table"] thead th')).map((th) => th.textContent)`,
	)
	check(
		'「最近播放」表头包含播放次数与最近播放时间',
		recentColumns?.includes('播放次数') && recentColumns?.includes('最近播放'),
		JSON.stringify(recentColumns),
	)
	await shot(window, 'history-02-recent')

	await click(window, '[data-testid="history-tab-most"]')
	await sleep(700)
	const mostColumns = await evaluate(
		window,
		`Array.from(document.querySelectorAll('[data-testid="history-table"] thead th')).map((th) => th.textContent)`,
	)
	check(
		'「最常播放」页签切换生效',
		(await evaluate(
			window,
			`document.querySelector('[data-testid="history-tab-most"]')?.classList.contains('is-active')`,
		)) === true,
		JSON.stringify(mostColumns),
	)

	// ---------- 7. 汇总文本 ----------
	await click(window, '[data-testid="history-tab-recent"]')
	await sleep(600)
	const summaryText = await evaluate(
		window,
		`document.querySelector('[data-testid="history-summary"]')?.textContent ?? null`,
	)
	check(
		'汇总显示曲目数 / 会话数 / 累计分钟',
		/\d+ 首/.test(String(summaryText)) && /累计/.test(String(summaryText)),
		String(summaryText),
	)

	// ---------- 8. 清空 ----------
	// 清空有二次确认（window.confirm），在探针里需要放行
	await evaluate(
		window,
		`(() => { window.__origConfirm = window.confirm; window.confirm = () => true; return true })()`,
	)
	await click(window, '[data-testid="history-clear"]')
	const cleared = await waitFor(
		window,
		`(() => {
			const t = document.getElementById('status')?.textContent ?? ''
			return t.includes('已清空') ? { ok: true, text: t } : false
		})()`,
		15_000,
		'clear',
	)
	check(
		'能清空播放历史',
		cleared.ok,
		cleared.ok ? cleared.value.text : JSON.stringify(cleared.value),
	)

	const afterClear = await evaluate(
		window,
		`window.bbplayer.history.summary().then((r) => r?.data ?? null)`,
	)
	check(
		'清空后会话数归零',
		afterClear?.sessionCount === 0,
		JSON.stringify(afterClear),
	)
	check(
		'清空后视图显示空态',
		(await evaluate(
			window,
			`Boolean(document.querySelector('[data-testid="history-empty"]'))`,
		)) === true,
	)
	await shot(window, 'history-03-cleared')

	// 恢复 confirm（不影响后续，但保持环境干净）
	await evaluate(
		window,
		`(() => { if (window.__origConfirm) window.confirm = window.__origConfirm; return true })()`,
	)

	// ---------- 9. 非库内曲目不记录（外键保护） ----------
	const ghost = await evaluate(
		window,
		`(async () => {
			const found = await window.bbplayer.findTrackByBvid('BV1definitelyNotInLibrary')
			return found?.data ?? 'MISSING'
		})()`,
	)
	check(
		'库外曲目查不到 id（历史只记录已落库曲目，避免外键报错）',
		ghost === null || ghost === 'MISSING',
		String(ghost),
	)

	console.log('[history] 完成')
	return finish(window)
}

function finish(_window) {
	fs.mkdirSync(path.dirname(REPORT), { recursive: true })
	const passed = checks.filter((c) => c.ok).length
	const failed = checks.length - passed
	fs.writeFileSync(
		REPORT,
		JSON.stringify({ checks, screenshots, pending, passed, failed }, null, 2),
	)
	console.log(`[history] 报告已写入 ${REPORT}`)
	console.log(
		`[history] 结果: ${passed} 通过 / ${failed} 失败 / ${pending.length} 待人工验证`,
	)
	try {
		const { BrowserWindow } = require('electron')
		for (const candidate of BrowserWindow.getAllWindows()) {
			if (!candidate.isDestroyed()) candidate.destroy()
		}
	} catch (error) {
		console.log(`[history] 关闭窗口时出错：${error.message}`)
	}
}

module.exports = { run }
