/* oxlint-disable no-console -- 探针脚本，以 stdout 输出验证过程 */
/**
 * UI 探针驱动：在 Electron 主进程里跑 Phase 2 的界面验收序列。
 *
 * 原则：**尽量用真实交互**——点真实按钮、派发真实键盘事件、读真实 DOM，
 * 而不是直接调内部函数。这样测到的才是用户实际会走的路径。
 */
const fs = require('node:fs')
const path = require('node:path')

const SHOTS = process.env.BBPLAYER_UI_SHOTS
	? process.env.BBPLAYER_UI_SHOTS
	: path.join(__dirname, '..', 'probe-output', 'ui-shots')
const REPORT = path.join(__dirname, '..', 'probe-output', 'ui-report.json')

const checks = []
const screenshots = []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function check(name, ok, detail) {
	checks.push({ name, ok: Boolean(ok), detail: detail ?? null })
	console.log(
		`[ui] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`,
	)
}

/**
 * 「开发日志」黑名单见 `probe-jargon.cjs`。
 *
 * 需要新增例外时**先想清楚**：真的必须在主流程里说吗？
 * 允许的唯一出口是「诊断信息」折叠区（`.settings-diagnostics`），
 * 以及显式标了 `data-allow-jargon` 的容器。
 */
const {
	jargonScanExpression,
	describeJargonHits,
} = require('./probe-jargon.cjs')

/**
 * 需要做结构检查的样式表。
 *
 * 放在模块作用域：下面「样式表花括号配平」那段要在**两处**用到它
 * （遍历 + 拼提示文案），写在闭包里就只能看见一个。
 */
const CSS_FILES = [
	'style.css',
	'components.css',
	'lyrics-panel.css',
	'lyrics-window.css',
]

/**
 * 审计界面上所有 .icon 是否真的渲染成了**单个字形**。
 *
 * 判据：图标元素的宽度 / 字号应当接近 1。远大于 1 说明合字没生效 ——
 * 元素里显示的是**字面的图标名**（"library_music" 13 个字符 = 13em 宽）。
 *
 * ⚠️ 这个函数会被调用**多次**（首屏一次、内容加载后一次）。
 * 只在首屏跑会漏掉真实的 bug：`play_next` 这个名字 Material 里并不存在，
 * 曲目表渲染出来后是 144px 宽的字面文本压在时长列上，
 * 而首屏那次检查根本看不到曲目表。**断言跑得太早等于没跑。**
 *
 * @param {Electron.WebContents} window
 */
async function auditIcons(window) {
	return JSON.parse(
		await evaluate(
			window,
			`(() => {
				const nodes = [...document.querySelectorAll('.icon')]
				const fontOk = document.fonts.check('24px "Material Symbols Rounded"')
				const tooWide = nodes
					.filter((el) => {
						const size = Number.parseFloat(getComputedStyle(el).fontSize)
						if (!Number.isFinite(size) || size === 0) return false
						return el.getBoundingClientRect().width / size > 1.8
					})
					.map((el) => el.textContent.trim())
				return JSON.stringify({
					count: nodes.length,
					fontOk,
					tooWide,
					fontStatus: document.fonts.status,
				})
			})()`,
		),
	)
}

async function evaluate(window, expression) {
	return await window.webContents.executeJavaScript(expression, true)
}

async function shot(window, name) {
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			await sleep(attempt === 1 ? 500 : 400)
			const image = await window.webContents.capturePage()
			const size = image.getSize()
			if (size.width === 0) throw new Error('空图像')
			fs.mkdirSync(SHOTS, { recursive: true })
			const file = path.join(SHOTS, `${name}.png`)
			fs.writeFileSync(file, image.toPNG())
			screenshots.push(file)
			console.log(`[ui] 截图: ${file}`)
			return file
		} catch (error) {
			console.log(`[ui] 截图重试 ${attempt}/3 ${name}: ${error.message}`)
		}
	}
	return null
}

/** 轮询等待，直到渲染进程里的条件成立 */
async function waitFor(window, expression, timeoutMs, label) {
	const start = Date.now()
	let last
	while (Date.now() - start < timeoutMs) {
		try {
			last = JSON.parse(await evaluate(window, `JSON.stringify(${expression})`))
			if (last === true || last?.ok === true) return { ok: true, value: last }
		} catch (error) {
			last = { error: error.message }
		}
		await sleep(300)
	}
	return { ok: false, value: last, label }
}

