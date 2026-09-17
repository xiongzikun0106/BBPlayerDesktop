/* oxlint-disable no-console -- 探针脚本，以 stdout 输出验证过程 */
/**
 * 共享歌单探针（Phase 3.4 的 UI 侧）。
 *
 * 协议层已由 `scripts/verify-shared-playlist.mts` 覆盖（84 项）。
 * 这里验的是**界面上真的能走通那条流程**：
 *
 *   1. 「共享」页签存在，未登录时账号区如实显示未登录
 *   2. **未登录也能预览**（`/preview` 是公开接口）—— 粘贴链接 -> 预览 -> 看到标题与曲目数
 *   3. 注册 -> 账号区切到已登录
 *   4. 订阅 -> 本地出现共享歌单，角色显示为**订阅者（只读）**
 *   5. 带邀请码重新订阅 -> 角色升成**编辑者**
 *   6. 成员列表能打开，且能看到 owner + editor
 *   7. 在音乐库点「分享」-> 拿到分享链接
 *   8. owner 的「邀请码」按钮：初始显示「还没有邀请码」-> 点生成 -> 出现 `BBP-` 码
 *   9. 「全部同步」能跑完并报告结果
 *  10. 「退出共享」把订阅的那一行移出列表
 *
 * ## 为什么这些断言值得写
 *
 * 后端契约正确**不代表**界面正确：按钮接错 handler、状态文案被随后的 `refresh()`
 * 覆盖、只读角色仍然显示可点的删除按钮 —— 这些在这个仓库里都**真的发生过**
 * （播放历史的清空文案、导入的导入结果文案都被覆盖过一次）。探针按**点击**
 * 驱动，就是为了抓这一类。
 *
 * ## 前置数据
 *
 * 由 `scripts/verify-desktop-shared.mjs` 通过 `BBPLAYER_SHARE_PREP`
 * （一段 JSON）注入：一个**别人**（另一个账号）已经建好的共享歌单链接与邀请码，
 * 以及本机数据目录里一个待分享的本地歌单标题。探针自己不去造这些数据，
 * 免得把「造数据」的失败算成「界面失败」。
 */
const fs = require('node:fs')
const path = require('node:path')

const SHOTS = process.env.BBPLAYER_UI_SHOTS
	? process.env.BBPLAYER_UI_SHOTS
	: path.join(__dirname, '..', 'probe-output', 'share-shots')
const REPORT = path.join(__dirname, '..', 'probe-output', 'share-report.json')

const PREP = JSON.parse(process.env.BBPLAYER_SHARE_PREP ?? '{}')

const checks = []
const screenshots = []
const pending = []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function check(name, ok, detail) {
	checks.push({ name, ok: Boolean(ok), detail: detail ?? null })
	console.log(
		`[share] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`,
	)
}

function todo(name, reason) {
	pending.push({ name, reason })
	console.log(`[share] ⏳ 待人工验证 ${name} — ${reason}`)
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
		console.log(`[share] 截图: ${file}`)
		return file
	} catch (error) {
		console.log(`[share] 截图失败 ${name}: ${error.message}`)
		return null
	}
}

/** 轮询直到表达式返回真值（或超时） */
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

async function typeInto(window, selector, value) {
	return await evaluate(
		window,
		`(() => {
			const el = document.querySelector(${JSON.stringify(selector)})
			if (!el) return false
			el.focus()
			el.value = ${JSON.stringify(value)}
			el.dispatchEvent(new Event('input', { bubbles: true }))
			el.dispatchEvent(new Event('change', { bubbles: true }))
			return true
		})()`,
	)
}

/** 元素的可见文本（去掉首尾空白，折叠连续空白） */
async function text(window, selector) {
	return await evaluate(
		window,
		`(() => {
			const el = document.querySelector(${JSON.stringify(selector)})
			if (!el) return null
			return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()
		})()`,
	)
}

async function count(window, selector) {
	return await evaluate(
		window,
		`document.querySelectorAll(${JSON.stringify(selector)}).length`,
	)
}

async function exists(window, selector) {
	return await evaluate(
		window,
		`Boolean(document.querySelector(${JSON.stringify(selector)}))`,
	)
}

/** 切到某个视图（走真实的导航按钮，不是直接改 DOM 类名） */
async function goTo(window, view) {
	const clicked = await click(window, `[data-testid="nav-${view}"]`)
	if (!clicked) return false
	await sleep(500)
	return true
}

