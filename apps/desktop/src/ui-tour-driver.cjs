/* oxlint-disable no-console -- 截图巡检驱动，以 stdout 输出进度 */
/**
 * UI 巡检驱动（阶段 5 的「逐个角落看过」）。
 *
 * ## 为什么要有它
 *
 * 断言能证明"元素存在、颜色一致、尺寸正确"，但**证明不了"好不好看"**。
 * 第一版界面被用户否掉的正是后者：断言全绿，观感依然杂乱。
 *
 * 所以需要一个**把每个视图、每个弹窗、每个空状态都截下来**的机制，
 * 让人（或模型）逐张看过。这个文件就是它。
 *
 * ## 用法
 *
 * ```
 * node scripts/capture-ui-tour.mjs            # 常规尺寸
 * node scripts/capture-ui-tour.mjs --dark     # 深色
 * ```
 *
 * 产出在 `apps/desktop/probe-output/ui-tour/<主题>/`，
 * 并写一份 `manifest.json`（顺序 + 说明 + 尺寸），便于按序核对。
 */
const fs = require('node:fs')
const path = require('node:path')

const OUT_ROOT =
	process.env.BBPLAYER_TOUR_DIR ??
	path.join(__dirname, '..', 'probe-output', 'ui-tour')

/**
 * 巡检结果（写进 manifest.json）。
 *
 * 显式写 JSDoc 类型不是为了好看：`shots: []` 会被推断成 `never[]`，
 * 于是 `report.problems` 里的字符串在模板字符串里被判成 `never`，
 * oxlint 直接报错（`restrict-template-expressions`）。
 *
 * @type {{
 *   theme: string | null,
 *   shots: Array<{ name: string, note: string, file: string, width: number, height: number }>,
 *   problems: string[],
 * }}
 */
const report = { theme: null, shots: [], problems: [] }

function shotDir(theme) {
	return path.join(OUT_ROOT, theme)
}

async function evaluate(window, expression) {
	return window.webContents.executeJavaScript(expression, true)
}

async function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 截图并存盘；同时记录尺寸，方便发现"截出来是空白" */
async function shot(window, name, note) {
	/*
	 * ⚠️ 截图前先**等一帧真正画出来**。
	 *
	 * `capturePage()` 抓的是窗口**当前已合成的帧**。渲染进程刚做完 DOM 变更时，
	 * 合成器可能还没产出新帧 —— 于是拿到的是上一屏的画面。
	 *
	 * 这个坑很隐蔽：截出来是空白，但体检表说元素明明可见（10/10）。
	 * 光看 PNG 会以为是布局问题，往 CSS 上找半天。
	 * `requestAnimationFrame` 连续两次能确保"这一帧已经画完"。
	 */
	await evaluate(
		window,
		`new Promise((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))),
		)`,
	)
	const image = await window.webContents.capturePage()
	const file = path.join(shotDir(report.theme), `${name}.png`)
	fs.writeFileSync(file, image.toPNG())
	const size = image.getSize()
	// 记录一张"这一屏里到底有什么"的体检表。
	//
	// ⚠️ 加这个是因为踩过一次：截图里设置页**一片空白**，
	// 而当时的断言是绿的（断言量的元素在 DOM 里、有尺寸）。
	// 光看 PNG 没法区分"没渲染"、"渲染了但透明"、"渲染在屏幕外"。
	// 把关键容器与可见行数记进 manifest，就能直接对照。
	const audit = await auditVisibility(window)
	report.shots.push({ name, note, file, ...size, audit })
	console.log(
		`  📷 ${name}  ${size.width}x${size.height}  ${note}  ${audit.summary}`,
	)
	return file
}