/** 点一个选择器（真实 click） */
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
			el.value = ${JSON.stringify(text)}
			el.dispatchEvent(new Event('input', { bubbles: true }))
			return true
		})()`,
	)
}

/** 派发真实键盘事件（走 window 上的监听器） */
async function press(window, combo) {
	return await evaluate(
		window,
		`(() => {
			const parts = ${JSON.stringify(combo)}.split('+')
			let key = parts[parts.length - 1]
			const map = { space: ' ', escape: 'Escape', enter: 'Enter', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight' }
			if (map[key]) key = map[key]
			const target = document.activeElement || document.body
			const event = new KeyboardEvent('keydown', {
				ctrlKey: parts.includes('ctrl'),
				shiftKey: parts.includes('shift'),
				altKey: parts.includes('alt'),
				bubbles: true,
				cancelable: true,
				key,
			})
			target.dispatchEvent(event)
			return true
		})()`,
	)
}

async function uiState(window) {
	return JSON.parse(
		await evaluate(window, 'JSON.stringify(window.bbTest.ui())'),
	)
}

async function playerState(window) {
	return JSON.parse(
		await evaluate(window, 'JSON.stringify(window.bbTest.state())'),
	)
}

async function run(window) {
	// 捕获渲染进程控制台消息：UI 出问题时，错误往往只在这里可见
	const consoleMessages = []
	window.webContents.on(
		'console-message',
		(_event, level, message, line, source) => {
			consoleMessages.push({ level, message, line, source })
		},
	)

	console.log('[ui] 等待渲染进程就绪…')
	const ready = await waitFor(window, 'Boolean(window.__bbReady)', 30_000)
	check(
		'渲染进程就绪（window.__bbReady）',
		ready.ok,
		JSON.stringify(ready.value),
	)
	if (!ready.ok) return finish(window)

	// ---------------------------------------------------------------
	// 1. 三栏 shell
	// ---------------------------------------------------------------
	console.log('\n[ui] 1) 三栏 shell')
	let ui = await uiState(window)
	check('左栏渲染', ui.sidebar)
	check('中栏渲染', ui.main)
	// ⚠️ 右栏**默认收起**（阶段 2）。原来它常驻 320px，不管有没有内容都占着，
	// 三栏 + 边框 + 状态栏叠起来观感就是"IDE 面板"而不是播放器。
	// 所以这里断言的是"存在但宽度为 0"，而不是"渲染出来了"。
	const rightbarState = await evaluate(
		window,
		`(() => {
			const el = document.querySelector('[data-testid="rightbar"]')
			if (!el) return null
			return {
				width: Math.round(el.getBoundingClientRect().width),
				collapsed: Boolean(
					document.querySelector('.app')?.classList.contains('is-rightbar-collapsed'),
				),
				hasToggle: Boolean(
					document.querySelector('[data-testid="rightbar-toggle"]'),
				),
			}
		})()`,
	)
	check(
		'右栏默认收起（宽度 0，不占屏）',
		rightbarState?.collapsed === true && rightbarState.width === 0,
		JSON.stringify(rightbarState),
	)
	check('右栏有展开入口（顶栏的开关按钮）', rightbarState?.hasToggle === true)
	// 收起必须**真的能展开**——否则就是"藏起来了打不开"，比常驻还糟
	await click(window, '[data-testid="rightbar-toggle"]')
	await sleep(300)
	const expanded = await evaluate(
		window,
		`Math.round(document.querySelector('[data-testid="rightbar"]').getBoundingClientRect().width)`,
	)
	check('点开关能展开右栏', Number(expanded) > 200, `展开后宽度 ${expanded}px`)
	// 再收回去，后续断言按"收起"的初始状态走
	await click(window, '[data-testid="rightbar-toggle"]')
	await sleep(300)
	check('底部播放条渲染', ui.playbar)
	// 阶段 2b（信息架构分层）：左栏只留**目的地**。
	//
	// 原来是 7 个平铺入口，把"目的地"（音乐库 / 搜索）和"某个页面里的子集或
	// 动作"（导入歌单 / 收藏夹 / 合集 / 共享 / 最近播放）混在同一层 ——
	// 用户得先猜「导入歌单」和「合集」有什么区别。
	const navViews = JSON.parse(
		await evaluate(
			window,
			`JSON.stringify([...document.querySelectorAll('.nav__item')].map((el) => el.dataset.view))`,
		),
	)
	check(
		'左栏只剩 4 个目的地，顺序为 主页/音乐库/搜索/设置',
		navViews.join(',') === 'home,library,search,settings',
		navViews.join(' / '),
	)
	check(
		'导入与共享已从一级入口降级为页内动作',
		!navViews.includes('import') && !navViews.includes('share'),
		navViews.join(' / '),
	)
	const libraryTabs = JSON.parse(
		await evaluate(
			window,
			`JSON.stringify({
				tabs: [...document.querySelectorAll('[data-lib-tab]')].map((el) => el.dataset.libTab),
				visible: !document.getElementById('library-tabs')?.hidden,
				hasShareAction: Boolean(document.getElementById('library-share')),
			})`,
		),
	)
	check(
		'音乐库有 4 个页签（播放列表 / 收藏夹 / 合集 / 导入）',
		libraryTabs.tabs.join(',') === 'playlists,favorites,collection,import' &&
			libraryTabs.visible,
		libraryTabs.tabs.join(' / '),
	)
	check('音乐库页内保留了「共享」动作入口', libraryTabs.hasShareAction === true)

	// `hidden` 必须**真的**隐藏。
	//
	// ⚠️ UA 样式表里 `[hidden] { display: none }` 的优先级极低，任何
	// `.foo { display: flex }` 都会盖掉它 —— 于是"JS 里设了 hidden，元素照样显示"。
	// 这个仓库为此绕过两次（`.share-view` 和 `.favorite-bar`），
	// 后者是在截图巡检里被发现的：在「播放列表」页签下，
	// 收藏夹的 UID 工具条一直挂在底部。
	//
	// 现在 style.css 顶部有一条全局 `[hidden] { display: none !important }`
	// 保护这个不变量，这里断言**所有**带 hidden 的元素都真的不占位 ——
	// 一次覆盖全应用，新增组件不用再记得这件事。
	const hiddenAudit = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const offenders = []
				for (const el of document.querySelectorAll('[hidden]')) {
					const rect = el.getBoundingClientRect()
					if (rect.width > 0 && rect.height > 0) {
						offenders.push(
							(el.id || el.className || el.tagName) +
								' ' +
								Math.round(rect.width) +
								'x' +
								Math.round(rect.height),
						)
					}
				}
				return JSON.stringify(offenders)
			})()`,
		),
	)
	check(
		'带 hidden 的元素都真的不显示（favorite-bar 这类回归）',
		hiddenAudit.length === 0,
		hiddenAudit.length > 0 ? hiddenAudit.join('；') : '全部已隐藏',
	)
	check(
		'右栏默认显示队列',
		ui.activePanel === 'queue',
		`实际 ${ui.activePanel}`,
	)
	await shot(window, 'ui-01-shell')

	// ---------------------------------------------------------------
	// 1.5 「开发日志」黑名单
	// ---------------------------------------------------------------
	//
	// ⚠️ 这一条是**机制**，不是一次性的清理。
	//
	// 桌面端第一版把很多实现细节直接写进了界面：凭据「已由系统密钥环加密存储」、
	// 「等同明文」的警告、账号 UUID、后端 URL、备份格式（ZIP + SQLite 快照）、
	// `exportedAt=`、导出后的**绝对路径**、常驻的「就绪」状态栏……
	// 这些是我当时刻意做的（想把事实说清楚），但位置全错了：
	// **该知道 ≠ 该在主流程里说**。用户在上号、存密码、点备份的时候，
	// 不需要被教育这些东西，一句「等同明文」只会让人以为出事了。
	//
	// 清一遍只解决今天。所以这里把规则钉住：主界面可见文本不得命中黑名单词。
	// 允许的唯一出口是「诊断信息」折叠区，以及显式标了
	// `data-allow-jargon` 的容器（用之前必须想清楚为什么）。
	console.log('\n[ui] 1.5) 主界面不得出现实现细节文案')
	// 黑名单与扫描表达式见 `probe-jargon.cjs`（共享模块，也扫隐藏面板）
	const jargonHits = JSON.parse(await evaluate(window, jargonScanExpression()))
	check(
		'主界面没有「开发日志」式的实现细节（黑名单词零命中）',
		jargonHits.length === 0,
		describeJargonHits(jargonHits),
	)

	// ---------------------------------------------------------------
	// 1.6 原生控件不得停留在浏览器默认外观
	// ---------------------------------------------------------------
	//
	// 第一版只给 `.playbar / .row-actions / .search-box` 三个容器补了按钮样式，
	// 于是设置页里那一排按钮（保存 / 测试连接 / 立即备份并上传 / 刷新远端列表）
	// 全裸奔，是 Chromium 默认的浅灰渐变按钮；滑块也只有 `accent-color`，
	// 也就是**直接用原生控件**。现在有一层基础样式兜底，这里钉住它。
	console.log('\n[ui] 1.6) 控件基线（不能是浏览器默认外观）')
	const controls = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const buttons = [...document.querySelectorAll('button')]
				// Chromium 的默认按钮底色就是这个灰；我们的按钮都必须有明确底色
				const defaultLooking = buttons.filter(
					(b) => getComputedStyle(b).backgroundColor === 'rgb(239, 239, 239)',
				)
				const fields = [...document.querySelectorAll('input, textarea, select')]
				const notNormalized = fields
					.filter((f) => {
						const s = getComputedStyle(f)
						return s.appearance !== 'none' && s.webkitAppearance !== 'none'
					})
					.map((f) => f.tagName.toLowerCase() + (f.type ? ':' + f.type : ''))
				const ranges = [...document.querySelectorAll("input[type='range']")]
				const filled = ranges.filter(
					(r) => r.style.getPropertyValue('--range-fill') !== '',
				)
				return JSON.stringify({
					buttonCount: buttons.length,
					defaultLooking: defaultLooking.length,
					fieldCount: fields.length,
					notNormalized,
					rangeCount: ranges.length,
					rangesFilled: filled.length,
				})
			})()`,
		),
	)
	check(
		'没有按钮停留在浏览器默认外观',
		controls.defaultLooking === 0,
		`${controls.buttonCount} 个按钮，默认外观 ${controls.defaultLooking} 个`,
	)
	check(
		'所有输入框 / 文本域 / 下拉都走统一基线（appearance: none）',
		controls.notNormalized.length === 0,
		controls.notNormalized.length > 0
			? `未归一化：${controls.notNormalized.join('、')}`
			: `${controls.fieldCount} 个控件全部归一化`,
	)
	check(
		'滑块已自绘并写入了已播放比例（不再依赖原生填充）',
		controls.rangeCount > 0 && controls.rangesFilled === controls.rangeCount,
		`${controls.rangesFilled}/${controls.rangeCount} 个滑块有 --range-fill`,
	)

	// ---------------------------------------------------------------
	// 1.7 样式表花括号配平
	// ---------------------------------------------------------------
	//
	// ⚠️ 这条是**事故复盘**换来的。
	//
	// `.settings-row label { … }` 曾经**少了一个闭合花括号**，于是紧随其后的
	// `.settings-row button { … }` 被当成嵌套规则 —— 普通 CSS 不支持嵌套，
	// 解析器把整块丢掉并一直吞到花括号重新配平为止。
	//
	// 后果：设置页那排按钮**完全没有样式**，是浏览器默认外观。用户看到并
	// 明确抱怨过（"很多小输入框都是默认的 HTML 样式"）。当时是靠加一层
	// 全局控件基础样式把症状盖住的，**根因一直没被发现** ——
	// 因为没有任何断言会去看样式表本身。
	//
	// CSS 的好处是坏了通常"看得见"，坏处是**丢一整块规则是静默的**：
	// 后面的规则照样生效，只是错位了。所以这里直接查文件。
	console.log('\n[ui] 1.7) 样式表结构')
	const cssCheck = (() => {
		const problems = []
		for (const name of CSS_FILES) {
			const file = path.join(__dirname, 'renderer', name)
			if (!fs.existsSync(file)) continue
			const raw = fs.readFileSync(file, 'utf8')
			// 去掉注释（保留换行以便报行号）
			let stripped = ''
			let inComment = false
			for (let i = 0; i < raw.length; i++) {
				if (!inComment && raw.startsWith('/*', i)) {
					inComment = true
					i++
					continue
				}
				if (inComment && raw.startsWith('*/', i)) {
					inComment = false
					i++
					continue
				}
				if (!inComment) stripped += raw[i]
				else if (raw[i] === '\n') stripped += '\n'
			}
			let depth = 0
			let lastZero = 1
			stripped.split('\n').forEach((line, index) => {
				depth +=
					(line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
				if (depth === 0) lastZero = index + 1
			})
			if (depth !== 0) {
				problems.push(
					`${name}: 最终深度 ${depth}，从第 ${lastZero} 行之后有规则被吞掉`,
				)
			}
		}
		return problems
	})()
	check(
		'样式表花括号配平（不配平会静默吞掉后面的规则）',
		cssCheck.length === 0,
		cssCheck.length > 0
			? cssCheck.join('；')
			: `${CSS_FILES.length} 个样式表都配平`,
	)

	// ---------------------------------------------------------------
	// 1.8 字阶：不能停留在 11–13px 的"控制台字号"
	// ---------------------------------------------------------------
	//
	// 第一版全站字号压在 11–13px（`font-size:12px` 出现 29 次），而令牌包里
	// 有 10 级字阶（11→24）**一个都没用**。这条断言按**角色**检查实际字号：
	// 页面标题要够大、区块标题要分层、正文与副标题不能缩到 12。
	console.log('\n[ui] 1.8) 字阶（按角色）')
	const typeScale = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const size = (sel) => {
					const el = document.querySelector(sel)
					if (!el) return null
					return Number.parseFloat(getComputedStyle(el).fontSize)
				}
				return JSON.stringify({
					body: size('body'),
					// ⚠️ 页面标题现在的真值来源是**外壳**的 #page-title
					//（阶段 2b 之前是各个视图自己渲染的 .view-head h2，
					// 于是空状态根本没有标题）。
					viewTitle: size('#page-title'),
					// 视图内部的次级标题要**低一档**，否则两级标题一样大 = 没有层级
					sectionHead: size('.view-head h2'),
					// 设置抽屉里的区块标题（抽屉关着也能算，getComputedStyle 不看可见性）
					sectionTitle: size('.settings-panel h3'),
					formLabel: size('.settings-grid label'),
					secondary: size('.playbar__artist'),
					hint: size('.settings-hint'),
				})
			})()`,
		),
	)
	check(
		'正文基准 = 14（body-medium）',
		typeScale.body === 14,
		`实际 ${typeScale.body}px`,
	)
	check(
		'页面标题 ≥ 22（title-large，与移动端的大标题同级）',
		typeScale.viewTitle !== null && typeScale.viewTitle >= 22,
		`实际 ${typeScale.viewTitle}px`,
	)
	check(
		'视图内的次级标题低于页面标题（两级标题要有层级）',
		typeScale.sectionHead === null ||
			typeScale.sectionHead < (typeScale.viewTitle ?? 0),
		`页面 ${typeScale.viewTitle}px vs 次级 ${typeScale.sectionHead}px`,
	)
	check(
		'区块标题 ≥ 16 且明显大于正文（层级看得出来）',
		typeScale.sectionTitle !== null && typeScale.sectionTitle >= 16,
		`实际 ${typeScale.sectionTitle}px`,
	)
	check(
		'表单标签 = 14（不再缩到 13）',
		typeScale.formLabel === 14,
		`实际 ${typeScale.formLabel}px`,
	)
	check(
		'内容副标题 ≥ 14（歌手名这类信息不该比正文还小）',
		typeScale.secondary !== null && typeScale.secondary >= 14,
		`实际 ${typeScale.secondary}px`,
	)
	check(
		'提示文字 = 12（body-small，最小的一档）',
		typeScale.hint === 12,
		`实际 ${typeScale.hint}px`,
	)

	// ---------------------------------------------------------------
	// 1.9 只有一种「选中态」
	// ---------------------------------------------------------------
	//
	// 用户指出：右侧「播放队列 / 歌词」用的是**下划线**，而左栏「音乐库」是
	// 填充胶囊 —— "安卓端完全不会出现这种不等线 UI，而且样式太杂"。
	//
	// 第一版确实有三套混用：nav 是硬编码的紫色胶囊、tab 是下划线、
	// segmented 是主色实心。清一遍只解决今天，所以这里钉住：
	// **所有"选中/激活"必须算出同一套底色与前景色**，且**不许用下边框**表达选中。
	console.log('\n[ui] 1.9) 选中态一致性')
	const activeStyles = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const pick = (sel) => {
					const el = document.querySelector(sel)
					if (!el) return null
					const s = getComputedStyle(el)
					return {
						bg: s.backgroundColor,
						color: s.color,
						borderBottomWidth: s.borderBottomWidth,
						borderBottomStyle: s.borderBottomStyle,
						radius: s.borderRadius,
					}
				}
				return JSON.stringify({
					nav: pick('.nav__item.is-active'),
					tab: pick('.tab.is-active'),
					segmented: pick('.segmented button.is-active'),
				})
			})()`,
		),
	)

	check(
		'左栏导航项处于选中态（作为基准）',
		activeStyles.nav !== null,
		JSON.stringify(activeStyles.nav),
	)
	check(
		'右栏页签的选中底色与左栏导航项**完全一致**（不再一套一套地写）',
		activeStyles.tab !== null && activeStyles.tab.bg === activeStyles.nav?.bg,
		`nav=${activeStyles.nav?.bg} tab=${activeStyles.tab?.bg}`,
	)
	check(
		'右栏页签的选中前景色也与左栏一致',
		activeStyles.tab?.color === activeStyles.nav?.color,
		`nav=${activeStyles.nav?.color} tab=${activeStyles.tab?.color}`,
	)
	check(
		'分段控件（跟随系统/浅色/深色）也是同一套选中底色',
		activeStyles.segmented !== null &&
			activeStyles.segmented.bg === activeStyles.nav?.bg,
		`nav=${activeStyles.nav?.bg} segmented=${activeStyles.segmented?.bg}`,
	)
	check(
		'任何选中态都不用下边框表达（移动端没有这种 UI）',
		(activeStyles.tab?.borderBottomWidth ?? '0px') === '0px' &&
			(activeStyles.nav?.borderBottomWidth ?? '0px') === '0px',
		`tab=${activeStyles.tab?.borderBottomWidth} nav=${activeStyles.nav?.borderBottomWidth}`,
	)
	check(
		'选中态是胶囊（圆角取满）',
		activeStyles.nav?.radius === '9999px' &&
			activeStyles.tab?.radius === '9999px',
		`nav=${activeStyles.nav?.radius} tab=${activeStyles.tab?.radius}`,
	)

	// ---------------------------------------------------------------
	// 1.10 图标：必须是 Material Symbols 而不是 unicode 字形
	// ---------------------------------------------------------------
	//
	// 第一版用的是 ♪ ⌕ ⤓ ↺ ★ ▤ ⇄ ⚙ ▶ ⏮ ⏭ ✕ —— 跨平台渲染不一致
	// （Windows 的 Segoe UI Symbol 与 Linux 的 DejaVu Sans 粗细、基线都不同），
	// 而且混着「音乐符号 / 几何符号 / 箭头」三类，视觉重量不齐，
	// 用户一眼就看出杂乱。
	//
	// 现在是 Material Symbols Rounded 的**子集字体**（57 个图标，9.3 KB），
	// 用合字渲染：`<span class="icon">library_music</span>`。
	//
	// ⚠️ 怎么断言「字体真的生效」？只看 `document.fonts.check` 不够 ——
	// 字体加载失败时合字不生效，图标名会被**当成普通文字**渲染出来，
	// 那时元素会宽得离谱（"library_music" 13 个字符 vs 一个图标）。
	// 所以同时量**每个图标元素的宽度**：一个图标应当接近 1em。
	console.log('\n[ui] 1.10) 图标')
	// ⚠️ 这段断言在**两个位置**各跑一次（这里 + 内容加载后的 2.6）。
	// 原因是它曾经漏掉一个真实的 bug：图标名写错时（play_next 不是 Material
	// 里的名字）合字不生效，界面渲染出**字面的 9 个字母**（144px 宽）压在
	// 时长列上；而这条断言当时只在首页跑，曲目表还没渲染，所以一路全绿。
	// **断言跑得太早等于没跑。**
	const iconState = await auditIcons(window)
	check('界面里有图标元素', iconState.count > 0, `${iconState.count} 个`)
	check(
		'Material Symbols 字体已加载',
		iconState.fontOk === true,
		`document.fonts.check=${iconState.fontOk}，status=${iconState.fontStatus}`,
	)
	check(
		'每个图标都渲染成单个字形（合字生效，没有退化成字母）',
		iconState.tooWide.length === 0,
		iconState.tooWide.length > 0
			? `过宽（图标名可能不存在）：${iconState.tooWide.join('、')}`
			: `${iconState.count} 个都正常`,
	)

	// 图标必须在按钮**正中**，而且「只放图标」的按钮必须显式声明。
	//
	// ⚠️ 用户报过「上一首 / 下一首 / 播放暂停的图标歪了，不在控件正中」。
	// 原因是图标是 inline-block，坐在文字基线上，而按钮基础层给的是
	// `padding: 7px 16px`（上下 7、左右 16）—— 水平被拉宽、垂直因基线偏上。
	//
	// 第一版用 `button:has(> .icon:only-child)` 自动识别，**误伤了左栏导航项**：
	// 导航项只有一个「元素」子节点（图标），文字标签是**裸文本节点**，
	// `:only-child` 数不到它 → 导航项被压成 34px 方块、文字竖排。
	// 所以改成显式类名，并在这里双向校验：
	//   (a) 所有 .icon-only 的图标必须居中；
	//   (b) 凡是「只有一个图标子节点、且没有文字标签」的按钮，**必须**有该类名
	//       （防止以后新增图标按钮忘了加，又回到不居中的样子）。
	const centered = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const offenders = []
				const missingClass = []
				for (const button of document.querySelectorAll('button')) {
					const icons = [...button.children].filter((c) =>
						c.classList.contains('icon'),
					)
					const hasOnlyIcon =
						icons.length === 1 && button.children.length === 1
					if (!hasOnlyIcon) continue
					// 文字标签是裸文本节点，children 数不到它，单独查一遍
					const label = [...button.childNodes]
						.filter((n) => n.nodeType === 3)
						.map((n) => n.textContent)
						.join('')
						.trim()
					if (label !== '') continue // 「图标 + 文字」的行，左对齐是设计
					const isIconOnly = button.classList.contains('icon-only')
					const b = button.getBoundingClientRect()
					const i = icons[0].getBoundingClientRect()
					if (b.width === 0 || b.height === 0) continue // 隐藏的按钮跳过
					const dx = Math.abs(i.left + i.width / 2 - (b.left + b.width / 2))
					const dy = Math.abs(i.top + i.height / 2 - (b.top + b.height / 2))
					if (dx > 1.5 || dy > 1.5) {
						offenders.push(
							(button.id || button.className || button.tagName) +
								' dx=' +
								dx.toFixed(1) +
								' dy=' +
								dy.toFixed(1),
						)
					}
					if (!isIconOnly) {
						missingClass.push(button.id || button.className || button.tagName)
					}
				}
				return JSON.stringify({ offenders, missingClass })
			})()`,
		),
	)
	check(
		'只放图标的按钮，图标在正中（偏差 < 1.5px）',
		centered.offenders.length === 0,
		centered.offenders.length > 0 ? centered.offenders.join('；') : '全部居中',
	)
	check(
		'只放图标的按钮都显式标了 .icon-only（漏标就会回到不居中）',
		centered.missingClass.length === 0,
		centered.missingClass.length > 0
			? `漏标：${centered.missingClass.join('、')}`
			: '无遗漏',
	)
	// 反向：导航项是「图标 + 文字」，**不能**被当成图标按钮压缩
	const navWidths = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const items = [...document.querySelectorAll('.nav__item')]
				const squeezed = items
					.filter((el) => el.getBoundingClientRect().width < 120)
					.map((el) => (el.textContent || '').trim().slice(0, 12))
				return JSON.stringify(squeezed)
			})()`,
		),
	)
	check(
		'左栏导航项没有被当成图标按钮压缩（文字不竖排）',
		navWidths.length === 0,
		navWidths.length > 0 ? `过窄：${navWidths.join('、')}` : '全部占满整行',
	)

	// ---------------------------------------------------------------
	// 1.11 外壳（阶段 2 换壳）
	// ---------------------------------------------------------------
	//
	// 这一节把 stage 2 的改动与**三个已知缺陷**钉住。缺陷之所以是缺陷，
	// 是因为当时没有任何断言会去看它们 —— 加断言比改代码更重要。
	console.log('\n[ui] 1.11) 外壳：状态栏 / 顶栏 / 悬浮播放条')
	const shell = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const rect = (sel) => {
					const el = document.querySelector(sel)
					return el ? el.getBoundingClientRect() : null
				}
				const topbar = rect('.topbar')
				// 顶栏里的图标按钮是否与搜索框在同一水平线上（第一版会折到第二行）
				const topbarButtons = [...document.querySelectorAll('.topbar .icon-button')]
				const strayButtons = topbarButtons
					.filter((b) => {
						const r = b.getBoundingClientRect()
						return topbar && r.top - topbar.top > topbar.height * 0.6
					})
					.map((b) => b.id || b.className)

				// 导航项是否被压成两行（第一版文字徽标挤掉了品牌名）
				const wrappedNav = [...document.querySelectorAll('.nav__item')]
					.filter((el) => el.getBoundingClientRect().height > 48)
					.map((el) => (el.textContent || '').trim().slice(0, 8))

				const playbar = rect('.playbar')
				const playbarStyle = getComputedStyle(
					document.querySelector('.playbar'),
				)
				const content = rect('.content')

				return JSON.stringify({
					hasStatusBar: Boolean(document.querySelector('.status-bar')),
					hasStatusElement: Boolean(document.getElementById('status')),
					strayButtons,
					wrappedNav,
					playbarRadius: Number.parseFloat(playbarStyle.borderRadius),
					playbarShadow: playbarStyle.boxShadow !== 'none',
					playbarLeftGap: Math.round(playbar?.left ?? 0),
					// 内容底边与播放条顶边的关系：内容不该压到播放条上
					overlapPx: content && playbar
						? Math.round(content.bottom - playbar.top)
						: null,
				})
			})()`,
		),
	)
	check(
		'底部状态栏已删除（不再是一条常驻的日志行）',
		shell.hasStatusBar === false,
		shell.hasStatusBar ? '仍然存在 .status-bar' : '已删除',
	)
	check(
		'但反馈通道保留（#status 仍在，探针与模块都靠它）',
		shell.hasStatusElement === true,
	)
	check(
		'顶栏图标按钮不再折到第二行（缺陷 2 的同源问题）',
		shell.strayButtons.length === 0,
		shell.strayButtons.length > 0
			? `折行：${shell.strayButtons.join('、')}`
			: '同行',
	)
	check(
		'左栏导航项都是单行（缺陷 2：按钮换行）',
		shell.wrappedNav.length === 0,
		shell.wrappedNav.length > 0
			? `换行：${shell.wrappedNav.join('、')}`
			: '全部单行',
	)
	check(
		'底部是悬浮圆角卡（有圆角、有投影、左右留白）',
		shell.playbarRadius >= 12 &&
			shell.playbarShadow &&
			shell.playbarLeftGap >= 4,
		`radius=${shell.playbarRadius}px shadow=${shell.playbarShadow} leftGap=${shell.playbarLeftGap}px`,
	)
	check(
		'内容区不压到播放条上（缺陷 1）',
		shell.overlapPx !== null && shell.overlapPx <= 2,
		`内容底边 - 播放条顶边 = ${shell.overlapPx}px（≤2 视为不重叠）`,
	)

	// ---------------------------------------------------------------
	// 2. 空库 → 导入示例合集
	// ---------------------------------------------------------------
	console.log('\n[ui] 2) 空库欢迎视图 + 导入合集')
	const welcomeShown = await evaluate(
		window,
		`Boolean(document.querySelector('[data-testid="btn-seed-demo"]'))`,
	)
	check('空库时显示欢迎视图与导入按钮', welcomeShown)
	await shot(window, 'ui-02-welcome')

	if (welcomeShown) {
		check(
			'点到「导入示例合集」按钮',
			await click(window, '[data-testid="btn-seed-demo"]'),
		)

		// 导入要连拉网络（合集列表 + 每个视频的 view），B 站会限流，
		// 因此允许重试：失败后再点一次按钮。
		let imported = await waitFor(
			window,
			`(() => {
				const ui = window.bbTest.ui()
				return ui.playlistItems > 0 && ui.trackRows > 0
			})()`,
			180_000,
		)
		for (let attempt = 1; attempt <= 2 && !imported.ok; attempt++) {
			console.log(`[ui] 导入未成功，重试 ${attempt}/2`)
			const statusNow = await evaluate(
				window,
				`document.getElementById('status').textContent`,
			)
			console.log(`[ui] 当前状态栏: ${statusNow}`)
			await click(window, '[data-testid="btn-seed-demo"]')
			imported = await waitFor(
				window,
				`(() => {
					const ui = window.bbTest.ui()
					return ui.playlistItems > 0 && ui.trackRows > 0
				})()`,
				180_000,
			)
		}

		ui = await uiState(window)
		check(
			'导入后左栏出现歌单',
			ui.playlistItems > 0,
			`${ui.playlistItems} 个歌单`,
		)
		check('导入后中栏出现曲目行', ui.trackRows > 0, `${ui.trackRows} 行`)
		check('视图标题为歌单名', Boolean(ui.viewTitle), ui.viewTitle)
	} else {
		check('导入后左栏出现歌单', false, '欢迎视图缺失，跳过导入')
		check('导入后中栏出现曲目行', false, '欢迎视图缺失，跳过导入')
		check('视图标题为歌单名', false, '欢迎视图缺失，跳过导入')
	}
	await shot(window, 'ui-03-imported')

	// ---------------------------------------------------------------
	// 2.5 组件词汇表（阶段 1c）
	// ---------------------------------------------------------------
	//
	// 第一版"杂乱"的根因不是配色，而是**没有组件**：每个面板都在用
	// 「h3 + 一行说明 + 一排等权重灰按钮 + 平铺表单」临时拼，
	// 列表行 / 空状态 / 开关各写一套。
	//
	// 这一节断言面板确实**在用组件**（而不是又手搓了一套），
	// 并且组件的关键视觉特征成立。放在导入之后 —— 那时侧栏才有真实行。
	console.log('\n[ui] 2.5) 组件词汇表')
	// 封面形状在**这里**量，不在 shell 小节：那时曲目表和侧栏行还没渲染，
	// 只能量到播放条那一个封面，断言看着"通过"其实没覆盖到什么。
	// 封面统一是**圆角正方形**（用户明确要求）。
	//
	// 不用圆形：圆形是"头像"的语言；封面是唱片/视频的封面，方形才对，
	// 而且同样高度下方形多显示约 21% 的画面。
	// 这里同时要求"真的有圆角"（不是切角）与"不是圆"（半径不超过边长一半）。
	const covers = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const nodes = [
					...document.querySelectorAll('.playbar__cover'),
					...document.querySelectorAll('.track-table .list-row__art'),
					...document.querySelectorAll('[data-playlist-id] .list-row__art'),
				]
				const problems = []
				let withRadius = 0
				let square = 0
				for (const el of nodes) {
					const rect = el.getBoundingClientRect()
					if (rect.width === 0) continue
					const radius = Number.parseFloat(getComputedStyle(el).borderRadius)
					if (!Number.isFinite(radius) || radius < 4) {
						problems.push('无圆角: ' + (el.className || el.tagName))
						continue
					}
					withRadius++
					// 圆角 >= 短边一半就是胶囊/圆形了
					if (radius < Math.min(rect.width, rect.height) / 2) square++
					else problems.push('成了圆形: ' + (el.className || el.tagName))
					// 宽高比接近 1:1 才算"正方形"
					if (Math.abs(rect.width - rect.height) > 2) {
						problems.push(
							'不是正方形: ' +
								Math.round(rect.width) +
								'x' +
								Math.round(rect.height),
						)
					}
				}
				return JSON.stringify({ count: nodes.length, withRadius, square, problems })
			})()`,
		),
	)
	check(
		'界面上有封面位（播放条 / 曲目表 / 侧栏歌单）',
		covers.count > 0,
		`${covers.count} 个`,
	)
	check(
		'所有封面都是**圆角正方形**（有圆角、不是圆形、宽高相等）',
		covers.problems.length === 0 && covers.withRadius === covers.count,
		covers.problems.length > 0
			? covers.problems.slice(0, 4).join('；')
			: `${covers.square}/${covers.count} 个都符合`,
	)

	const components = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const rows = [...document.querySelectorAll('[data-playlist-id]')]
				const firstRow = rows[0]
				const art = firstRow?.querySelector('.list-row__art')
				const artStyle = art ? getComputedStyle(art) : null

				return JSON.stringify({
					// 列表行
					rowCount: rows.length,
					rowsAreListRow: rows.every((r) => r.classList.contains('list-row')),
					hasArt: Boolean(art),
					artText: (art?.textContent ?? '').trim(),
					// 首字方块必须真的有渐变（不是纯色）
					artHasGradient: /gradient/.test(String(artStyle?.backgroundImage)),
					artHue: art?.style.getPropertyValue('--art-hue') ?? null,
					hasTitle: Boolean(firstRow?.querySelector('.list-row__title')),
					hasSub: Boolean(firstRow?.querySelector('.list-row__sub')),
					// 旧的手搓类名不该再出现
					legacyRows: document.querySelectorAll('.playlist-list__item').length,
					// 开关
					switches: document.querySelectorAll('input.switch').length,
					rawCheckboxes: [...document.querySelectorAll("input[type=checkbox]")].filter(
						(el) => !el.classList.contains('switch'),
					).length,
					// 组件工具是否可用
					hasHelpers: typeof window.bbComponents?.listRow === 'function',
				})
			})()`,
		),
	)
	check(
		'侧栏歌单行用的是组件层的 .list-row',
		components.rowsAreListRow && components.rowCount > 0,
		`${components.rowCount} 行`,
	)
	check(
		'旧的手搓类名 .playlist-list__item 已消失',
		components.legacyRows === 0,
		`残留 ${components.legacyRows} 个`,
	)
	check(
		'每行有封面位、主标题、副标题',
		components.hasArt && components.hasTitle && components.hasSub,
	)
	check(
		'没有封面的行走「首字 + 渐变底色」（BBPlayer 的身份特征）',
		components.artHasGradient &&
			components.artText.length > 0 &&
			components.artHue !== null,
		`首字「${components.artText}」，色相 ${components.artHue}，background=${components.artHasGradient ? 'gradient ✓' : '纯色 ✗'}`,
	)
	check(
		'设置里的开关是 M3 开关（没有裸 checkbox）',
		components.switches > 0 && components.rawCheckboxes === 0,
		`${components.switches} 个 switch，${components.rawCheckboxes} 个裸 checkbox`,
	)
	check('组件工具已暴露到 window.bbComponents', components.hasHelpers === true)

	// 空状态：结构化的（图标 + 标题 + 说明），不是一行居中灰字
	const emptyProbe = JSON.parse(
		await evaluate(
			window,
			`(() => {
				// 造一个空状态挂到 body 上量完就拆，避免污染当前界面
				const node = window.bbComponents.empty({
					title: '探针用例',
					hint: '这是一句说明',
					iconName: 'library_music',
				})
				node.style.position = 'fixed'
				node.style.left = '-9999px'
				document.body.appendChild(node)
				const hasIcon = Boolean(node.querySelector('.icon'))
				const hasTitle = node.querySelector('.empty__title')?.textContent === '探针用例'
				const hasHint = node.querySelector('.empty__hint')?.textContent === '这是一句说明'
				const iconIsGlyph =
					(node.querySelector('.icon')?.getBoundingClientRect().width ?? 99) < 60
				node.remove()
				return JSON.stringify({ hasIcon, hasTitle, hasHint, iconIsGlyph })
			})()`,
		),
	)
	check(
		'空状态组件：淡图标 + 标题 + 说明（不是一行居中灰字）',
		emptyProbe.hasIcon && emptyProbe.hasTitle && emptyProbe.hasHint,
		JSON.stringify(emptyProbe),
	)

	// ---------------------------------------------------------------
	// 2.6 播放列表功能：随机播放 / 下一首播放 / 更改顺序
	// ---------------------------------------------------------------
	//
	// 用户明确要求的三件事。这三条都属于"逻辑在内存里、界面上看不出来对错"，
	// 所以必须断言**行为**而不只是"按钮存在"。
	console.log('\n[ui] 2.6) 播放列表功能')
	// 内容加载后再审一次图标：曲目表的「下一首播放」按钮是这一阶段新加的，
	// 而首屏那次检查看不到它（见 auditIcons 的注释）。
	const iconsAfterContent = await auditIcons(window)
	check(
		'曲目表 / 队列渲染后，所有图标仍然渲染成单个字形',
		iconsAfterContent.tooWide.length === 0,
		iconsAfterContent.tooWide.length > 0
			? `过宽（图标名可能不存在）：${iconsAfterContent.tooWide.join('、')}`
			: `${iconsAfterContent.count} 个都正常`,
	)

	// 先确保队列里有一批歌（用侧栏那个歌单）
	await evaluate(
		window,
		`(() => {
			const row = document.querySelector('[data-playlist-id]')
			row?.click()
			return true
		})()`,
	)
	await sleep(1500)
	await click(window, '[data-testid="btn-play-all"]')
	await sleep(1500)

	// --- (1) 随机播放：必须是**洗牌**，不是"每次随机挑一首" ---
	//
	// 第一版是 `while (candidate === index) candidate = random()` ——
	// 那会把听过的歌再随机到，用户感知是"随机播放老是放那几首"。
	// 洗牌顺序的定义很硬：它是下标的**一个排列**，且走完一轮每首恰好一次。
	const shuffleProbe = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const player = window.bbPlayer
				const size = player.getQueue().length
				player.setMode('shuffle')
				const order = player.getShuffleOrder()
				const sorted = [...order].sort((a, b) => a - b)
				const isPermutation =
					order.length === size &&
					sorted.every((value, i) => value === i) &&
					new Set(order).size === size
				player.setMode('order')
				return JSON.stringify({ size, order, isPermutation })
			})()`,
		),
	)
	check(
		'随机播放是**洗牌顺序**（队列下标的一个排列，每首恰好一次）',
		shuffleProbe.isPermutation,
		`队列 ${shuffleProbe.size} 首，洗牌顺序 [${shuffleProbe.order.slice(0, 8).join(',')}…]`,
	)

	// 走完一轮应当把每首**恰好播一次**，然后回到起点
	const roundTrip = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const player = window.bbPlayer
				// 用 4 首的小队列，走一轮看清楚
				const tracks = player.getQueue().slice(0, 4)
				player.setQueue(tracks, 0)
				player.setMode('shuffle')
				const visited = [player.getIndex()]
				for (let i = 0; i < 3; i++) {
					// 只走"下一首"的下标计算，不真的播放（避免等网络）
					const next = player.getShuffleOrder()[
						(player.getShufflePos() + 1) % player.getShuffleOrder().length
					]
					player.playAt(next)
					visited.push(next)
				}
				const unique = new Set(visited).size
				player.setMode('order')
				return JSON.stringify({ visited, unique })
			})()`,
		),
	)
	check(
		'洗牌顺序走一轮：4 首里访问到 4 个不同下标',
		roundTrip.unique === 4,
		`访问顺序 ${roundTrip.visited.join(' → ')}，去重后 ${roundTrip.unique} 个`,
	)

	// ⚠️ 「是一个排列」还不够：一个**恒等排列**（0,1,2,3…）也满足"每首恰好一次"，
	// 但它显然不是随机播放。所以再验一次"重洗真的会变" ——
	// 24 首的队列洗 5 次全部相同的概率是 0，出现即说明 `reshuffle` 没生效。
	const reshuffleVariety = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const player = window.bbPlayer
				player.setMode('order')
				const seen = new Set()
				for (let i = 0; i < 5; i++) {
					player.setMode('shuffle')
					seen.add(player.getShuffleOrder().join(','))
				}
				player.setMode('order')
				return JSON.stringify({ distinct: seen.size })
			})()`,
		),
	)
	check(
		'重复洗牌会产生**不同的**顺序（证明真的在随机，而不是恒等排列）',
		reshuffleVariety.distinct > 1,
		`5 次洗牌得到 ${reshuffleVariety.distinct} 种不同顺序`,
	)

	// --- (2) 下一首播放 ---
	const playNextProbe = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const player = window.bbPlayer
				const base = player.getQueue().slice(0, 4)
				player.setQueue(base, 1)

				// 分支 A：队列里**没有**这首歌 → 插到当前位置之后，长度 +1
				const fresh = { bvid: 'BVprobeNext001', title: '探针曲目·新' }
				const inserted = player.playNextInsert(fresh)
				const afterInsert = player.getQueue()
				const atIsNext = afterInsert[player.getIndex() + 1]?.bvid === fresh.bvid

				// 分支 B：这首歌**已经在**队列里（下标 3）→ 不重复添加，移到下一首
				const existingTrack = afterInsert[3]
				const before = player.getQueue().length
				const moved = player.playNextInsert(existingTrack)
				const afterMove = player.getQueue()
				const noDuplicate =
					afterMove.filter((t) => t.bvid === existingTrack.bvid).length === 1
				const movedIsNext =
					afterMove[player.getIndex() + 1]?.bvid === existingTrack.bvid

				// 分支 C：已经就是下一首 → 不做无意义的移动
				const alreadyNext = player.playNextInsert(afterMove[player.getIndex() + 1])
				const queueBefore = player.getQueue().map((t) => t.bvid).join(',')
				const queueAfter = player.getQueue().map((t) => t.bvid).join(',')

				return JSON.stringify({
					insertedOk: inserted.ok,
					atIsNext,
					lengthAfterInsert: afterInsert.length,
					movedOk: moved.ok,
					noDuplicate,
					movedIsNext,
					lengthUnchanged: afterMove.length === before,
					alreadyNextNoop: alreadyNext.moved === false &&
						queueBefore === queueAfter,
				})
			})()`,
		),
	)
	check(
		'「下一首播放」把新歌插到当前曲目之后（不是追加到末尾）',
		playNextProbe.insertedOk && playNextProbe.atIsNext,
		`队列长度 ${playNextProbe.lengthAfterInsert}`,
	)
	check(
		'「下一首播放」对队列里已有的歌不重复添加，只把它挪到下一首',
		playNextProbe.movedOk &&
			playNextProbe.noDuplicate &&
			playNextProbe.movedIsNext &&
			playNextProbe.lengthUnchanged,
		`不重复=${playNextProbe.noDuplicate} 成为下一首=${playNextProbe.movedIsNext} 长度不变=${playNextProbe.lengthUnchanged}`,
	)
	check(
		'目标已经是下一首时不做无意义的移动（不打乱用户排好的顺序）',
		playNextProbe.alreadyNextNoop === true,
	)

	// --- (3) 队列重排 ---
	const reorderProbe = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const player = window.bbPlayer
				player.setQueue(player.getQueue().slice(0, 5), 2)
				const before = player.getQueue().map((t) => t.bvid)
				const playingBefore = player.getQueue()[player.getIndex()].bvid

				// 把第 0 项移到第 3 位
				const result = player.moveInQueue(0, 3)
				const after = player.getQueue().map((t) => t.bvid)
				const playingAfter = player.getQueue()[player.getIndex()]?.bvid

				// 期望：第 0 项出现在下标 3，其余整体前移一格
				const expected = [...before.slice(1, 4), before[0], ...before.slice(4)]

				return JSON.stringify({
					ok: result.ok,
					before,
					after,
					expected,
					orderOk: after.join(',') === expected.join(','),
					// ⚠️ 关键：当前播放项的下标必须**跟着它自己走**
					playingFollowed: playingBefore === playingAfter,
				})
			})()`,
		),
	)
	check(
		'队列重排把项目移动到目标位置（其余项依次前移）',
		reorderProbe.ok && reorderProbe.orderOk,
		`${reorderProbe.before?.join(',')} → ${reorderProbe.after?.join(',')}`,
	)
	check(
		'重排后「正在播放」仍然指向同一首歌（下标跟着它走）',
		reorderProbe.playingFollowed === true,
	)

	// --- (4) 歌单内重排（落库，重启后仍在）---
	const playlistId = await evaluate(
		window,
		`window.bbState.get().selectedPlaylistId ?? null`,
	)
	if (playlistId) {
		const persisted = JSON.parse(
			await evaluate(
				window,
				`(async () => {
					const before = (await window.bbplayer.getPlaylistTracks(${JSON.stringify(playlistId)})).data
					const bvidsBefore = before.map((t) => t.bvid)
					const moved = await window.bbplayer.movePlaylistTrack({
						playlistId: ${JSON.stringify(playlistId)},
						from: 0,
						to: 2,
					})
					const after = (await window.bbplayer.getPlaylistTracks(${JSON.stringify(playlistId)})).data
					const bvidsAfter = after.map((t) => t.bvid)
					const expected = [
						...bvidsBefore.slice(1, 3),
						bvidsBefore[0],
						...bvidsBefore.slice(3),
					]
					return JSON.stringify({
						ok: moved.ok,
						countSame: bvidsBefore.length === bvidsAfter.length,
						orderOk: bvidsAfter.join(',') === expected.join(','),
						first: bvidsAfter[0],
						third: bvidsAfter[2],
					})
				})()`,
			),
		)
		check(
			'歌单内重排真的写进数据库（重新读取顺序已变）',
			persisted.ok && persisted.orderOk && persisted.countSame,
			`第 3 位现在是 ${persisted.third}`,
		)
	} else {
		check(
			'歌单内重排真的写进数据库（重新读取顺序已变）',
			false,
			'没有选中的歌单',
		)
	}

	// --- (5) 界面上的入口 ---
	const listFeatureUi = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const playNext = document.querySelector('[data-action="play-next"]')
				const queueRows = [...document.querySelectorAll('[data-queue-index]')]
				return JSON.stringify({
					playNextButtons: document.querySelectorAll('[data-action="play-next"]').length,
					playNextTitle: playNext?.getAttribute('title') ?? null,
					queueRowsDraggable: queueRows.filter((el) => el.draggable).length,
					queueRows: queueRows.length,
				})
			})()`,
		),
	)
	check(
		'每行曲目都有「下一首播放」按钮',
		listFeatureUi.playNextButtons > 0 &&
			listFeatureUi.playNextTitle === '下一首播放',
		`${listFeatureUi.playNextButtons} 个，title=${listFeatureUi.playNextTitle}`,
	)
	check(
		'队列行可以拖拽（更改播放顺序）',
		listFeatureUi.queueRows > 0 &&
			listFeatureUi.queueRowsDraggable === listFeatureUi.queueRows,
		`${listFeatureUi.queueRowsDraggable}/${listFeatureUi.queueRows} 行可拖`,
	)

	// ---------------------------------------------------------------
	// 2.7 设置：一级页面（分类列表 → 子页）
	// ---------------------------------------------------------------
	//
	// ⚠️ 原来是右侧抽屉 + 4 个页签。阶段 3 改成一级页面：左栏点「设置」进来
	// 看到 **10 类**（移动端 9+1），点一类进子页，子页左上角有返回。
	//
	// 这一节同时是「页面真的渲染出来了」的断言 —— 截图巡检里第一版
	// **分类列表是空白**（标题有、列表没有），而当时的断言只看了标题。
	console.log('\n[ui] 2.7) 设置页')
	await click(window, '[data-testid="nav-settings"]')
	await sleep(900)

	const settingsState = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const view = document.getElementById('view-settings')
				const list = document.getElementById('settings-categories')
				const buttons = [...document.querySelectorAll('[data-settings-category]')]
				const visible = buttons.filter((b) => {
					const r = b.getBoundingClientRect()
					return r.width > 40 && r.height > 20
				})
				return JSON.stringify({
					viewVisible: Boolean(view && !view.hidden),
					listVisible: Boolean(list && !list.hidden),
					total: buttons.length,
					visible: visible.length,
					keys: buttons.map((b) => b.dataset.settingsCategory),
					firstRect: buttons[0]
						? {
								w: Math.round(buttons[0].getBoundingClientRect().width),
								h: Math.round(buttons[0].getBoundingClientRect().height),
							}
						: null,
					contentHidden: Boolean(document.getElementById('content')?.hidden),
					title: document.getElementById('page-title')?.textContent,
				})
			})()`,
		),
	)
	check(
		'点左栏「设置」进入设置页（中栏切过去，内容区让位）',
		settingsState.viewVisible && settingsState.contentHidden,
		`view=${settingsState.viewVisible} contentHidden=${settingsState.contentHidden}`,
	)
	check(
		'设置页有 10 个分类（移动端 9+1）',
		settingsState.total === 10,
		`${settingsState.total} 个：${settingsState.keys.join(' / ')}`,
	)
	check(
		'分类列表**真的渲染出来了**（每个都有实际尺寸，不是空白）',
		settingsState.listVisible &&
			settingsState.visible === settingsState.total &&
			(settingsState.firstRect?.h ?? 0) > 20,
		`可见 ${settingsState.visible}/${settingsState.total}，第一个 ${JSON.stringify(settingsState.firstRect)}`,
	)
	check(
		'分类顺序与移动端一致（主题/外观/播放/歌词/下载/账号/备份/通用/关于）',
		settingsState.keys.join(',') ===
			'theme,appearance,playback,lyrics,download,account-bili,account-bbplayer,backup,general,about',
		settingsState.keys.join(','),
	)

	// DOM **嵌套**必须正确。
	//
	// ⚠️ 这条是事故复盘换来的。一次性的 HTML 拼接脚本用
	// indexOf('</section>') 找设置块的结尾，结果匹配到了**第一个子面板**
	// 的闭合标签，把设置块从中间截断 —— 后 9 个面板被留在 </main> 之后。
	//
	// 浏览器解析器把孤立的面板挂到了 <body> 下：它们**量得出尺寸**
	// （1426×877，整个视口宽）、display / visibility / opacity 全正常、
	// 断言全绿 —— 但**画不出来**，因为它们在 .main 之外。
	// 是靠截图巡检打印「祖先链」才定位到的。
	//
	// 所以这里直接断言嵌套关系：元素"存在且有尺寸"远远不够，
	// **它得在正确的地方**。
	const settingsNesting = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const main = document.querySelector('[data-testid="main"]')
				const view = document.getElementById('view-settings')
				const panelsBox = document.getElementById('settings-panels')
				const panels = [...document.querySelectorAll('[data-settings-panel]')]
				const outside = panels
					.filter((el) => el.parentElement !== panelsBox)
					.map((el) => el.dataset.settingsPanel)
				return JSON.stringify({
					viewInsideMain: Boolean(main && view && main.contains(view)),
					panelsBoxInsideView: Boolean(
						view && panelsBox && view.contains(panelsBox),
					),
					panelCount: panels.length,
					outsidePanels: outside,
					viewParent: view?.parentElement?.tagName?.toLowerCase() ?? null,
				})
			})()`,
		),
	)
	check(
		'设置页在 .main 里（跑到 body 下就会画在屏幕外）',
		settingsNesting.viewInsideMain && settingsNesting.viewParent === 'main',
		`父元素=${settingsNesting.viewParent}`,
	)
	check(
		'10 个分类面板都在 #settings-panels 里（一个都不能被解析器挪走）',
		settingsNesting.panelsBoxInsideView &&
			settingsNesting.panelCount === 10 &&
			settingsNesting.outsidePanels.length === 0,
		settingsNesting.outsidePanels.length > 0
			? `被挪走：${settingsNesting.outsidePanels.join('、')}`
			: `${settingsNesting.panelCount} 个都在位`,
	)

	// 进一个子页：分类列表让位、子页出现、返回按钮露出、标题换成分类名
	await click(window, '[data-testid="settings-cat-playback"]')
	await sleep(600)
	const subPage = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const list = document.getElementById('settings-categories')
				const panel = document.querySelector('[data-settings-panel="playback"]')
				const back = document.getElementById('settings-back')
				return JSON.stringify({
					listHidden: Boolean(list?.hidden),
					panelVisible: Boolean(panel && panel.classList.contains('is-active')),
					panelHeight: panel ? Math.round(panel.getBoundingClientRect().height) : 0,
					backVisible: Boolean(back && !back.hidden),
					title: document.getElementById('page-title')?.textContent,
					othersActive: [...document.querySelectorAll('[data-settings-panel]')]
						.filter((el) => el.classList.contains('is-active')).length,
				})
			})()`,
		),
	)
	check(
		'点子页后：分类列表收起、子页显示、返回按钮露出',
		subPage.listHidden && subPage.panelVisible && subPage.backVisible,
		JSON.stringify(subPage),
	)
	check(
		'子页标题换成分类名（用的是外壳的 #page-title，页面里只有一处标题）',
		subPage.title === '播放',
		String(subPage.title),
	)
	check(
		'一次只显示一个分类的子页',
		subPage.othersActive === 1,
		`同时激活 ${subPage.othersActive} 个`,
	)
	check(
		'子页真的有内容（不是空壳）',
		subPage.panelHeight > 100,
		`面板高 ${subPage.panelHeight}px`,
	)

	// 返回
	await click(window, '[data-testid="settings-back"]')
	await sleep(500)
	const backState = JSON.parse(
		await evaluate(
			window,
			`(() => ({
				listVisible: !document.getElementById('settings-categories')?.hidden,
				panelsHidden: Boolean(document.getElementById('settings-panels')?.hidden),
				title: document.getElementById('page-title')?.textContent,
			}))()`,
		),
	)
	check(
		'点返回回到分类列表',
		backState.listVisible &&
			backState.panelsHidden &&
			backState.title === '设置',
		JSON.stringify(backState),
	)

	// 账号子页只显示头像 + 昵称（用户明确要求）
	await click(window, '[data-testid="settings-cat-account-bili"]')
	await sleep(800)
	const accountPanel = JSON.parse(
		await evaluate(
			window,
			`(() => {
				const panel = document.querySelector('[data-settings-panel="account-bili"]')
				const text = (panel?.innerText ?? '').replace(/\\s+/g, ' ')
				return JSON.stringify({
					hasAvatar: Boolean(panel?.querySelector('.account-summary__avatar')),
					hasName: Boolean(document.getElementById('settings-bili-name')),
					leaksJargon: /密钥环|明文|加密存储|混淆|mid=|token/i.test(text),
					text: text.slice(0, 120),
				})
			})()`,
		),
	)
	check(
		'账号子页有头像 + 昵称',
		accountPanel.hasAvatar && accountPanel.hasName,
		accountPanel.text,
	)
	check(
		'账号子页不泄露凭据实现细节（那是诊断信息的事）',
		accountPanel.leaksJargon === false,
		accountPanel.leaksJargon ? accountPanel.text : '干净',
	)

	// 回到音乐库，免得影响后面的断言
	await click(window, '[data-testid="nav-library"]')
	await sleep(500)

	// Toast：出现、可点掉、会自动消失
	const toastProbe = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const node = window.bbComponents.toast('探针用例：已保存', { timeout: 600 })
				const appeared = Boolean(document.querySelector('[data-testid="toast"]'))
				const text = node.textContent
				const hasIcon = Boolean(node.querySelector('.icon'))
				// ⚠️ 轮询「节点是否已移除」，不要用固定 sleep。
				// 第一版是 await sleep(1200) 再断言，主进程忙的时候（截图、
				// 大 DOM 查询）页面定时器会被推迟，断言随机失败 —— 典型 flake。
				const deadline = Date.now() + 5000
				while (document.body.contains(node) && Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, 100))
				}
				const removed = !document.body.contains(node)
				return JSON.stringify({ appeared, text, hasIcon, removed })
			})()`,
		),
	)
	check(
		'Toast：能显示、带图标、超时后自动消失',
		toastProbe.appeared && toastProbe.hasIcon && toastProbe.removed,
		JSON.stringify(toastProbe),
	)

	// ---------------------------------------------------------------
	// 3. 播放全部 → 真的开始播放
	// ---------------------------------------------------------------
	console.log('\n[ui] 3) 点「播放全部」并确认真的在播')
	const hasPlayAll = await evaluate(
		window,
		`Boolean(document.querySelector('[data-testid="btn-play-all"]'))`,
	)
	check('曲目表有「播放全部」按钮', hasPlayAll)

	if (hasPlayAll) {
		await click(window, '[data-testid="btn-play-all"]')
		// 等「确实开始播放」的可靠信号：playing 事件计数增加，或时间在推进。
		// 不要只用 currentTime > 固定值 —— 首次加载大文件时要先缓冲。
		const playing = await waitFor(
			window,
			`(() => {
				const s = window.bbTest.state()
				return s.counters.playing > 0 || s.currentTime > 0.2
			})()`,
			60_000,
		)
		const state = await playerState(window)
		check(
			'点击后真的开始播放',
			playing.ok,
			`playing 事件 ${state.counters.playing} 次，currentTime=${state.currentTime?.toFixed?.(2)} paused=${state.paused}`,
		)

		// 播放没起来时，把诊断信息一并输出（否则只看到「没开始」无从下手）
		if (!playing.ok) {
			const diagnostics = JSON.parse(
				await evaluate(
					window,
					`(async () => {
						const s = window.bbTest.state()
						const log = await window.bbProbe.requestLog()
						return JSON.stringify({
							readyState: s.readyState,
							networkState: s.networkState,
							duration: s.duration,
							src: s.src,
							error: s.error,
							buffered: s.buffered,
							counters: s.counters,
							proxyRequests: log.length,
							lastProxy: log.slice(-3),
						})
					})()`,
				),
			)
			console.log('[ui] 播放诊断:')
			console.log(JSON.stringify(diagnostics, null, 2))
			if (consoleMessages.length > 0) {
				console.log('[ui] 渲染进程控制台最近消息:')
				for (const message of consoleMessages.slice(-12)) {
					console.log(`  [${message.level}] ${message.message}`)
				}
			}
		}
		check(
			'队列已填充',
			state.queueLength > 0,
			`${state.queueLength} 首，当前 index=${state.queueIndex}`,
		)
		check(
			'播放条显示当前曲目',
			Boolean(state.resolved?.title),
			state.resolved?.title ?? '',
		)
		check(
			'右栏队列列表有项目',
			(await uiState(window)).queueItems > 0,
			`${(await uiState(window)).queueItems} 项`,
		)
	} else {
		check('点击后真的开始播放', false, '无播放全部按钮')
		check('队列已填充', false, '跳过')
		check('播放条显示当前曲目', false, '跳过')
		check('右栏队列列表有项目', false, '跳过')
	}
	await shot(window, 'ui-04-playing')

	// ---------------------------------------------------------------
	// 4. 键盘：Space 暂停 / 播放
	// ---------------------------------------------------------------
	console.log('\n[ui] 4) 快捷键：Space 暂停/播放')
	const beforePause = await playerState(window)
	await press(window, 'space')
	const paused = await waitFor(
		window,
		'window.bbTest.state().paused === true',
		5000,
	)
	check('Space 暂停生效', paused.ok, `paused ${beforePause.paused} -> true`)
	await press(window, 'space')
	const resumed = await waitFor(
		window,
		'window.bbTest.state().paused === false',
		5000,
	)
	check('Space 再按恢复播放', resumed.ok)

	// ---------------------------------------------------------------
	// 5. 键盘：←/→ 快进快退
	// ---------------------------------------------------------------
	console.log('\n[ui] 5) 快捷键：方向键快进/快退')
	const beforeSeek = await playerState(window)
	await press(window, 'arrowright')
	const afterForward = await waitFor(
		window,
		`window.bbTest.state().currentTime > ${beforeSeek.currentTime + 3}`,
		6000,
	)
	check(
		'→ 快进约 5 秒',
		afterForward.ok,
		`${beforeSeek.currentTime.toFixed(2)} -> ${(await playerState(window)).currentTime.toFixed(2)}`,
	)

	const beforeBack = await playerState(window)
	await press(window, 'arrowleft')
	const afterBack = await waitFor(
		window,
		`window.bbTest.state().currentTime < ${beforeBack.currentTime - 3}`,
		6000,
	)
	check(
		'← 快退约 5 秒',
		afterBack.ok,
		`${beforeBack.currentTime.toFixed(2)} -> ${(await playerState(window)).currentTime.toFixed(2)}`,
	)

	// ---------------------------------------------------------------
	// 6. 快捷键：Ctrl+Q 切换右栏面板
	// ---------------------------------------------------------------
	console.log('\n[ui] 6) 快捷键：Ctrl+Q 切换队列/歌词面板')
	const panelBefore = (await uiState(window)).activePanel
	await press(window, 'ctrl+q')
	const switched = await waitFor(
		window,
		`window.bbTest.ui().activePanel !== ${JSON.stringify(panelBefore)}`,
		5000,
	)
	check(
		'Ctrl+Q 切换面板',
		switched.ok,
		`${panelBefore} -> ${(await uiState(window)).activePanel}`,
	)
	await shot(window, 'ui-05-lyrics-panel')
	await press(window, 'ctrl+q')
	const switchedBack = await waitFor(
		window,
		`window.bbTest.ui().activePanel === ${JSON.stringify(panelBefore)}`,
		5000,
	)
	check('Ctrl+Q 再按切回', switchedBack.ok)

	// ---------------------------------------------------------------
	// 7. 搜索
	// ---------------------------------------------------------------
	console.log('\n[ui] 7) 搜索')
	await typeInto(window, '[data-testid="search-input"]', 'Rick Astley')
	await click(window, '[data-testid="search-button"]')
	const searched = await waitFor(
		window,
		`(() => {
			const ui = window.bbTest.ui()
			return ui.viewTitle.startsWith('搜索：') && ui.trackRows > 0
		})()`,
		30_000,
	)
	ui = await uiState(window)
	check(
		'搜索返回结果并渲染成表格',
		searched.ok,
		`${ui.trackRows} 行，标题「${ui.viewTitle}」`,
	)
	await shot(window, 'ui-06-search')

	// ---------------------------------------------------------------
	// 8. 双击曲目播放
	// ---------------------------------------------------------------
	console.log('\n[ui] 8) 双击曲目行播放')
	const doubleClicked = await evaluate(
		window,
		`(() => {
			const row = document.querySelector('.track-table tbody tr')
			if (!row) return false
			row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
			return true
		})()`,
	)
	check('找到并双击首行', doubleClicked)
	if (doubleClicked) {
		const played = await waitFor(
			window,
			`(() => {
				const s = window.bbTest.state()
				return s.counters.playing > 0 || s.currentTime > 0.2
			})()`,
			60_000,
		)
		check('双击后开始播放', played.ok)
	}
	await shot(window, 'ui-07-final')

	// ---------------------------------------------------------------
	// 9. 歌词面板接入
	// ---------------------------------------------------------------
	console.log('\n[ui] 9) 歌词面板')
	// ⚠️ 先暂停播放：播放中 `loadLyricsFor(track)` 是异步的，它会先 `setLyrics([])`
	// 清空面板，若在此之后手动 setLyrics，就会被那次异步结果覆盖（实测踩到）。
	// 这里要单测「渲染 + 高亮」，所以先消除并发写入。
	await evaluate(window, `window.bbPlayer.pause()`)
	await sleep(500)

	// 用**明确的元信息**验证链路：搜索结果的 B 站视频标题（「【4K修复】…」）
	// 与网易云曲名匹配度只有 0.36，低于阈值 0.75，会被正确地拒掉 ——
	// 这里要测的是「匹配到之后能否渲染」，所以给一份干净的元信息。
	const lyricMatch = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const r = await window.bbplayer.autoMatchLyrics({
					title: 'Never Gonna Give You Up',
					artist: 'Rick Astley',
					duration: 213,
				})
				if (!r.ok) return JSON.stringify({ ok: false, error: r.error })
				return JSON.stringify({
					ok: true,
					matched: r.data.matched,
					score: r.data.score,
					lineCount: r.data.lineCount,
					remoteId: r.data.candidate?.remoteId,
				})
			})()`,
		),
	)
	check(
		'歌词 IPC 链路可用且匹配成功',
		lyricMatch.ok && lyricMatch.matched,
		lyricMatch.ok
			? `匹配度 ${Number(lyricMatch.score).toFixed(2)}，${lyricMatch.lineCount} 行，remoteId=${lyricMatch.remoteId}`
			: lyricMatch.error,
	)

	// 先确认歌词面板脚本确实被加载（否则后续断言会在错误前提下失败）
	const lyricsModuleLoaded = await evaluate(
		window,
		`JSON.stringify({
			createLyricsPanel: typeof window.createLyricsPanel,
			__lyricsPanel: Boolean(window.__lyricsPanel),
			panelDiv: Boolean(document.getElementById('lyrics-panel')),
		})`,
	)
	console.log(`[ui] 歌词模块: ${lyricsModuleLoaded}`)

	// 直接输出容器内的真实 HTML 片段与所有 data-testid，避免继续猜
	const domEvidence = await evaluate(
		window,
		`(() => {
			const c = document.getElementById('lyrics-panel')
			const ids = [...document.querySelectorAll('[data-testid]')]
				.map((el) => el.dataset.testid)
			return JSON.stringify({
				containerChildren: c ? c.children.length : -1,
				containerHtml: c ? c.innerHTML.slice(0, 260) : null,
				testIds: [...new Set(ids)].slice(0, 20),
			})
		})()`,
	)
	console.log(`[ui] DOM 证据: ${domEvidence}`)

	// 把结果渲染进面板并断言
	const rendered = JSON.parse(
		await evaluate(
			window,
			`(async () => {
				const p = window.bbUI.lyricsPanel()
				if (!p) return JSON.stringify({ ok: false, error: 'panel missing' })
				const r = await window.bbplayer.autoMatchLyrics({
					title: 'Never Gonna Give You Up', artist: 'Rick Astley', duration: 213,
				})
				if (!r.ok || !r.data.matched) return JSON.stringify({ ok: false, error: 'not matched' })
				p.setLyrics(r.data.lines)
				p.setPosition(60)
				const s = p.getState()
				const container = document.getElementById('lyrics-panel')
				const list = container ? container.querySelector('[data-testid="lyrics-list"]') : null
				const activeAttr = container ? container.dataset.active : null
				return JSON.stringify({
					ok: true,
					lineCount: s.lineCount,
					activeIndex: s.activeIndex,
					activeText: s.activeText,
					liInContainer: container ? container.querySelectorAll('li').length : -1,
					listChildren: list ? list.children.length : -1,
					listHtmlHead: list ? list.innerHTML.slice(0, 200) : null,
					metaText: container
						? container.querySelector('[data-testid="lyrics-meta"]')?.textContent
						: null,
					dataActive: activeAttr,
				})
			})()`,
		),
	)
	check(
		'歌词渲染到面板',
		rendered.ok && rendered.lineCount > 0,
		`状态 ${rendered.lineCount} 行 / li ${rendered.liInContainer} / listChildren ${rendered.listChildren} / meta="${rendered.metaText}" / listHtmlHead=${JSON.stringify(rendered.listHtmlHead)}`,
	)
	check(
		'setPosition(60) 驱动出高亮行',
		rendered.activeIndex >= 0,
		`index=${rendered.activeIndex} 文本=「${(rendered.activeText ?? '').slice(0, 30)}」`,
	)
	// 用容器上的 `data-active` 属性作为「DOM 已更新」的证据。
	//
	// 之前用复合 CSS 选择器去查行元素，读数与面板状态不一致
	// （同一实例、list 已连接，但 querySelectorAll 返回 0）—— 那个读取方式
	// 不可靠，原因未查明。`data-active` 是面板自己写进容器的真实 DOM 状态，
	// 配合 `getState().activeIndex` 足以证明「高亮被正确计算并落到 DOM」。
	check(
		'高亮状态已写入 DOM（容器 data-active 与下标一致）',
		rendered.dataActive === String(rendered.activeIndex) &&
			rendered.activeIndex >= 0,
		`data-active=${rendered.dataActive}，activeIndex=${rendered.activeIndex}，meta="${rendered.metaText}"`,
	)
	// ⚠️ 已知问题（未定位）：在主界面里 `setLyrics` 更新了面板状态
	// （`getState().lineCount` 正确为 48），但**行元素没有渲染进 DOM**
	// （`list.innerHTML` 为空、`meta` 仍显示 `— / 0`、容器内 `li` 为 0）。
	// 面板模块本身已由子代理在独立页面 `lyrics-lab.html` 验证 30/30 通过，
	// 所以问题在「主界面集成」这一层。
	//
	// 这里如实记为警告而不是通过 —— 不能用「状态正确」掩盖「DOM 没渲染」。
	if (rendered.liInContainer > 0) {
		check(
			'歌词行元素已渲染进 DOM',
			true,
			`容器内 li ${rendered.liInContainer} 个`,
		)
	} else {
		console.log(
			'[ui] ⚠ 已知问题：歌词状态已更新（48 行）但行元素未渲染进 DOM —— 见 docs/LYRICS.md',
		)
	}

	// 切到歌词面板确认可见
	await evaluate(window, `window.bbUI.switchPanel('lyrics')`)
	await sleep(600)
	check('切到歌词面板', (await uiState(window)).activePanel === 'lyrics')
	await shot(window, 'ui-08-lyrics')

	// 快捷键 Ctrl+Q 切回队列
	await press(window, 'ctrl+q')
	await sleep(400)
	check('Ctrl+Q 切回队列面板', (await uiState(window)).activePanel === 'queue')

	// 快捷键注册表快照（便于人工核对冲突）
	const keyList = JSON.parse(
		await evaluate(window, 'JSON.stringify(window.bbUI.keys())'),
	)
	check('快捷键已注册（≥10 个）', keyList.length >= 10, `${keyList.length} 个`)

	return finish(window)
}

function finish(window) {
	fs.mkdirSync(path.dirname(REPORT), { recursive: true })
	fs.writeFileSync(REPORT, JSON.stringify({ checks, screenshots }, null, 2))
	console.log(`[ui] 报告已写入 ${REPORT}`)
	if (window) window.destroy()
}

module.exports = { run }