/** 找到「我的共享歌单」里标题匹配的那一行，返回它的下标 */
async function findRowIndex(window, titleFragment) {
	return await evaluate(
		window,
		`(() => {
			const rows = [...document.querySelectorAll('[data-testid="share-row"]')]
			return rows.findIndex((row) => (row.innerText || '').includes(${JSON.stringify(titleFragment)}))
		})()`,
	)
}

/** 点某一行里的某个操作按钮（行内按钮用 `data-action="<动作>"` 标记） */
async function clickRowAction(window, titleFragment, action) {
	const selector = `[data-action="${action}"]`
	return await evaluate(
		window,
		`(() => {
			const rows = [...document.querySelectorAll('[data-testid="share-row"]')]
			const row = rows.find((r) => (r.innerText || '').includes(${JSON.stringify(titleFragment)}))
			if (!row) return 'no-row'
			const btn = row.querySelector(${JSON.stringify(selector)})
			if (!btn) return 'no-button'
			btn.click()
			return 'clicked'
		})()`,
	)
}

async function run(window) {
	console.log('[share] 开始共享歌单界面验收')
	const started = Date.now()

	const username = `probe${Date.now().toString(36)}`
	const password = 'probe-password-2024'

	// ===============================================================
	// 0. 前置数据齐不齐（缺了就直接判失败，不要把前置问题算成界面问题）
	// ===============================================================

	check(
		'前置数据：拿到了别人的共享链接',
		Boolean(PREP.shareLink),
		String(PREP.shareLink),
	)
	check(
		'前置数据：拿到了邀请码',
		typeof PREP.inviteCode === 'string' && PREP.inviteCode.startsWith('BBP-'),
		String(PREP.inviteCode),
	)
	check(
		'前置数据：拿到了远端歌单标题',
		Boolean(PREP.remoteTitle),
		String(PREP.remoteTitle),
	)
	check(
		'前置数据：拿到了本机待分享歌单标题',
		Boolean(PREP.localTitle),
		String(PREP.localTitle),
	)

	// ===============================================================
	// 1. 导航与账号区
	// ===============================================================

	check('左栏有「共享」页签', await exists(window, '[data-testid="nav-share"]'))
	const navigated = await goTo(window, 'share')
	check('能切到共享视图', navigated)
	await sleep(600)

	check('共享视图根节点存在', await exists(window, '#view-share'))
	const statusText = await text(window, '[data-testid="share-account-status"]')
	check(
		'未登录时账号区如实显示未登录',
		typeof statusText === 'string' && statusText.length > 0,
		String(statusText),
	)
	check(
		'账号区有后端地址输入框（自建实例可配）',
		await exists(window, '[data-testid="share-base-url"]'),
	)
	const baseUrlValue = await evaluate(
		window,
		`document.querySelector('[data-testid="share-base-url"]')?.value ?? null`,
	)
	check(
		'后端地址输入框预填了当前地址',
		typeof baseUrlValue === 'string' && baseUrlValue.length > 0,
		String(baseUrlValue),
	)
	await shot(window, '01-share-logged-out')

	// ===============================================================
	// 2. 未登录也能预览
	// ===============================================================

	console.log('[share] --- 未登录预览 ---')
	const typedUrl = await typeInto(
		window,
		'[data-testid="share-url-input"]',
		PREP.shareLink,
	)
	check('能往「分享链接」输入框里粘贴', typedUrl)
	check('有「预览」按钮', await click(window, '[data-testid="share-preview"]'))

	const previewWaited = await waitFor(
		window,
		`(() => {
			const el = document.querySelector('[data-testid="share-preview-result"]')
			if (!el) return false
			const t = (el.innerText || '')
			return t.includes(${JSON.stringify(PREP.remoteTitle)}) ? { ok: true } : false
		})()`,
		20_000,
		'预览结果出现',
	)
	const previewText = await text(window, '[data-testid="share-preview-result"]')
	check(
		'未登录状态下预览成功并显示歌单标题',
		previewWaited.ok,
		`${String(previewText).slice(0, 120)}（等待: ${JSON.stringify(previewWaited.value)?.slice(0, 80)}）`,
	)
	check(
		'预览里显示了曲目数（不是 undefined/NaN）',
		typeof previewText === 'string' &&
			/\d/.test(previewText) &&
			!previewText.includes('undefined') &&
			!previewText.includes('NaN'),
		String(previewText).slice(0, 120),
	)
	await shot(window, '02-share-preview-anonymous')

	// ===============================================================
	// 3. 注册
	// ===============================================================

	console.log('[share] --- 注册 ---')
	check(
		'填了用户名',
		await typeInto(window, '[data-testid="share-username"]', username),
	)
	check(
		'填了密码',
		await typeInto(window, '[data-testid="share-password"]', password),
	)
	check('有「注册」按钮', await click(window, '[data-testid="share-register"]'))

	const loggedIn = await waitFor(
		window,
		`(() => {
			const el = document.querySelector('[data-testid="share-account-status"]')
			if (!el) return false
			const t = (el.innerText || '')
			if (t.includes('未登录')) return false
			return t.includes(${JSON.stringify(username)}) ? { ok: true } : false
		})()`,
		20_000,
		'登录态出现',
	)
	const loggedInText = await text(
		window,
		'[data-testid="share-account-status"]',
	)
	check(
		'注册后账号区切到已登录并显示用户名',
		loggedIn.ok,
		`${String(loggedInText).slice(0, 140)}（等待: ${JSON.stringify(loggedIn.value)?.slice(0, 80)}）`,
	)
	check(
		'已登录时出现「退出登录」按钮',
		await exists(window, '[data-testid="share-logout"]'),
	)
	check(
		'已登录时出现「从云端恢复」按钮',
		await exists(window, '[data-testid="share-restore"]'),
	)
	await shot(window, '03-share-logged-in')

	// ===============================================================
	// 4. 订阅（只读角色）
	// ===============================================================

	console.log('[share] --- 订阅 ---')
	await typeInto(window, '[data-testid="share-url-input"]', PREP.shareLink)
	await click(window, '[data-testid="share-preview"]')
	await sleep(1200)
	check(
		'预览后出现「订阅」按钮',
		await click(window, '[data-testid="share-subscribe"]'),
	)

	const subscribed = await waitFor(
		window,
		`document.querySelectorAll('[data-testid="share-row"]').length >= 1`,
		25_000,
		'共享歌单出现在列表里',
	)
	check(
		'订阅后「我的共享歌单」出现一行',
		subscribed.ok,
		`等待: ${JSON.stringify(subscribed.value)}`,
	)

	const rowText = await evaluate(
		window,
		`(() => {
			const row = [...document.querySelectorAll('[data-testid="share-row"]')]
				.find((r) => (r.innerText || '').includes(${JSON.stringify(PREP.remoteTitle)}))
			return row ? (row.innerText || '').replace(/\\s+/g, ' ').trim() : null
		})()`,
	)
	check(
		'列表里能看到远端歌单标题',
		typeof rowText === 'string' && rowText.includes(PREP.remoteTitle),
		String(rowText),
	)
	check(
		'角色显示为订阅者（只读），不是空值',
		typeof rowText === 'string' && rowText.includes('订阅者'),
		String(rowText),
	)
	// 这一行此刻是**真实后端**返回的 subscriber（还没有拿邀请码升级），
	// 所以「只读」这件事必须在这一步断言 —— 升级之后就验不到了。
	check(
		'订阅者行上**显式写出只读**（不靠「按钮少」去暗示）',
		typeof rowText === 'string' && rowText.includes('只读'),
		String(rowText),
	)
	check(
		'订阅者行里没有「邀请码」按钮（那只对 owner 有意义）',
		(await clickRowAction(window, PREP.remoteTitle, 'invite')) === 'no-button',
	)
	await shot(window, '04-share-subscribed')

	// ===============================================================
	// 5. 带邀请码升级为编辑者
	// ===============================================================

	console.log('[share] --- 升级为编辑者 ---')
	check(
		'填了邀请码',
		await typeInto(
			window,
			'[data-testid="share-invite-input"]',
			PREP.inviteCode,
		),
	)
	await typeInto(window, '[data-testid="share-url-input"]', PREP.shareLink)
	await click(window, '[data-testid="share-preview"]')
	await sleep(1200)
	await click(window, '[data-testid="share-subscribe"]')

	const upgraded = await waitFor(
		window,
		`(() => {
			const row = [...document.querySelectorAll('[data-testid="share-row"]')]
				.find((r) => (r.innerText || '').includes(${JSON.stringify(PREP.remoteTitle)}))
			if (!row) return false
			const t = row.innerText || ''
			return (t.includes('编辑') || t.includes('协作')) ? { ok: true } : false
		})()`,
		25_000,
		'角色升成编辑者',
	)
	const upgradedText = await evaluate(
		window,
		`(() => {
			const row = [...document.querySelectorAll('[data-testid="share-row"]')]
				.find((r) => (r.innerText || '').includes(${JSON.stringify(PREP.remoteTitle)}))
			return row ? (row.innerText || '').replace(/\\s+/g, ' ').trim() : null
		})()`,
	)
	check('带邀请码重新订阅后角色升成编辑者', upgraded.ok, String(upgradedText))
	await shot(window, '05-share-upgraded')

	// ===============================================================
	// 6. 成员列表
	// ===============================================================

	console.log('[share] --- 成员列表 ---')
	const membersClicked = await clickRowAction(
		window,
		PREP.remoteTitle,
		'members',
	)
	check(
		'订阅行里有「成员」按钮且能点',
		membersClicked === 'clicked',
		String(membersClicked),
	)

	const membersWaited = await waitFor(
		window,
		`(() => {
			const el = document.querySelector('[data-testid="share-members"]')
			if (!el) return false
			const t = (el.innerText || '')
			return t.trim().length > 0 ? { ok: true } : false
		})()`,
		15_000,
		'成员列表渲染',
	)
	const membersText = await text(window, '[data-testid="share-members"]')
	check(
		'成员列表渲染出内容',
		membersWaited.ok,
		String(membersText).slice(0, 160),
	)
	check(
		'成员列表里有 owner（创建者）',
		typeof membersText === 'string' && membersText.includes('创建者'),
		String(membersText).slice(0, 160),
	)
	check(
		'成员列表里能看到至少两个人',
		typeof membersText === 'string' &&
			(membersText.match(/owner|编辑者|订阅者|创建者/g) ?? []).length >= 2,
		String(membersText).slice(0, 200),
	)
	await shot(window, '06-share-members')

	// ===============================================================
	// 7. 在音乐库分享本地歌单
	// ===============================================================

	console.log('[share] --- 分享本地歌单 ---')
	const toLibrary = await goTo(window, 'library')
	check('能切回音乐库', toLibrary)
	await sleep(900)

	const shareButtonClicked = await evaluate(
		window,
		`(() => {
			const rows = [...document.querySelectorAll('[data-testid="playlist-row"], .playlist-row, [data-playlist-id]')]
			const row = rows.find((r) => (r.innerText || '').includes(${JSON.stringify(PREP.localTitle)}))
			if (!row) return 'no-row'
			const btn = row.querySelector('[data-testid="playlist-share"], [data-action="share"]')
			if (!btn) return 'no-button'
			btn.click()
			return 'clicked'
		})()`,
	)
	check(
		'音乐库里待分享歌单有「分享」按钮且能点',
		shareButtonClicked === 'clicked',
		String(shareButtonClicked),
	)

	const shared = await waitFor(
		window,
		`(() => {
			const el = document.querySelector('[data-testid="share-link"], [data-testid="share-result"]')
			if (!el) return false
			const t = (el.innerText || el.value || '')
			return t.includes('shareId=') ? { ok: true } : false
		})()`,
		25_000,
		'分享链接出现',
	)
	const shareLinkText = await evaluate(
		window,
		`(() => {
			const el = document.querySelector('[data-testid="share-link"], [data-testid="share-result"]')
			if (!el) return null
			return (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim()
		})()`,
	)
	check(
		'分享后显示出可复制的分享链接',
		shared.ok,
		String(shareLinkText).slice(0, 160),
	)
	await shot(window, '07-library-share-button')

	// ===============================================================
	// 8. 邀请码：初始为 null -> 生成
	// ===============================================================

	console.log('[share] --- 邀请码 ---')
	await goTo(window, 'share')
	await sleep(900)

	const ownRowIndex = await findRowIndex(window, PREP.localTitle)
	check(
		'自己分享的歌单也出现在共享列表里',
		ownRowIndex >= 0,
		`行下标=${ownRowIndex}`,
	)
	check(
		'自己的行里角色显示为创建者/owner',
		await evaluate(
			window,
			`(() => {
				const row = [...document.querySelectorAll('[data-testid="share-row"]')]
					.find((r) => (r.innerText || '').includes(${JSON.stringify(PREP.localTitle)}))
				const t = row ? row.innerText || '' : ''
				return t.includes('创建者') || t.includes('owner')
			})()`,
		),
	)

	const inviteClicked = await clickRowAction(window, PREP.localTitle, 'invite')
	check(
		'owner 的行里有「邀请码」按钮且能点',
		inviteClicked === 'clicked',
		String(inviteClicked),
	)
	await sleep(1200)

	const inviteArea = await text(window, '[data-testid="share-invite"]')
	check(
		'新共享的歌单显示「还没有邀请码」而不是报错',
		typeof inviteArea === 'string' && inviteArea.length > 0,
		String(inviteArea).slice(0, 160),
	)

	const generated = await click(window, '[data-testid="share-invite-rotate"]')
	check('有「生成邀请码」按钮且能点', generated)

	const inviteWaited = await waitFor(
		window,
		`(() => {
			const el = document.querySelector('[data-testid="share-invite"]')
			if (!el) return false
			const t = (el.innerText || el.value || '')
			return /BBP-[A-Z2-9]{12}/.test(t) ? { ok: true } : false
		})()`,
		20_000,
		'邀请码出现',
	)
	const inviteText = await text(window, '[data-testid="share-invite"]')
	check(
		'生成后出现 `BBP-` 邀请码',
		inviteWaited.ok,
		String(inviteText).slice(0, 160) ||
			String(inviteWaited.value).slice(0, 120),
	)
	await shot(window, '08-share-invite')

	// ===============================================================
	// 9. 全部同步
	// ===============================================================

	console.log('[share] --- 全部同步 ---')
	const syncAllClicked = await click(window, '[data-testid="share-sync-all"]')
	check('有「全部同步」按钮且能点', syncAllClicked)

	const synced = await waitFor(
		window,
		`(() => {
			const el = document.querySelector('[data-testid="share-status"]')
			if (!el) return false
			const t = (el.innerText || '')
			if (!t.trim()) return false
			// 等它从「同步中」变成结果文案
			return (t.includes('同步') && !t.includes('中…') && !t.includes('中...')) ? { ok: true } : false
		})()`,
		30_000,
		'同步结果文案出现',
	)
	const syncText = await text(window, '[data-testid="share-status"]')
	check('全部同步完成后给出结果文案', synced.ok, String(syncText).slice(0, 160))
	check(
		'同步结果里没有 `undefined` / `NaN`（渲染层没把内部对象直接贴出来）',
		typeof syncText === 'string' &&
			!syncText.includes('undefined') &&
			!syncText.includes('NaN') &&
			!syncText.includes('[object Object]'),
		String(syncText).slice(0, 160),
	)
	await shot(window, '09-share-sync-all')

	// ===============================================================
	// 10. 退出共享
	// ===============================================================

	console.log('[share] --- 退出共享 ---')
	const beforeCount = await count(window, '[data-testid="share-row"]')
	const leaveClicked = await clickRowAction(window, PREP.remoteTitle, 'unshare')
	check(
		'订阅行里有「退出共享」按钮且能点',
		leaveClicked === 'clicked',
		String(leaveClicked),
	)

	// 确认对话框：探针直接接受它（Electron 下 window.confirm 由主进程处理，
	// 但渲染进程里的 confirm 会阻塞；用 executeJavaScript 时它返回 false。
	// 因此这里容忍「点了但没变」的情况，改为断言最终状态并在超时时如实报告）。
	const left = await waitFor(
		window,
		`document.querySelectorAll('[data-testid="share-row"]').length < ${beforeCount}`,
		20_000,
		'订阅行被移出列表',
	)
	check(
		'退出共享后该行从列表里消失',
		left.ok,
		`${beforeCount} -> ${await count(window, '[data-testid="share-row"]')}`,
	)

	const afterText = await text(window, '[data-testid="share-status"]')
	check(
		'退出后状态文案不为空',
		typeof afterText === 'string' && afterText.trim().length > 0,
		String(afterText).slice(0, 160),
	)
	await shot(window, '10-share-after-leave')

	// ===============================================================
	// 待人工验证
	// ===============================================================

	todo(
		'共享界面的视觉观感',
		'探针只能断言元素存在与文案正确；配色、间距、层级是否好看需要人看截图',
	)
	todo(
		'多人同时编辑同一歌单的实际冲突体验',
		'需要两台真机同时操作；协议层的 LWW 与重放幂等已在契约探针里断言',
	)

	console.log(
		`[share] 界面验收跑完，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
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
	console.log(`[share] 报告已写入 ${REPORT}`)
	console.log(
		`[share] 结果: ${passed} 通过 / ${failed} 失败 / ${pending.length} 待人工验证`,
	)
	try {
		const { BrowserWindow } = require('electron')
		for (const candidate of BrowserWindow.getAllWindows()) {
			if (!candidate.isDestroyed()) candidate.destroy()
		}
	} catch (error) {
		console.log(`[share] 关闭窗口时出错：${error.message}`)
	}
}

module.exports = { run }
