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

/**
 * **像素体检**：这一帧到底有没有内容。
 *
 * 为什么非要有它：体检表（`auditVisibility` / `auditLayout`）量的是 **DOM** ——
 * 元素在不在、有没有尺寸、在不在视口里。这些**全都证明不了它被画出来了**。
 *
 * 而探针窗口现在是不显示的（`main.cjs` 的 `createWindow`），隐藏窗口一旦被
 * 节流，`capturePage()` 就会返回**纯色空图**，DOM 体检却依然全绿 ——
 * 那时"33 张 0 问题"会是一句谎话。
 *
 * 做法：从位图里稀疏采样，数**不同颜色**的个数。正常界面有几百上千种颜色
 * （文字抗锯齿、渐变、封面），纯色空图只有 1–2 种。
 */
function inspectFrame(image) {
	const bitmap = image.toBitmap() // BGRA
	if (!bitmap || bitmap.length < 16) {
		return { blank: true, distinctColors: 0, redRange: 0, sampled: 0 }
	}
	const pixels = Math.floor(bitmap.length / 4)
	// 最多采样约 4000 个点；步长取整到 4 的倍数（保证落在像素边界上）
	const step = Math.max(1, Math.floor(pixels / 4000)) * 4
	const colors = new Set()
	let min = 255
	let max = 0
	let sampled = 0
	for (let i = 0; i + 3 < bitmap.length; i += step) {
		const b = bitmap[i]
		const g = bitmap[i + 1]
		const r = bitmap[i + 2]
		colors.add((r << 16) | (g << 8) | b)
		if (r < min) min = r
		if (r > max) max = r
		sampled++
	}
	return {
		sampled,
		distinctColors: colors.size,
		redRange: max - min,
		// 只有一两种颜色 = 空白/纯色帧
		blank: colors.size <= 2,
	}
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
	const frame = inspectFrame(image)
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
	// 「每个角落都看过」的**机械化**那一半：把三次"元素量得出尺寸却看不见"
	// 的教训写成四条通用规则，在每一屏上自动跑（见 auditLayout 的注释）。
	const layoutProblems = await auditLayout(window)
	audit.layoutProblems = layoutProblems
	audit.frame = frame
	if (layoutProblems.length > 0) {
		report.problems.push(
			`${name} 布局体检：${layoutProblems.slice(0, 3).join('；')}`,
		)
	}
	// ⚠️ **像素**体检：这一帧到底有没有内容。
	//
	// 体检表量的是 DOM（元素在不在、有没有尺寸），它**证明不了画出来了**。
	// 而探针窗口现在是不显示的（见 main.cjs 的 createWindow），
	// 隐藏窗口一旦被节流就会截出**纯色空图** —— 而 DOM 体检依然全绿。
	// 所以这里直接数像素：整张图只有一两种颜色就是空图。
	if (frame.blank) {
		report.problems.push(
			`${name} 截图像是空图：只有 ${frame.distinctColors} 种颜色（通道极差 ${frame.redRange}）`,
		)
	}
	report.shots.push({ name, note, file, ...size, audit })
	console.log(
		`  📷 ${name}  ${size.width}x${size.height}  ${note}  ${audit.summary}` +
			(layoutProblems.length > 0 ? `  ⚠ ${layoutProblems.length} 条` : '') +
			(frame.blank ? '  ⚠ 空图' : `  ${frame.distinctColors}色`),
	)
	return file
}

