/* oxlint-disable no-console -- 探针脚本，以 stdout 输出验证过程 */
/**
 * 独立歌词窗口探针（Phase 4.1）。
 *
 * ## 为什么这里能验证「DOM 渲染」，而主窗口的右栏不能
 *
 * 主窗口右栏歌词有一个**未定位**的已知问题：`setLyrics(48)` 状态正确、
 * `data-active` 也写进 DOM，但行元素不渲染（见 docs/LYRICS.md §6）。
 * 独立歌词窗口用的是**完全独立的渲染实现**（自己遍历行、自己算 translateY），
 * 实测 DOM 渲染正常（4 行都进了 DOM、高亮类也写进去了）。
 *
 * 所以本探针对 DOM 的断言是**严格的**（不断言 0 也行）——它验证的是一份
 * 确实工作的实现，同时也就给出了那个已知问题的**可用绕过路径**。
 */
const fs = require('node:fs')
const path = require('node:path')

const SHOTS = process.env.BBPLAYER_UI_SHOTS
	? process.env.BBPLAYER_UI_SHOTS
	: path.join(__dirname, '..', 'probe-output', 'lyrics-window-shots')
const REPORT = path.join(
	__dirname,
	'..',
	'probe-output',
	'lyrics-window-report.json',
)

const checks = []
const screenshots = []
const pending = []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function check(name, ok, detail) {
	checks.push({ name, ok: Boolean(ok), detail: detail ?? null })
	console.log(
		`[lw] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`,
	)
}

function todo(name, reason) {
	pending.push({ name, reason })
	console.log(`[lw] ⏳ 待人工验证 ${name} — ${reason}`)
}

async function evaluate(window, expression) {
	return await window.webContents.executeJavaScript(expression, true)
}

async function shot(window, name) {
	try {
		await sleep(300)
		const image = await window.webContents.capturePage()
		if (image.getSize().width === 0) return null
		fs.mkdirSync(SHOTS, { recursive: true })
		const file = path.join(SHOTS, `${name}.png`)
		fs.writeFileSync(file, image.toPNG())
		screenshots.push(file)
		console.log(`[lw] 截图: ${file}`)
		return file
	} catch (error) {
		console.log(`[lw] 截图失败 ${name}: ${error.message}`)
		return null
	}
}

/** 找到歌词窗口（按加载的 URL 判定，而不是按索引猜） */
function findLyricsWindow(BrowserWindow) {
	return BrowserWindow.getAllWindows().find((candidate) =>
		candidate.webContents.getURL().includes('lyrics-window.html'),
	)
}