/** 这一屏里"实际看得见"的东西有多少 —— 用于判断空白截图 */
async function auditVisibility(window) {
	try {
		/** @type {any} */
		const data = JSON.parse(
			await evaluate(
				window,
				`(() => {
					const visibleBox = (el) => {
						if (!el) return null
						const r = el.getBoundingClientRect()
						const s = getComputedStyle(el)
						return {
							w: Math.round(r.width),
							h: Math.round(r.height),
							display: s.display,
							visibility: s.visibility,
							opacity: s.opacity,
						}
					}
					const main = document.querySelector('.main')
					const panes = [...(main?.children ?? [])].map((el) => ({
						cls: el.className || el.id,
						hidden: Boolean(el.hidden),
						box: visibleBox(el),
					}))
					const categories = document.getElementById('settings-categories')
					const catRows = [...document.querySelectorAll('[data-settings-category]')]
					// 设置子页的容器与当前激活的子页 —— 用来判断"子页是不是画在了屏幕外"
					const panelsBox = document.getElementById('settings-panels')
					const activePanel = document.querySelector(
						'[data-settings-panel].is-active',
					)
					return JSON.stringify({
						panes,
						categoriesBox: visibleBox(categories),
						categoriesHidden: Boolean(categories?.hidden),
						categoryCount: catRows.length,
						categoriesVisible: catRows.filter((el) => {
							const r = el.getBoundingClientRect()
							return r.width > 10 && r.height > 10
						}).length,
						panesActive: document.querySelectorAll(
							'[data-settings-panel].is-active',
						).length,
						panelsBoxRect: visibleBox(panelsBox),
						panelsBoxHidden: Boolean(panelsBox?.hidden),
						activePanelRect: visibleBox(activePanel),
						activePanelName: activePanel?.dataset.settingsPanel ?? null,
						// 从激活的子页往上走到 body，记下每一层的 display / position。
						// 这一条是"元素量得出尺寸但画不出来"的**决定性证据**：
						// 一眼看出它挂在谁下面、有没有脱离文档流。
						//
						// ⚠️ 这里**不能**用嵌套模板字符串（反引号会结束外层模板）。
						// 全部用字符串拼接。
						activePanelAncestry: (() => {
							const chain = []
							let node = activePanel
							while (node && node !== document.body && chain.length < 12) {
								const s = getComputedStyle(node)
								const cls = String(node.className || '-').split(' ')[0]
								chain.push(
									node.tagName.toLowerCase() +
										'#' +
										(node.id || '-') +
										'.' +
										cls +
										' [' +
										s.display +
										' ' +
										s.position +
										']',
								)
								node = node.parentElement
							}
							return chain
						})(),
						viewportH: window.innerHeight,
						viewportW: window.innerWidth,
					})
				})()`,
			),
		)
		data.summary = `设置分类 ${data.categoriesVisible}/${data.categoryCount} 可见，主区子页 ${data.panes.length} 个`
		return data
	} catch (error) {
		return { summary: `体检失败：${error.message}` }
	}
}

async function click(window, selector) {
	const ok = await evaluate(
		window,
		`(() => {
			const el = document.querySelector(${JSON.stringify(selector)})
			if (!el) return false
			el.click()
			return true
		})()`,
	)
	if (!ok) report.problems.push(`点不到 ${selector}`)
	return ok
}

async function waitFor(window, expression, timeoutMs = 20_000, label = '') {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			if (await evaluate(window, `Boolean(${expression})`)) return true
		} catch {
			// 页面可能在导航中，继续等
		}
		await sleep(250)
	}
	report.problems.push(`等待超时：${label || expression}`)
	return false
}

/**
 * 逐页巡检。
 *
 * 顺序刻意从"空库"开始：空状态是最容易被忽略、也最容易看起来没做完的地方。
 */