/**
 * **布局体检**：把"每个角落都看过"变成机械检查。
 *
 * 为什么需要它：这一路上遇到的三个真问题都是同一个形状 ——
 * **元素在 DOM 里、量得出尺寸、断言全绿，但用户看不见**：
 *   * 设置页被放到 `.app` 外面（排在视口下方）；
 *   * 正在播放的标题因 flex 项被 blockify + line-clamp 而**高度为 0**；
 *   * 面板封面 `hidden` 摘不掉、占位图标又被藏起来，**两头都空**。
 *
 * 逐张盯着 PNG 找这类问题很不可靠、也不可复现。下面四条规则是那三个问题的
 * **一般化**，能在每一屏上自动跑：
 *
 *   1. 整页横向溢出（有东西把页面撑宽了）；
 *   2. **有文字却高度为 0** 的元素（标题塌掉的那一类）；
 *   3. 文字被容器横向裁掉（写了 `overflow: hidden` 却没写 `ellipsis`）；
 *   4. 可见元素整个落在视口之外（放到屏幕外的那一类）。
 *
 * 只看**有自己文字的元素**，避免把纯布局容器算进来（误报会很吵）。
 */
async function auditLayout(window) {
	try {
		/** @type {string[]} */
		const problems = JSON.parse(
			await evaluate(
				window,
				`(() => {
					const problems = []
					const vw = window.innerWidth
					const vh = window.innerHeight

					const doc = document.documentElement
					if (doc.scrollWidth > vw + 2) {
						problems.push('整页横向溢出 ' + doc.scrollWidth + ' > ' + vw)
					}

					const isVisible = (s) =>
						s.display !== 'none' &&
						s.visibility !== 'hidden' &&
						Number(s.opacity) !== 0

					/**
					 * 祖先里有没有"会滚动/裁剪"的容器。
					 *
					 * 有的话，这个元素在视口外是**正常的**（长列表滚出屏幕、
					 * 收起的面板把内容裁掉），不该报。
					 */
					const hasScrollableAncestor = (el) => {
						let node = el.parentElement
						while (node && node !== document.body) {
							const s = getComputedStyle(node)
							if (s.overflowY !== 'visible' || s.overflowX !== 'visible') {
								return true
							}
							node = node.parentElement
						}
						return false
					}

					for (const el of document.querySelectorAll('body *')) {
						// 跳过探针自己注入的临时节点
						if (el.closest('[data-testid="toast-host"], .status-host')) continue
						const s = getComputedStyle(el)
						if (!isVisible(s)) continue
						const r = el.getBoundingClientRect()
						if (r.width === 0 && r.height === 0) continue

						const ownText = [...el.childNodes]
							.filter((n) => n.nodeType === 3)
							.map((n) => n.textContent.trim())
							.join('')
						if (ownText.length === 0) continue
						const label =
							(el.id ? '#' + el.id : '') +
							(typeof el.className === 'string' && el.className
								? '.' + el.className.split(' ')[0]
								: '') +
							' 「' + ownText.slice(0, 14) + '」'

						if (ownText.length > 1 && r.height < 1) {
							problems.push('文字高度为 0：' + label)
						}
						if (
							ownText.length > 8 &&
							s.overflow !== 'visible' &&
							el.scrollWidth > el.clientWidth + 4 &&
							s.textOverflow === 'clip'
						) {
							problems.push('文字被裁掉：' + label)
						}
						if (
							r.width > 4 &&
							r.height > 4 &&
							s.position !== 'absolute' &&
							// ⚠️ 有**滚动祖先**的元素不算"在视口外" ——
							// 长列表里滚出屏幕的行本来就在视口外，那是正常的。
							// 同理，"收起"的右栏（列宽 0 + overflow: hidden）里的
							// 元素也在视口外，那是收起的实现方式。
							// 第一版没这条判断，16 张截图每张都报十来条误报
							// （曲目标题的文本节点、右栏的「播放队列」页签…），
							// 真问题会被淹掉。
							!hasScrollableAncestor(el) &&
							(r.bottom < -4 || r.top > vh + 4 || r.right < -4 || r.left > vw + 4)
						) {
							problems.push('可见元素在视口外：' + label)
						}
					}
					return JSON.stringify([...new Set(problems)].slice(0, 12))
				})()`,
			),
		)
		return problems
	} catch (error) {
		return [`体检失败：${error.message}`]
	}
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
						// 「正在播放」面板的内部状态 —— 标题 / 封面 / 占位图标。
						// 截图里"元素不该缺却看不见"时，这几个字段能直接定位，
						// 不用靠盯着 PNG 猜。
						nowPlaying: (() => {
							const root = document.getElementById('view-nowplaying')
							if (!root || root.hidden) return null
							const title = document.getElementById('nowplaying-title')
							const artist = document.getElementById('nowplaying-artist')
							const cover = document.getElementById('nowplaying-cover')
							const placeholder = document.getElementById('nowplaying-placeholder')
							const art = document.querySelector('.nowplaying__art')
							const describe = (el) => {
								if (!el) return null
								const s = getComputedStyle(el)
								return {
									text: (el.textContent || '').slice(0, 40),
									hidden: Boolean(el.hidden),
									display: s.display,
									color: s.color,
									fontSize: s.fontSize,
									box: visibleBox(el),
								}
							}
							return {
								title: describe(title),
								artist: describe(artist),
								coverHidden: cover?.hidden ?? null,
								coverSrc: cover?.getAttribute('src') ?? null,
								placeholder: describe(placeholder),
								artBg: art ? getComputedStyle(art).backgroundColor : null,
							}
						})(),
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
	// 导入结束后落在**歌单详情**（曲目表 + 返回）。先拍它，再回列表拍卡片网格 ——
	// 阶段 6d 之后这是**两个状态**，各有各会出问题的地方（详情漏返回、网格不渲染）。
	await shot(
		window,
		'02-library-playlist-detail',
		'音乐库 › 歌单详情（曲目表）',
	)

	// 滚动之后的冻结表头 —— 用户截图圈的就是这个状态：表头不该变成一条
	// 与卡片不同色的横带、不该盖住卡片的圆角、也不该和表体对不上。
	// **不滚动的话这个状态根本不会出现**，也就永远巡检不到。
	await evaluate(
		window,
		`(() => {
			document.getElementById('content').scrollTop = 420
			return true
		})()`,
	)
	await sleep(600)
	await shot(
		window,
		'02c-library-scrolled-head',
		'音乐库 › 歌单详情（滚动后的冻结表头）',
	)
	await evaluate(
		window,
		`(() => {
			document.getElementById('content').scrollTop = 0
			return true
		})()`,
	)
	await sleep(400)

	await click(window, '[data-testid="playlist-back"]')
	await sleep(1000)
	await shot(
		window,
		'02b-library-playlists-grid',
		'音乐库 › 播放列表（歌单卡片网格）',
	)

	console.log('\n=== 3) 音乐库的四个页签 ===')
	for (const [tab, name, note] of [
		['favorites', '03-library-favorites', '音乐库 › 收藏夹'],
		['collection', '04-library-collection', '音乐库 › 合集'],
		['import', '05-library-import', '音乐库 › 导入'],
		['playlists', '06-library-playlists-again', '音乐库 › 切回播放列表'],
	]) {
		await click(window, `[data-testid="lib-tab-${tab}"]`)
		await sleep(1500)
		// ⚠️ 这张图原来叫 '06-library-back'，画面与 02 几乎一样 —— 那时页签的
		// 内容是"当前歌单的曲目表"，根本没有"回列表"这回事。
		//
		// 阶段 6d 之后**确实有**这一步了：页签的内容是歌单**卡片网格**，
		// 曲目表在详情里。所以断言改成：切回播放列表 = 回到卡片网格，
		// 且左栏的歌单行仍在（两个入口指向同一批歌单，不能有一个是空的）。
		if (tab === 'playlists') {
			const back = JSON.parse(
				await evaluate(
					window,
					`(() => JSON.stringify({
						cards: document.querySelectorAll('.media-card').length,
						rows: document.querySelectorAll('[data-playlist-id]').length,
						trackTable: Boolean(
							document.querySelector('[data-testid="track-table"]'),
						),
					}))()`,
				),
			)
			if (back.cards === 0) {
				report.problems.push(
					'切回播放列表后没有歌单卡片（页签内容不是歌单列表）',
				)
			} else if (back.trackTable) {
				report.problems.push('播放列表页签里出现了曲目表（那是详情的内容）')
			} else if (back.rows === 0) {
				report.problems.push('左栏歌单列表为空 —— 两个入口指向的列表不一致')
			} else {
				console.log(
					`  ✓ 卡片网格与左栏歌单行同时可见（${back.cards} 张卡 / ${back.rows} 行）`,
				)
			}
		}
		await shot(window, name, note)
	}

	console.log('\n=== 4) 主页 ===')
	await click(window, '[data-testid="nav-home"]')
	await sleep(1200)
	await shot(
		window,
		'07-home',
		'主页（听歌频率 / 快捷入口 / 最近更新 / 播放历史）',
	)
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
	// 音乐库页签是歌单卡片网格（阶段 6d），曲目表在详情里 —— 先点一张卡
	await click(window, '[data-testid^="playlist-card-"]')
	await sleep(1300)
	await click(window, '[data-testid="btn-play-all"]')
	await sleep(2500)
	await click(window, '[data-testid="rightbar-toggle"]')
	await sleep(600)
	await shot(window, '12-rightbar-queue', '右栏 › 播放队列')
	await click(window, '[data-testid="tab-lyrics"]')
	await sleep(2500)
	await shot(window, '13-rightbar-lyrics', '右栏 › 歌词')

	console.log('\n=== 6b) 多选 ===')
	// 收起右栏，免得它把中栏挤窄（多选工具条要在一屏里看全）
	await click(window, '[data-testid="tab-queue"]')
	await sleep(400)
	await click(window, '[data-testid="rightbar-toggle"]')
	await sleep(600)
	await evaluate(
		window,
		`(() => {
			// 进多选并选中前 3 首（与用户在界面上 Ctrl 点选的效果一致 ——
			// 用真实事件而不是直接改类名，否则截图里的状态可能是"画出来的"）
			document.querySelector('[data-testid="btn-select-mode"]')?.click()
			const rows = [...document.querySelectorAll('.track-table tbody tr')].slice(0, 3)
			for (const row of rows) {
				row.dispatchEvent(
					new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
				)
			}
			return true
		})()`,
	)
	await sleep(800)
	await shot(window, '30-multi-select', '多选（工具条 + 行首复选框）')
	await click(window, '[data-testid="selection-clear"]')
	await sleep(500)

	console.log('\n=== 6c) 主页（听过之后的热力图）===')
	// 阶段 6d 之前主页在**有播放记录之前**拍过一次（07-home），那时热力图是
	// 一片灰格子。这里在播放之后再拍一张 —— 档位配色（主题色的四档）
	// 只有真有数据时才看得出来，而"配色对不对"正是这一步要核对的。
	await click(window, '[data-testid="nav-home"]')
	await sleep(2500)
	await shot(window, '07b-home-heatmap', '主页 › 听歌频率（有播放记录）')

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

	console.log('\n=== 8b) 正在播放面板（阶段 4b）===')
	// 先让队列有内容：回到音乐库，进一个歌单详情，点「播放全部」
	await click(window, '[data-testid="nav-library"]')
	await sleep(800)
	await click(window, '[data-testid^="playlist-card-"]')
	await sleep(1300)
	await click(window, '[data-testid="btn-play-all"]')
	await sleep(2000)
	await click(window, '[data-testid="playbar-cover"]')
	await sleep(1200)
	await shot(window, '31-nowplaying', '正在播放（大封面 + 模糊背景 + 队列）')
	await click(window, '[data-testid="nowplaying-close"]')
	await sleep(600)

	console.log('\n=== 9) 共享面板（页内动作）===')
	await click(window, '[data-testid="nav-library"]')
	await sleep(600)
	await click(window, '[data-testid="library-share"]')
	await sleep(1500)
	await shot(window, '32-share', '共享歌单面板')

	console.log('\n=== 10) 搜索无结果 / 空状态 ===')
	// ⚠️ 这里原来用的是 'zzzzzzzzzzzzzz'，但 B 站搜索对任何字符串都会
	// **模糊匹配出结果** —— 实测返回了 20 条，于是这张名为
	// "search-empty-result" 的截图**从来没有拍到过空状态**。
	//
	// 是子代理逐张看图时发现的（它读到 20 条却看见文件名写着"无结果"）。
	// 现在的做法有两条：用一个更不可能命中的长随机串，
	// 并且**断言真的 0 行** —— 拿不到空状态就报成问题，
	// 而不是继续悄悄拍一张有结果的图。
	const emptyQuery = 'qzjxvbkwmfnrptyudhglsacoie'
	await click(window, '[data-testid="nav-search"]')
	await sleep(600)
	await evaluate(
		window,
		`(() => {
			const input = document.getElementById('search-input')
			input.value = '${emptyQuery}'
			input.dispatchEvent(new Event('input', { bubbles: true }))
			return true
		})()`,
	)
	await click(window, '[data-testid="search-button"]')
	await sleep(4500)
	/*
	 * ⚠️ 第一版的断言查的是 `[data-testid^="search-result-"]` —— 那个属性
	 * **根本不存在**，于是恒为 0、**永远报"已覆盖"**，而截图里明明是 20 条结果。
	 * 又一次"断言测错了元素"（这个仓库已经栽过好几次）。
	 *
	 * 现在改成读**数据源本身**（`bbLibrary.getTracks()`）：它不可能与画面不一致。
	 */
	const realSearch = JSON.parse(
		await evaluate(
			window,
			`(() => JSON.stringify({
				tracks: window.bbLibrary.getTracks().length,
			}))()`,
		),
	)
	console.log(
		`  · 查询「${emptyQuery}」实际返回 ${realSearch.tracks} 条（B 站搜索对任何字符串都会模糊匹配）`,
	)

	/*
	 * 所以「无结果」这个状态**走真实搜索到不了** —— 与其继续拍一张有结果的图
	 * 冒充空状态，不如**确定性地驱动渲染层**：直接让曲目表收到一个空数组。
	 * 这样拍到的才是用户真的会看到的那个空状态。
	 */
	const emptyDriven = JSON.parse(
		await evaluate(
			window,
			`(() => {
				window.bbLibrary.renderTrackTable([], {
					query: '${emptyQuery}',
					title: '搜索',
				})
				const empty = document.querySelector('[data-testid="content-empty"]')
				const box = empty?.getBoundingClientRect()
				return JSON.stringify({
					rendered: Boolean(empty),
					visible: Boolean(box && box.width > 40 && box.height > 20),
					tracks: window.bbLibrary.getTracks().length,
					text: (empty?.textContent ?? '').slice(0, 60),
				})
			})()`,
		),
	)
	if (!emptyDriven.rendered || !emptyDriven.visible) {
		report.problems.push(
			`搜索无结果空状态没渲染出来（rendered=${emptyDriven.rendered} visible=${emptyDriven.visible}）`,
		)
	}
	// 清掉上一次真实搜索留下的 toast —— 否则截图里
	// 「找到 20 个结果」与「没有相关的结果」同框，自相矛盾。
	await evaluate(
		window,
		`(() => {
			const host = document.querySelector('[data-testid="toast-host"]')
			if (host) host.textContent = ''
			return true
		})()`,
	)
	console.log(
		`  ✓ 搜索无结果态：${emptyDriven.rendered ? '已渲染' : '未渲染'}，` +
			`曲目 ${emptyDriven.tracks} 条，文案「${emptyDriven.text}」`,
	)
	await shot(window, '33-search-empty-result', '搜索无结果（空状态）')

	console.log('\n=== 11) 窄窗口（看会不会挤坏）===')
	window.setSize(1040, 800)
	await sleep(700)
	await click(window, '[data-testid="nav-library"]')
	await sleep(1200)
	await shot(window, '34-narrow-library', '窄窗口（1040x800）')

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
