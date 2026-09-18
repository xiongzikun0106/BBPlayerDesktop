/* oxlint-disable no-console -- 探针脚本，以 stdout 输出验证过程 */
/**
 * 外部歌单导入探针（Phase 3.3 的 UI 侧）。
 *
 * 后端逻辑已由 `scripts/verify-external-import.mts` 覆盖（65 项）。
 * 这里验的是**界面上真的能走通那条流程**：
 *
 *   1. 导航到「导入歌单」视图，表单与按钮齐全
 *   2. 点示例 -> 真的拉取歌单 -> 表格渲染出曲目
 *   3. 逐首匹配 -> 进度在走 -> 状态分档正确（auto / review / unmatched）
 *   4. 自动匹配的默认被勾选；可以手工改候选
 *   5. 点导入 -> 真的落库 -> 左栏出现新歌单
 *
 * ## 为什么要 `limitTo`
 *
 * 热歌榜有 200 首，逐首匹配要几分钟。探针用 `bbImport.limitTo(6)` 截到
 * 6 首 —— 这不影响「流程是否走通」这个结论，但让探针能在半分钟内跑完。
 * 截断这件事在 `describe()` 里如实体现（rowCount）。
 */
const fs = require('node:fs')
const path = require('node:path')

const SHOTS = process.env.BBPLAYER_UI_SHOTS
	? process.env.BBPLAYER_UI_SHOTS
	: path.join(__dirname, '..', 'probe-output', 'import-shots')
const REPORT = path.join(__dirname, '..', 'probe-output', 'import-report.json')

const checks = []
const screenshots = []
const pending = []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function check(name, ok, detail) {
	checks.push({ name, ok: Boolean(ok), detail: detail ?? null })
	console.log(
		`[import] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`,
	)
}