async function run(window) {
	const { BrowserWindow } = require('electron')
	const lyricsWindow = require('./lyrics-window.cjs')

	console.log('[lw] 开始 Phase 4.1 独立歌词窗口验收')

	await sleep(2000)

	const mainReady = await evaluate(window, 'Boolean(window.__bbReady)')
	check('主窗口渲染进程就绪', mainReady)

	// ---------- 1. 打开 ----------
	const initial = await evaluate(
		window,
		`window.bbplayer.lyricsWindow.status()`,
	)
	check(
		'初始状态为「未打开」',
		initial?.data?.open === false,
		JSON.stringify(initial?.data),
	)

	const toggled = await evaluate(
		window,
		`window.bbplayer.lyricsWindow.toggle()`,
	)
	check(
		'能通过 IPC 打开歌词窗口',
		toggled?.ok === true,
		JSON.stringify(toggled?.data),
	)

	// ⚠️ 必须等歌词窗口加载完。`toggle()` 返回时窗口只是**被创建**了，
	// `loadFile` 还在飞 —— 此时 `webContents.getURL()` 仍是空串，按 URL
	// 找窗口会找不到（第一版就漏了这一步，表现为「窗口数量 2 但找不到歌词窗口」，
	// 而且因为提前 return 时歌词窗口还开着，进程也不退出，外层探针等到超时）。
	const loaded = await waitFor(
		() => Boolean(findLyricsWindow(BrowserWindow)),
		15_000,
		'歌词窗口加载出 URL',
	)
	check('歌词窗口已加载（按 URL 可识别）', loaded)

	// ---------- 2. 窗口参数 ----------
	const described = lyricsWindow.describe()
	check('主进程记录窗口已打开', described.open)
	check(
		'窗口置顶（alwaysOnTop）',
		described.alwaysOnTop === true,
		String(described.alwaysOnTop),
	)
	check(
		'窗口数量为 2（主窗口 + 歌词窗口）',
		BrowserWindow.getAllWindows().length === 2,
		`${BrowserWindow.getAllWindows().length} 个`,
	)

	const lyricsWin = findLyricsWindow(BrowserWindow)
	check('按 URL 找到了歌词窗口', Boolean(lyricsWin))
	if (!lyricsWin) {
		check('歌词窗口存在（后续断言的前提）', false)
		return finish(window)
	}

	const bounds = lyricsWin.getBounds()
	check(
		'窗口尺寸合理（默认 520x200，且不小于最小限制）',
		bounds.width >= 320 && bounds.height >= 120,
		`${bounds.width}x${bounds.height}`,
	)

	// ---------- 3. 渲染进程就绪与 preload 契约 ----------
	const ready = await evaluate(
		lyricsWin,
		`Boolean(window.__bbLyricsWindowReady)`,
	)
	check('歌词窗口渲染进程就绪', ready)

	const bridge = await evaluate(
		lyricsWin,
		`(() => ({
			bridge: typeof window.bbLyricsWindowBridge,
			api: typeof window.bbLyricsWindow,
			// 歌词窗口**不该**拿到主窗口那套能力（按最小权限单独 preload）
			hasMainBridge: typeof window.bbplayer,
			hasProbe: typeof window.bbProbe,
		}))()`,
	)
	check('preload 桥可用', bridge.bridge === 'object', bridge.bridge)
	check('渲染 API 可用', bridge.api === 'object', bridge.api)
	check(
		'歌词窗口**没有**拿到主窗口那套能力（最小权限）',
		bridge.hasMainBridge === 'undefined' && bridge.hasProbe === 'undefined',
		`bbplayer=${bridge.hasMainBridge} bbProbe=${bridge.hasProbe}`,
	)

	// ---------- 4. 推歌词 -> 断言 DOM 真的渲染 ----------
	await evaluate(
		window,
		`window.bbplayer.lyricsWindow.pushLyrics([
			{ startTime: 0, content: '第一行' },
			{ startTime: 1000, content: '第二行', translation: '第一行的翻译' },
			{ startTime: 2000, content: '第三行' },
			{ startTime: 3000, content: '第四行' },
			{ startTime: 4000, content: '第五行' },
		])`,
	)
	await sleep(700)

	const afterPush = await evaluate(
		lyricsWin,
		`window.bbLyricsWindow.describe()`,
	)
	check(
		'歌词行数已达 5',
		afterPush.lineCount === 5,
		String(afterPush.lineCount),
	)
	check(
		'行元素**真的渲染进 DOM**（这里用的是独立实现，不依赖主窗口那套）',
		afterPush.lineElements === 5,
		`DOM 里 ${afterPush.lineElements} 行`,
	)
	check('空态已隐藏', afterPush.emptyHidden === true)

	const translationCount = await evaluate(
		lyricsWin,
		`document.querySelectorAll('.lyrics__translation').length`,
	)
	check('翻译行也渲染了', translationCount === 1, `${translationCount} 行翻译`)

	const firstLineText = await evaluate(
		lyricsWin,
		`document.querySelector('[data-testid="lw-line-0"]')?.textContent ?? null`,
	)
	check('行文本内容正确', firstLineText === '第一行', String(firstLineText))

	await shot(lyricsWin, 'lyrics-window-01-with-lyrics')

	// ---------- 5. 位置驱动高亮与平移 ----------
	const positions = [
		{ seconds: 0.5, expect: 0 },
		{ seconds: 2.5, expect: 2 },
		{ seconds: 4.5, expect: 4 },
		// 超出最后一行 -> 停在最后一行
		{ seconds: 9.9, expect: 4 },
		// 回到开头
		{ seconds: 0, expect: 0 },
	]
	for (const probe of positions) {
		await evaluate(
			window,
			`window.bbplayer.lyricsWindow.pushPosition(${probe.seconds})`,
		)
		await sleep(250)
		const state = await evaluate(lyricsWin, `window.bbLyricsWindow.describe()`)
		check(
			`位置 ${probe.seconds}s 高亮到第 ${probe.expect + 1} 行`,
			state.activeIndex === probe.expect,
			`activeIndex=${state.activeIndex}`,
		)
	}

	// 高亮类必须真的写进 DOM（只改状态不算）
	await evaluate(window, `window.bbplayer.lyricsWindow.pushPosition(2.5)`)
	await sleep(300)
	const highlight = await evaluate(
		lyricsWin,
		`(() => {
			const active = document.querySelectorAll('.lyrics__line.is-active')
			return {
				count: active.length,
				index: active[0]?.dataset?.index ?? null,
				text: active[0]?.textContent ?? null,
			}
		})()`,
	)
	check(
		'高亮类已写入 DOM 且指向正确行',
		highlight.count === 1 && highlight.index === '2',
		JSON.stringify(highlight),
	)

	// 平移量必须随高亮变化（否则只是「换了颜色」，歌词没跟着滚）
	const transforms = {}
	for (const seconds of [0.5, 2.5, 4.5]) {
		await evaluate(
			window,
			`window.bbplayer.lyricsWindow.pushPosition(${seconds})`,
		)
		await sleep(250)
		transforms[seconds] = await evaluate(
			lyricsWin,
			`document.querySelector('.lyrics__list')?.style.transform ?? null`,
		)
	}
	const uniqueTransforms = new Set(Object.values(transforms))
	check(
		'列表平移量随高亮行变化（真的在滚动）',
		uniqueTransforms.size === 3,
		JSON.stringify(transforms),
	)

	// ---------- 6. 曲目与进度 ----------
	await evaluate(
		window,
		`window.bbplayer.lyricsWindow.pushTrack({ title: '探针曲目', artist: '探针作者' })`,
	)
	await evaluate(window, `window.bbplayer.lyricsWindow.pushProgress(0.42)`)
	await sleep(400)
	const trackState = await evaluate(
		lyricsWin,
		`window.bbLyricsWindow.describe()`,
	)
	check('标题已更新', trackState.title === '探针曲目', String(trackState.title))
	check(
		'进度条宽度已更新',
		String(trackState.progressWidth).startsWith('42'),
		String(trackState.progressWidth),
	)

	// 超范围进度要做夹取（否则进度条会画到窗口外）
	await evaluate(window, `window.bbplayer.lyricsWindow.pushProgress(5)`)
	await sleep(250)
	// ⚠️ 注意这里用的是元素的 **id**（`progress-bar`），不是 `data-testid`
	// （`lw-progress`）。第一版混用了两者，`getElementById` 返回 null，
	// 把正确的实现误报成缺陷。
	const clamped = await evaluate(
		lyricsWin,
		`document.getElementById('progress-bar')?.style.width ?? null`,
	)
	check('超范围进度被夹到 100%', clamped === '100%', String(clamped))

	// ---------- 7. 锁定拖动 ----------
	// 走**真实点击**（而不是直接调 API），因为要验证的正是「点按钮有没有效果」
	await evaluate(lyricsWin, `document.getElementById('btn-lock').click()`)
	await sleep(300)
	const locked = await evaluate(
		lyricsWin,
		`(() => ({
			bodyLocked: document.body.classList.contains('is-locked'),
			icon: document.getElementById('btn-lock')?.textContent ?? null,
		}))()`,
	)
	check(
		'点锁定按钮后 body 加上 is-locked 且图标变化',
		locked.bodyLocked === true && locked.icon === '🔒',
		JSON.stringify(locked),
	)
	await evaluate(lyricsWin, `document.getElementById('btn-lock').click()`)
	await sleep(300)
	const unlocked = await evaluate(
		lyricsWin,
		`document.body.classList.contains('is-locked')`,
	)
	check('再点一次可以解锁', unlocked === false)

	await shot(lyricsWin, 'lyrics-window-02-final')

	// ---------- 8. 主窗口侧的集成 ----------
	//
	// 主窗口在换曲/匹配成功时会推歌词。这里无法触发真实匹配（要网络），
	// 所以只断言「推送链路已接上」：主窗口的 bridge 上这些方法都存在。
	const mainBridge = await evaluate(
		window,
		`(() => {
			const b = window.bbplayer?.lyricsWindow
			if (!b) return null
			return {
				pushLyrics: typeof b.pushLyrics,
				pushPosition: typeof b.pushPosition,
				pushTrack: typeof b.pushTrack,
				pushProgress: typeof b.pushProgress,
				onOpened: typeof b.onOpened,
				onClosed: typeof b.onClosed,
				onRequestState: typeof b.onRequestState,
			}
		})()`,
	)
	check(
		'主窗口的推送链路完整',
		mainBridge &&
			Object.values(mainBridge).every((kind) => kind === 'function'),
		JSON.stringify(mainBridge),
	)

	// 右栏工具栏有切换按钮，快捷键也注册了
	const entryPoints = await evaluate(
		window,
		`(() => ({
			button: Boolean(document.getElementById('lyrics-popout')),
			shortcut: window.bbUI.keys().some((k) => k.combo === 'ctrl+alt+l'),
		}))()`,
	)
	check('右栏有「独立窗口」按钮', entryPoints.button === true)
	check('快捷键 Ctrl+Alt+L 已注册', entryPoints.shortcut === true)

	// ---------- 9. 关闭 ----------
	await evaluate(window, `window.bbplayer.lyricsWindow.close()`)
	await sleep(800)
	check('能关闭歌词窗口', !lyricsWindow.describe().open)
	check(
		'关闭后窗口数量回到 1',
		BrowserWindow.getAllWindows().length === 1,
		`${BrowserWindow.getAllWindows().length} 个`,
	)

	// 幂等：重复打开/关闭不应出错
	const reopen = await evaluate(window, `window.bbplayer.lyricsWindow.toggle()`)
	check('关闭后可以再次打开', reopen?.data?.open === true)
	await sleep(600)
	const secondClose = await evaluate(
		window,
		`window.bbplayer.lyricsWindow.close()`,
	)
	check('再次关闭成功（无残留窗口）', secondClose?.ok === true)
	check(
		'最终只剩主窗口',
		BrowserWindow.getAllWindows().length === 1,
		`${BrowserWindow.getAllWindows().length} 个`,
	)

	// ---------- 待人工验证 ----------
	todo(
		'无边框透明窗口在各平台的实际观感',
		'半透明背景与圆角是否好看、置顶层级是否合适、多显示器下的位置是否合理，都需要人眼看',
	)
	todo(
		'拖动与点击穿透的体验',
		'「锁定」只做到不可拖动；真正让鼠标穿透到下层窗口需要 setIgnoreMouseEvents，属于另一个交互决策',
	)

	return finish(window)
}