async function run(window) {
	const theme = process.argv.includes('--dark') ? 'dark' : 'light'
	report.theme = theme
	fs.mkdirSync(shotDir(theme), { recursive: true })

	await waitFor(window, 'window.__bbReady', 40_000, '渲染进程就绪')

	// 固定主题，避免"跟随系统"让两套截图混在一起
	await evaluate(
		window,
		`window.bbplayer.settings.update({ theme: ${JSON.stringify(theme)} })`,
	)
	await sleep(900)

	// 固定窗口尺寸：不同尺寸下布局问题不一样，先保证可比较
	window.setSize(1440, 940)
	await sleep(400)

	console.log('\n=== 1) 空库 ===')
	await shot(window, '01-empty-welcome', '空库欢迎视图')

	console.log('\n=== 2) 导入示例合集（灌入真实数据）===')
	const imported = await waitFor(
		window,
		`document.querySelector('[data-testid="btn-seed-demo"]')`,
		15_000,
		'欢迎视图的导入按钮',
	)
	if (imported) {
		await click(window, '[data-testid="btn-seed-demo"]')
		await waitFor(
			window,
			'window.bbTest.ui().trackRows > 0',
			90_000,
			'曲目落库',
		)
		await sleep(1200)
	}
	await shot(window, '02-library-playlists', '音乐库 › 播放列表（有内容）')

	console.log('\n=== 3) 音乐库的四个页签 ===')
	for (const [tab, name, note] of [
		['favorites', '03-library-favorites', '音乐库 › 收藏夹'],
		['collection', '04-library-collection', '音乐库 › 合集'],
		['import', '05-library-import', '音乐库 › 导入'],
		['playlists', '06-library-back', '音乐库 › 回到播放列表'],
	]) {
		await click(window, `[data-testid="lib-tab-${tab}"]`)
		await sleep(1500)
		await shot(window, name, note)
	}

	console.log('\n=== 4) 主页 ===')
	await click(window, '[data-testid="nav-home"]')
	await sleep(1200)
	await shot(window, '07-home', '主页（最近播放 / 最常 / 继续收听）')
	// 三个子页签都看一眼
	for (const [tab, name] of [
		['most', '08-home-most'],
		['resume', '09-home-resume'],
	]) {
		const clicked = await click(window, `[data-testid="history-tab-${tab}"]`)
		if (clicked) {
			await sleep(900)
			await shot(window, name, `主页 › ${tab}`)
		}
	}

	console.log('\n=== 5) 搜索 ===')
	await click(window, '[data-testid="nav-search"]')
	await sleep(800)
	await shot(window, '10-search-empty', '搜索（未输入）')
	await evaluate(
		window,
		`(() => {
			const input = document.getElementById('search-input')
			input.value = '周杰伦'
			input.dispatchEvent(new Event('input', { bubbles: true }))
			return true
		})()`,
	)
	await click(window, '[data-testid="search-button"]')
	await sleep(4000)
	await shot(window, '11-search-results', '搜索结果')

	console.log('\n=== 6) 右栏（队列 / 歌词）===')
	// 播放一首，让队列有"正在播放"
	await click(window, '[data-testid="nav-library"]')
	await sleep(800)
	await click(window, '[data-testid="btn-play-all"]')
	await sleep(2500)
	await click(window, '[data-testid="rightbar-toggle"]')
	await sleep(600)
	await shot(window, '12-rightbar-queue', '右栏 › 播放队列')
	await click(window, '[data-testid="tab-lyrics"]')
	await sleep(2500)
	await shot(window, '13-rightbar-lyrics', '右栏 › 歌词')

	console.log('\n=== 7) 设置（一级页面：分类列表 + 每个子页）===')
	await click(window, '[data-testid="nav-settings"]')
	await sleep(1000)
	await shot(window, '14-settings-categories', '设置 › 分类列表')

	for (const [category, name, note] of [
		['theme', '15-settings-theme', '设置 › 主题'],
		['appearance', '16-settings-appearance', '设置 › 外观'],
		['playback', '17-settings-playback', '设置 › 播放'],
		['lyrics', '18-settings-lyrics', '设置 › 歌词'],
		['download', '19-settings-download', '设置 › 下载'],
		['account-bili', '20-settings-account-bili', '设置 › Bilibili 账号'],
		[
			'account-bbplayer',
			'21-settings-account-bbplayer',
			'设置 › BBPlayer 账号',
		],
		['backup', '22-settings-backup', '设置 › 备份与恢复'],
		['general', '23-settings-general', '设置 › 通用'],
		['about', '24-settings-about', '设置 › 关于'],
	]) {
		// 每次先回分类列表，再进目标分类 —— 走真实路径，不是直接改类名
		await click(window, '[data-testid="settings-back"]')
		await sleep(400)
		const entered = await click(
			window,
			`[data-testid="settings-cat-${category}"]`,
		)
		if (!entered) {
			report.problems.push(`设置里点不进分类：${category}`)
			continue
		}
		await sleep(900)
		await shot(window, name, note)
	}
	// 诊断信息展开看一眼（它在「关于」里）
	await evaluate(
		window,
		`(() => {
			const d = document.querySelector('[data-testid="settings-diagnostics"]')
			if (d) d.open = true
			return true
		})()`,
	)
	await sleep(600)
	await shot(
		window,
		'25-settings-diagnostics',
		'设置 › 关于 › 诊断信息（展开）',
	)

	console.log('\n=== 8) 登录弹窗的每个页签 ===')
	await click(window, '[data-testid="account-open"]')
	await sleep(900)
	await shot(window, '26-login-qr', '登录弹窗 › 扫码')
	for (const [tab, name, note] of [
		['cookie', '27-login-cookie', '登录弹窗 › Cookie'],
		['password', '28-login-password', '登录弹窗 › 密码'],
		['account', '29-login-account', '登录弹窗 › 账号'],
	]) {
		const clicked = await click(window, `[data-login-tab="${tab}"]`)
		if (clicked) {
			await sleep(700)
			await shot(window, name, note)
		} else {
			report.problems.push(`登录弹窗没有 ${tab} 页签`)
		}
	}
	await click(window, '[data-testid="login-close"]')
	await sleep(600)

	console.log('\n=== 9) 共享面板（页内动作）===')
	await click(window, '[data-testid="nav-library"]')
	await sleep(600)
	await click(window, '[data-testid="library-share"]')
	await sleep(1500)
	await shot(window, '30-share', '共享歌单面板')

	console.log('\n=== 10) 搜索无结果 / 空状态 ===')
	await click(window, '[data-testid="nav-search"]')
	await sleep(600)
	await evaluate(
		window,
		`(() => {
			const input = document.getElementById('search-input')
			input.value = 'zzzzzzzzzzzzzz'
			input.dispatchEvent(new Event('input', { bubbles: true }))
			return true
		})()`,
	)
	await click(window, '[data-testid="search-button"]')
	await sleep(4500)
	await shot(window, '31-search-empty-result', '搜索无结果（空状态）')

	console.log('\n=== 11) 窄窗口（看会不会挤坏）===')
	window.setSize(1040, 800)
	await sleep(700)
	await click(window, '[data-testid="nav-library"]')
	await sleep(1200)
	await shot(window, '32-narrow-library', '窄窗口（1040x800）')

	// 亮色 / 深色都跑一遍后，把设置改回跟随系统
	await evaluate(window, `window.bbplayer.settings.update({ theme: 'system' })`)

	fs.writeFileSync(
		path.join(shotDir(theme), 'manifest.json'),
		JSON.stringify(report, null, 2),
	)
	console.log(
		`\n共 ${report.shots.length} 张，问题 ${report.problems.length} 条`,
	)
	for (const problem of report.problems) console.log(`  ⚠ ${problem}`)
	console.log(`清单位置：${path.join(shotDir(theme), 'manifest.json')}`)
	return report
}

module.exports = { run }