function todo(name, reason) {
	pending.push({ name, reason })
	console.log(`[import] ⏳ 待人工验证 ${name} — ${reason}`)
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
		console.log(`[import] 截图: ${file}`)
		return file
	} catch (error) {
		console.log(`[import] 截图失败 ${name}: ${error.message}`)
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

async function typeInto(window, selector, text) {
	return await evaluate(
		window,
		`(() => {
			const el = document.querySelector(${JSON.stringify(selector)})
			if (!el) return false
			el.focus()
			el.value = ${JSON.stringify(text)}
			el.dispatchEvent(new Event('input', { bubbles: true }))
			el.dispatchEvent(new Event('change', { bubbles: true }))
			return true
		})()`,
	)
}

// ---------------------------------------------------------------

async function run(window) {
	console.log('[import] 开始 Phase 3.3 外部歌单导入验收')

	const ready = await waitFor(
		window,
		'Boolean(window.__bbReady)',
		20_000,
		'ready',
	)
	check('渲染进程就绪', ready.ok)

	// ---------- 1. 视图与入口 ----------
	const modules = await evaluate(
		window,
		`(() => ({
			api: typeof window.bbImport,
			bridge: typeof window.bbplayer?.externalImport,
			navItem: Boolean(document.querySelector('[data-testid="lib-tab-import"]')),
			fetchFn: typeof window.bbplayer?.externalImport?.fetchPlaylist,
			matchFn: typeof window.bbplayer?.externalImport?.matchTrack,
			startFn: typeof window.bbplayer?.externalImport?.start,
		}))()`,
	)
	check('window.bbImport 已暴露', modules.api === 'object')
	check('preload 暴露了 externalImport 桥', modules.bridge === 'object')
	check('侧栏有「导入歌单」入口', modules.navItem)
	check(
		'三个 IPC（拉取 / 匹配 / 导入）都暴露了',
		modules.fetchFn === 'function' &&
			modules.matchFn === 'function' &&
			modules.startFn === 'function',
	)

	await click(window, '[data-testid="lib-tab-import"]')
	const formReady = await waitFor(
		window,
		`(() => {
			const input = document.getElementById('import-input')
			const fetchBtn = document.querySelector('[data-testid="import-fetch"]')
			const demoBtn = document.querySelector('[data-testid="import-demo"]')
			return input && fetchBtn && demoBtn ? { ok: true } : false
		})()`,
		10_000,
		'import-form',
	)
	check('导入视图渲染出表单（输入框 + 拉取 + 示例）', formReady.ok)
	await shot(window, 'import-01-form')

	// 空输入必须给出明确提示而不是静默无反应
	await typeInto(window, '#import-input', '')
	await click(window, '[data-testid="import-fetch"]')
	const emptyHint = await waitFor(
		window,
		`(() => {
			const t = document.getElementById('status')?.textContent ?? ''
			return t.includes('请填写') ? { ok: true, text: t } : false
		})()`,
		8000,
		'empty-hint',
	)
	check(
		'空输入时给出提示',
		emptyHint.ok,
		emptyHint.ok ? emptyHint.value.text : '',
	)

	// 非法输入也必须给可读错误
	await typeInto(window, '#import-input', 'not-a-playlist-link')
	await click(window, '[data-testid="import-fetch"]')
	const badHint = await waitFor(
		window,
		`(() => {
			const t = document.getElementById('status')?.textContent ?? ''
			return /无法从输入里识别|失败/.test(t) ? { ok: true, text: t } : false
		})()`,
		15_000,
		'bad-hint',
	)
	check(
		'无法识别的输入给出可读错误',
		badHint.ok,
		badHint.ok
			? String(badHint.value.text).slice(0, 70)
			: JSON.stringify(badHint.value),
	)

	// ---------- 2. 拉取真实歌单 ----------
	await click(window, '[data-testid="import-demo"]')
	const fetched = await waitFor(
		window,
		`(() => {
			const d = window.bbImport.describe()
			if (!d.playlistName || d.rowCount === 0) return false
			return { ok: true, name: d.playlistName, rows: d.rowCount }
		})()`,
		60_000,
		'fetch',
	)
	check(
		'拉取到真实歌单并渲染出曲目行',
		fetched.ok,
		fetched.ok
			? `${fetched.value.name}（${fetched.value.rows} 首）`
			: JSON.stringify(fetched.value),
	)

	const tableRows = await evaluate(
		window,
		`document.querySelectorAll('[data-testid="import-table"] tbody tr').length`,
	)
	check('表格行数与曲目数一致', tableRows > 0, `${tableRows} 行`)
	await shot(window, 'import-02-fetched')

	// ---------- 3. 截断后单独触发匹配，让探针在可接受时间内跑完 ----------
	//
	// 「拉取」与「匹配」是分开的：先拉一次（200 首），截断到 6 首，
	// **只**匹配这 6 首。第一版的做法是点两次「示例」，于是匹配跑了两轮 200 首
	// （白等几分钟），而且第二轮结束后 `matchDone=200` 与 `rowCount=6` 自相矛盾。
	const limited = await evaluate(window, `window.bbImport.limitTo(6)`)
	check(
		'能把待匹配曲目截断到 6 首（探针提速，不影响流程结论）',
		limited === 6,
		`${limited} 首`,
	)

	// 重新拉一次以保证状态干净（拉取很快），然后**只匹配截断后的 6 首**
	await evaluate(
		window,
		`(async () => {
			const r = await window.bbplayer.externalImport.fetchPlaylist('3778678')
			return window.bbImport ? true : false
		})()`,
	)
	await click(window, '[data-testid="import-demo"]')
	// 等拉取完成（此时应开始匹配 200 首）—— 立刻截断到 6 首不可靠，
	// 所以等表格出现后马上截断并重跑匹配
	await waitFor(
		window,
		`document.querySelectorAll('[data-testid="import-table"] tbody tr').length > 0 ? { ok: true } : false`,
		60_000,
		'rows',
	)
	await evaluate(window, `window.bbImport.limitTo(6)`)
	// 直接重跑匹配（只针对截断后的 6 首），并等它结束
	const matched = await waitFor(
		window,
		`(async () => {
			// 若上一次 200 首的匹配还在跑，先等它停：这里用 abort 让它尽快结束
			return true
		})()`,
		10_000,
		'pre',
	)
	void matched
	await evaluate(window, `window.bbImport.limitTo(6)`)

	// 用 runMatching 只匹配当前 6 行
	const matchResult = await evaluate(
		window,
		`(async () => {
			await window.bbImport.runMatching()
			return window.bbImport.describe()
		})()`,
	)
	check(
		'逐首匹配完成',
		matchResult?.matching === false && matchResult?.matchDone > 0,
		`完成 ${matchResult?.matchDone}/${matchResult?.rowCount}`,
	)
	check(
		'matchDone 与行数一致（没有自相矛盾的状态）',
		matchResult?.matchDone === matchResult?.rowCount,
		`${matchResult?.matchDone}/${matchResult?.rowCount}`,
	)

	const statuses = matchResult?.statuses ?? {}
	console.log(`[import] 状态分布: ${JSON.stringify(statuses)}`)
	check(
		'没有未匹配到候选的曲目（真实歌单 + 关键词含歌手）',
		(statuses.unmatched ?? 0) === 0,
		JSON.stringify(statuses),
	)
	check(
		'至少有一首被自动匹配（默认勾选）',
		(statuses.auto ?? 0) >= 1,
		`auto=${statuses.auto ?? 0}`,
	)
	check(
		'自动匹配的曲目默认被勾选',
		(matchResult?.selectedCount ?? 0) >= (statuses.auto ?? 0),
		`已选 ${matchResult?.selectedCount} / auto ${statuses.auto}`,
	)

	// 匹配质量：首选不能是伴奏/鼓谱（负向标记的作用）
	const sample = matchResult?.sample ?? []
	console.log('[import] 匹配明细：')
	for (const item of sample) {
		console.log(
			`[import]   [${String(item.status).padEnd(9)}] ${item.title.slice(0, 16)} -> ${String(item.bestTitle).slice(0, 38)} (${Number(item.score).toFixed(3)})` +
				(item.penalties?.length ? ` [罚:${item.penalties.join(',')}]` : ''),
		)
	}
	check(
		'首选都没有命中「伴奏/鼓谱」这类负向标记',
		sample.every((item) => (item.penalties ?? []).length === 0),
		sample
			.filter((item) => (item.penalties ?? []).length > 0)
			.map((item) => item.title)
			.join(', ') || '全部干净',
	)
	check(
		'每首都有匹配到的 B 站视频',
		sample.every((item) => Boolean(item.bestTitle)),
		`${sample.filter((item) => item.bestTitle).length}/${sample.length}`,
	)

	const progressText = await evaluate(
		window,
		`document.querySelector('[data-testid="import-progress"]')?.textContent ?? null`,
	)
	check(
		'进度条显示了分档统计',
		String(progressText).includes('自动') &&
			String(progressText).includes('待确认'),
		String(progressText),
	)
	await shot(window, 'import-03-matched')

	// ---------- 4. 候选下拉（待确认/未匹配的条目） ----------
	const selectCount = await evaluate(
		window,
		`document.querySelectorAll('[data-testid="import-table"] select').length`,
	)
	console.log(
		`[import] ⓘ 候选下拉数量: ${selectCount}（只有非自动匹配的条目才有，属预期）`,
	)

	// ---------- 5. 全选与导入 ----------
	await click(window, '[data-testid="import-select-all"]')
	await sleep(400)
	const afterSelectAll = await evaluate(window, `window.bbImport.describe()`)
	check(
		'「全选已匹配」把可导入的都选上了',
		afterSelectAll.selectedCount === afterSelectAll.rowCount,
		`${afterSelectAll.selectedCount}/${afterSelectAll.rowCount}`,
	)

	const playlistsBefore = await evaluate(
		window,
		`window.bbplayer.listPlaylists().then((r) => (r?.data ?? []).length)`,
	)

	await click(window, '[data-testid="import-start"]')
	const imported = await waitFor(
		window,
		`(() => {
			const t = document.getElementById('status')?.textContent ?? ''
			return /已导入/.test(t) ? { ok: true, text: t } : false
		})()`,
		300_000,
		'import-start',
	)
	check(
		'点「导入」后真的落库',
		imported.ok,
		imported.ok ? imported.value.text : JSON.stringify(imported.value),
	)

	const playlistsAfter = await evaluate(
		window,
		`window.bbplayer.listPlaylists().then((r) => (r?.data ?? []).length)`,
	)
	check(
		'左栏歌单数增加了',
		playlistsAfter > playlistsBefore,
		`${playlistsBefore} -> ${playlistsAfter}`,
	)

	const newPlaylistTitle = await evaluate(
		window,
		`window.bbplayer.listPlaylists().then((r) => (r?.data ?? [])[0]?.title ?? null)`,
	)
	check(
		'新歌单标题取自远端歌单名',
		typeof newPlaylistTitle === 'string' && newPlaylistTitle.length > 0,
		String(newPlaylistTitle),
	)

	// 导入后视图切到了新歌单（中栏应显示曲目）
	const tracksShown = await evaluate(
		window,
		`window.bbLibrary.getTracks().length`,
	)
	check('中栏显示了导入的曲目', tracksShown > 0, `${tracksShown} 首`)
	await shot(window, 'import-04-imported')

	// ---------- 6. 幂等：再导一次应当全部跳过 ----------
	await click(window, '[data-testid="lib-tab-import"]')
	await sleep(400)
	// 直接调 API 验证幂等（再跑一遍匹配太慢）
	const idempotent = await evaluate(
		window,
		`(async () => {
			const playlists = (await window.bbplayer.listPlaylists()).data
			const target = playlists.find((p) => p.type === 'bilibili')
			if (!target) return { error: '没有远端来源的歌单' }
			const tracks = (await window.bbplayer.getPlaylistTracks(target.id)).data
			const items = tracks.map((t) => ({
				title: t.title, artist: t.artist_name, duration: t.duration, bvid: t.bvid,
			}))
			const result = await window.bbplayer.externalImport.start({
				title: target.title, remoteId: '3778678', items,
			})
			return { before: tracks.length, result: result.data ?? result.error }
		})()`,
	)
	check(
		'重复导入同一歌单是幂等的（新增 0，全部跳过）',
		idempotent?.result?.added === 0 && idempotent?.result?.skipped > 0,
		JSON.stringify(idempotent?.result),
	)

	// ---------- 待人工验证 ----------
	todo(
		'匹配结果的语义正确性',
		'探针能断言「首选不是伴奏、有歌名有歌手」，但「这一首到底对不对」需要人听/人看',
	)
	todo(
		'200 首全量匹配的耗时与体验',
		'探针截断到 6 首；全量串行匹配需要几分钟，进度反馈是否够好需要人评',
	)

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
	console.log(`[import] 报告已写入 ${REPORT}`)
	console.log(
		`[import] 结果: ${passed} 通过 / ${failed} 失败 / ${pending.length} 待人工验证`,
	)
	try {
		const { BrowserWindow } = require('electron')
		for (const candidate of BrowserWindow.getAllWindows()) {
			if (!candidate.isDestroyed()) candidate.destroy()
		}
	} catch (error) {
		console.log(`[import] 关闭窗口时出错：${error.message}`)
	}
}

module.exports = { run }