/** 轮询等待一个同步谓词成立 */
async function waitFor(predicate, timeoutMs, label) {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		try {
			if (predicate()) return true
		} catch {
			// 谓词里访问已销毁对象会抛，视为「还没好」
		}
		await sleep(200)
	}
	console.log(`[lw] 等待超时：${label}`)
	return false
}

function finish(_window) {
	fs.mkdirSync(path.dirname(REPORT), { recursive: true })
	const passed = checks.filter((c) => c.ok).length
	const failed = checks.length - passed
	fs.writeFileSync(
		REPORT,
		JSON.stringify({ checks, screenshots, pending, passed, failed }, null, 2),
	)
	console.log(`[lw] 报告已写入 ${REPORT}`)
	console.log(
		`[lw] 结果: ${passed} 通过 / ${failed} 失败 / ${pending.length} 待人工验证`,
	)

	// ⚠️ 必须关掉**所有**窗口。只 destroy 主窗口时，歌词窗口还开着 ->
	// `window-all-closed` 不触发；若外层只依赖它退出就会一直挂着
	// （实测外层脚本等到 420s 超时）。这里显式销毁全部窗口，
	// 让 `window-all-closed` 或 main.cjs 的 finally 都能收尾。
	try {
		const { BrowserWindow } = require('electron')
		for (const candidate of BrowserWindow.getAllWindows()) {
			if (!candidate.isDestroyed()) candidate.destroy()
		}
	} catch (error) {
		console.log(`[lw] 关闭窗口时出错：${error.message}`)
	}
}

module.exports = { run }
