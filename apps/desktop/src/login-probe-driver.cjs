/* oxlint-disable no-console -- 探针脚本，以 stdout 输出验证过程 */
/**
 * 登录探针驱动：在 Electron 主进程里跑 Phase 3 的界面验收序列。
 *
 * 与 `ui-probe-driver.cjs` 同样的原则：**尽量点真实按钮、读真实 DOM**，
 * 而不是直接调内部函数。
 *
 * ## 关于「真实登录」的边界
 *
 * 扫码登录的最后一跳需要**真人用手机确认**，自动化到不了。所以本探针：
 *   * 真实走到「二维码已渲染 + 主进程已开始轮询」这一步，并断言
 *     **渲染进程拿不到 `qrcode_key`**（这是设计约束，必须验证）；
 *   * 真实走「无效 cookie」路径，断言错误被如实显示；
 *   * 通过 `BILIBILI_TEST_COOKIE` 环境变量**可选**注入一份有效 cookie，
 *     用来验证完整登录后的行为（音质升级 / 私密收藏夹）。未设置时
 *     这几项记为用户待验证，**不伪装成通过**。
 */
const fs = require('node:fs')
const path = require('node:path')

const SHOTS = process.env.BBPLAYER_UI_SHOTS
	? process.env.BBPLAYER_UI_SHOTS
	: path.join(__dirname, '..', 'probe-output', 'login-shots')
const REPORT = path.join(__dirname, '..', 'probe-output', 'login-report.json')

const checks = []
const screenshots = []
const pending = []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function check(name, ok, detail) {
	checks.push({ name, ok: Boolean(ok), detail: detail ?? null })
	console.log(
		`[login] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`,
	)
}

/** 需要真人/真实账号才能验证的项：明确记录，不计入通过 */
function todo(name, reason) {
	pending.push({ name, reason })
	console.log(`[login] ⏳ 待人工验证 ${name} — ${reason}`)
}

async function evaluate(window, expression) {
	return await window.webContents.executeJavaScript(expression, true)
}

async function shot(window, name) {
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			await sleep(attempt === 1 ? 500 : 400)
			const image = await window.webContents.capturePage()
			if (image.getSize().width === 0) throw new Error('空图像')
			fs.mkdirSync(SHOTS, { recursive: true })
			const file = path.join(SHOTS, `${name}.png`)
			fs.writeFileSync(file, image.toPNG())
			screenshots.push(file)
			console.log(`[login] 截图: ${file}`)
			return file
		} catch (error) {
			console.log(`[login] 截图重试 ${attempt}/3 ${name}: ${error.message}`)
		}
	}
	return null
}

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
			return true
		})()`,
	)
}

const textOf = (window, selector) =>
	evaluate(
		window,
		`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '').trim()`,
	)

// ---------------------------------------------------------------

async function run(window) {
	console.log('[login] 开始 Phase 3 登录/收藏夹验收')

	// 等渲染进程就绪
	const ready = await waitFor(
		window,
		'Boolean(window.__bbReady)',
		20_000,
		'ready',
	)
	check('渲染进程就绪', ready.ok)

	// ---------- 1. 模块与入口 ----------
	const modules = JSON.parse(
		await evaluate(
			window,
			`JSON.stringify({
				auth: typeof window.bbAuth,
				favorites: typeof window.bbFavorites,
				viaUI: typeof window.bbUI?.auth,
				accountLoggedIn:
					document.getElementById('account-open')?.dataset.loggedIn ?? null,
			})`,
		),
	)
	check('window.bbAuth 已暴露', modules.auth === 'object', modules.auth)
	check(
		'window.bbFavorites 已暴露',
		modules.favorites === 'object',
		modules.favorites,
	)
	check(
		'账号入口显示未登录态（本探针不预置凭据）',
		modules.accountLoggedIn === 'false',
		`data-logged-in=${modules.accountLoggedIn}`,
	)

	// ---------- 2. 头像按钮点击打开弹窗 ----------
	check(
		'弹窗初始隐藏',
		await evaluate(window, `document.getElementById('login-modal').hidden`),
	)
	await click(window, '#account-open')
	await sleep(400)
	check(
		'点击头像按钮后弹窗可见',
		(await evaluate(
			window,
			`document.getElementById('login-modal').hidden`,
		)) === false,
	)
	check(
		'默认停在扫码页签',
		(await evaluate(
			window,
			`document.querySelector('[data-login-panel="qr"]').classList.contains('is-active')`,
		)) === true,
	)

	// ---------- 3. 二维码真实渲染 ----------
	const qr = await waitFor(
		window,
		`(() => {
			const img = document.getElementById('login-qr-image')
			if (!img || !img.src) return false
			return { ok: true, prefix: img.src.slice(0, 30), length: img.src.length, natural: img.naturalWidth }
		})()`,
		30_000,
		'qr',
	)
	check(
		'二维码图片已渲染为 PNG data URL',
		qr.ok && String(qr.value?.prefix).startsWith('data:image/png;base64,'),
		qr.ok
			? `${qr.value.length} 字符, naturalWidth=${qr.value.natural}`
			: JSON.stringify(qr.value),
	)
	check(
		'二维码像素尺寸为 220（PNG 真的解码了）',
		qr.ok && qr.value.natural === 220,
		qr.ok ? `naturalWidth=${qr.value.natural}` : 'n/a',
	)
	await shot(window, 'login-01-qr')

	// ---------- 4. 安全约束：渲染进程拿不到 qrcode_key ----------
	// 注意：`executeJavaScript` 会**直接把返回值序列化**过来（对象就是对象），
	// 所以这里不能再 JSON.parse —— 第一版这么做直接抛了
	// `"[object Object]" is not valid JSON`。
	const leak = await evaluate(
		window,
		`(() => {
			// 把所有暴露给渲染进程的对象序列化一遍，找 32 位十六进制串
			const probes = {
				bbAuth: window.bbAuth,
				bbFavorites: window.bbFavorites,
				bbUI: window.bbUI,
				bbplayer: window.bbplayer,
			}
			let serialized = ''
			for (const [name, obj] of Object.entries(probes)) {
				try {
					serialized += name + ':' + JSON.stringify(Object.keys(obj ?? {})) + ';'
				} catch { serialized += name + ':ERR;' }
			}
			// 页面可见文本也不该有
			const bodyText = document.body.innerText ?? ''
			return {
				hasKeyInGlobals: /[0-9a-f]{32}/.test(serialized),
				hasKeyInVisibleText: /[0-9a-f]{32}/.test(bodyText),
				imgIsDataUrlOnly: (document.getElementById('login-qr-image')?.src ?? '').startsWith('data:'),
				imgAttrCount: document.getElementById('login-qr-image')?.attributes?.length ?? 0,
			}
		})()`,
	)
	check('渲染进程的全局对象里没有 qrcode_key', leak.hasKeyInGlobals === false)
	check('页面可见文本里没有 qrcode_key', leak.hasKeyInVisibleText === false)
	check(
		'二维码只以 data URL 形式存在（不是远程 URL）',
		leak.imgIsDataUrlOnly === true,
		`img 属性数 ${leak.imgAttrCount}`,
	)

	// 轮询确实在主进程跑着（渲染进程只拿到状态文本）
	const qrStatus = await textOf(window, '#login-qr-status')
	check(
		'扫码状态文案已更新（说明主进程轮询在进行）',
		qrStatus.length > 0,
		qrStatus,
	)

	// ---------- 5. 刷新二维码 ----------
	await click(window, '#login-qr-refresh')
	await sleep(2500)
	const refreshed = await textOf(window, '#login-qr-status')
	check('刷新二维码后仍有状态文案', refreshed.length > 0, refreshed)

	// ---------- 6. 无效 cookie 必须被如实拒绝 ----------
	await click(window, '[data-login-tab="cookie"]')
	await sleep(300)
	check(
		'切到粘贴 Cookie 页签',
		(await evaluate(
			window,
			`document.querySelector('[data-login-panel="cookie"]').classList.contains('is-active')`,
		)) === true,
	)
	await shot(window, 'login-02-cookie')

	await typeInto(
		window,
		'#login-cookie-input',
		'SESSDATA=obviously-invalid-token',
	)
	await click(window, '#login-cookie-submit')
	const reject = await waitFor(
		window,
		`(() => {
			const el = document.getElementById('login-cookie-status')
			const t = el?.textContent?.trim() ?? ''
			if (!t || t === '正在校验 cookie…') return false
			return { ok: true, text: t, kind: el.className }
		})()`,
		40_000,
		'reject',
	)
	check(
		'无效 cookie 被拒绝并显示原因',
		reject.ok && /无效|过期|失败/.test(String(reject.value?.text)),
		reject.ok ? reject.value.text : JSON.stringify(reject.value),
	)
	check(
		'拒绝时样式为错误态（不是绿色通过）',
		reject.ok && String(reject.value?.kind).includes('bad'),
		reject.ok ? reject.value.kind : 'n/a',
	)
	check(
		'被拒后账号仍是未登录态',
		(await evaluate(
			window,
			`document.getElementById('account-open')?.dataset.loggedIn`,
		)) === 'false',
		String(
			await evaluate(
				window,
				`document.getElementById('account-open')?.dataset.loggedIn`,
			),
		),
	)

	// 缺 SESSDATA 的输入也要被拦
	await typeInto(window, '#login-cookie-input', 'only_this=1')
	await click(window, '#login-cookie-submit')
	const missing = await waitFor(
		window,
		`(() => {
			const t = document.getElementById('login-cookie-status')?.textContent?.trim() ?? ''
			return t.includes('SESSDATA') ? { ok: true, text: t } : false
		})()`,
		10_000,
		'missing',
	)
	check(
		'缺少 SESSDATA 的输入被拦下且提示点名 SESSDATA',
		missing.ok,
		missing.ok ? missing.value.text : JSON.stringify(missing.value),
	)
	await shot(window, 'login-03-cookie-rejected')

	// ---------- 7. 密码页签：风控错误如实呈现 ----------
	await click(window, '[data-login-tab="password"]')
	await sleep(300)
	await typeInto(window, '#login-username', '13800000000')
	await typeInto(window, '#login-password', 'definitely-wrong-password')
	await click(window, '#login-password-submit')

	const pwd = await waitFor(
		window,
		`(() => {
			const el = document.getElementById('login-password-status')
			const t = el?.textContent?.trim() ?? ''
			if (!t || t === '正在登录…') return false
			return { ok: true, text: t, kind: el.className }
		})()`,
		45_000,
		'password',
	)
	check(
		'密码登录的失败原因被显示出来',
		pwd.ok && String(pwd.value?.text).length > 0,
		pwd.ok ? pwd.value.text : JSON.stringify(pwd.value),
	)
	check(
		'密码登录失败时样式为错误态',
		pwd.ok && String(pwd.value?.kind).includes('bad'),
		pwd.ok ? pwd.value.kind : 'n/a',
	)
	check(
		'提示里包含可执行的下一步（改用扫码/粘贴）',
		pwd.ok && /扫码|粘贴|cookie/i.test(String(pwd.value?.text)),
		pwd.ok ? pwd.value.text : 'n/a',
	)
	check(
		'提交后密码框已清空（不留在 DOM 里）',
		(await evaluate(
			window,
			`document.getElementById('login-password').value`,
		)) === '',
	)
	await shot(window, 'login-04-password')

	// ---------- 8. 账号页签 ----------
	await click(window, '[data-login-tab="account"]')
	await sleep(300)
	const account = JSON.parse(
		await evaluate(
			window,
			`JSON.stringify({
				text: document.getElementById('login-account')?.textContent ?? '',
				panel: document.getElementById('login-panel-account')?.textContent ?? '',
			})`,
		),
	)
	check(
		'账号页签在未登录时给出说明',
		/尚未登录|失效/.test(account.text),
		account.text.slice(0, 80),
	)
	// ⚠️ 这条断言**在 UI 重做阶段 0 被反过来**了。
	//
	// 原来断言「存储安全性被如实告知」—— 于是登录面板里写着
	// 「凭据已由系统密钥环加密存储」/「⚠️ 等同明文 —— 共享电脑请注意」。
	// 那是把安全审计结论摆在登录流程正中：用户不需要在上号时被教育这件事，
	// 一句「等同明文」只会让人以为出事了。
	//
	// 新规则：**主流程不出现这类实现细节，但必须可查** ——
	// 事实移到「设置 › 备份 › 诊断信息 › 凭据存储」。
	// 所以这里改成断言「账号页**没有**这些字眼」，而「查得到」由
	// `verify-desktop-settings.mjs` 的诊断信息断言负责。
	check(
		'账号页不再出现凭据存储方式的说明（它是诊断信息，不是登录流程的一部分）',
		!/密钥环|明文|加密存储|混淆/.test(account.panel),
		account.panel.replace(/\s+/g, ' ').slice(0, 100),
	)
	await shot(window, 'login-05-account')

	// ---------- 9. 关闭弹窗 ----------
	await click(window, '#login-close')
	await sleep(300)
	check(
		'关闭按钮隐藏弹窗',
		await evaluate(window, `document.getElementById('login-modal').hidden`),
	)

	// ---------- 10. 收藏夹：公开可读（无需登录）----------
	await click(window, '[data-testid="lib-tab-favorites"]')
	await sleep(400)
	check(
		'切到收藏夹视图后工具条可见',
		(await evaluate(
			window,
			`document.getElementById('favorite-bar').hidden`,
		)) === false,
	)
	check(
		'未登录时收藏夹视图给出说明（而不是空白）',
		(await textOf(window, '#content')).length > 0,
		(await textOf(window, '#content')).slice(0, 60),
	)
	await shot(window, 'login-06-favorites-empty')

	// 用示例 UID（B 站官方 UP，公开收藏夹）
	await typeInto(window, '#favorite-mid', '8047632')
	await click(window, '#favorite-load')

	const folders = await waitFor(
		window,
		`(() => {
			const items = document.querySelectorAll('.favorite-list__item')
			if (items.length === 0) return false
			return {
				ok: true,
				count: items.length,
				first: items[0].querySelector('.favorite-list__title')?.textContent ?? '',
			}
		})()`,
		45_000,
		'folders',
	)
	check(
		'匿名列出公开收藏夹（无需登录）',
		folders.ok && folders.value.count > 0,
		folders.ok
			? `${folders.value.count} 个，首个「${folders.value.first}」`
			: JSON.stringify(folders.value),
	)
	await shot(window, 'login-07-favorites-list')

	// ---------- 11. 预览 ----------
	if (folders.ok) {
		const firstMediaId = await evaluate(
			window,
			`document.querySelector('.favorite-list__item')?.dataset.mediaId ?? null`,
		)
		await click(window, `[data-testid="favorite-preview-${firstMediaId}"]`)
		const preview = await waitFor(
			window,
			`(() => {
				const table = document.querySelector('[data-testid="favorite-table-${firstMediaId}"]')
				if (!table) return false
				return { ok: true, rows: table.querySelectorAll('tbody tr').length }
			})()`,
			45_000,
			'preview',
		)
		check(
			'收藏夹预览渲染出曲目表',
			preview.ok && preview.value.rows > 0,
			preview.ok ? `${preview.value.rows} 行` : JSON.stringify(preview.value),
		)
		await shot(window, 'login-08-favorites-preview')

		// ---------- 12. 导入为歌单（增量幂等）----------
		await click(window, `[data-testid="favorite-sync-${firstMediaId}"]`)
		const synced = await waitFor(
			window,
			`(() => {
				const t = document.getElementById('favorite-status')?.textContent?.trim() ?? ''
				if (!/已导入/.test(t)) return false
				return { ok: true, text: t }
			})()`,
			180_000,
			'sync',
		)
		check(
			'收藏夹导入为本地歌单成功',
			synced.ok && /已导入/.test(String(synced.value?.text)),
			synced.ok ? synced.value.text : JSON.stringify(synced.value),
		)
		await shot(window, 'login-09-favorites-synced')

		// 再导一次：必须「跳过」而不是重复追加。
		//
		// ⚠️ 两个坑都要绕开：
		//  1. 首次导入成功后 `syncFolder` 会把中栏切到新歌单，
		//     **收藏夹列表的 DOM 已经不在了** —— 必须先切回收藏夹视图重建列表
		//     （第一版直接点旧选择器，点击落空，等不到任何变化）；
		//  2. 同一个状态元素里还留着上一次的文本，`waitFor` 会立刻返回旧值 ——
		//     必须等文本**变成新值**（第一版因此误报「第二次也新增 10」）。
		await click(window, '[data-testid="lib-tab-favorites"]')
		const relisted = await waitFor(
			window,
			`document.querySelectorAll('.favorite-list__item').length > 0`,
			45_000,
			'relist',
		)
		check('切回收藏夹视图后列表重建', relisted.ok)

		const statusBefore = await textOf(window, '#favorite-status')
		await click(window, `[data-testid="favorite-sync-${firstMediaId}"]`)
		const resynced = await waitFor(
			window,
			`(() => {
				const t = document.getElementById('favorite-status')?.textContent?.trim() ?? ''
				if (!/已导入/.test(t)) return false
				if (t === ${JSON.stringify(statusBefore)}) return false
				return { ok: true, text: t }
			})()`,
			180_000,
			'resync',
		)
		const skipMatch = /新增 0/.test(String(resynced.value?.text))
		check(
			'重复导入是增量的（新增 0，全部跳过）',
			resynced.ok && skipMatch,
			resynced.ok
				? resynced.value.text
				: `未匹配到「新增 0」：${JSON.stringify(resynced.value)}（同步前文本: ${statusBefore}）`,
		)

		// 歌单确实进了左栏。
		//
		// ⚠️ 选择器改过：阶段 1c 把侧栏歌单行换成组件层的 `.list-row`，
		// 旧的手搓类名 `.playlist-list__name` 不再存在 —— 第一版没跟着改，
		// 这条断言就恒为 0（由它自己抓到了）。
		//
		// 这里直接用**语义属性** `data-playlist-id` 定位，而不是视觉类名：
		// 以后换样式不会再把它弄坏。
		const playlistTitles = JSON.parse(
			await evaluate(
				window,
				`JSON.stringify(
					Array.from(
						document.querySelectorAll('[data-playlist-id] .list-row__title'),
					).map((el) => el.textContent),
				)`,
			),
		)
		check(
			'导入后的歌单出现在左栏',
			playlistTitles.length > 0,
			`${playlistTitles.length} 个: ${playlistTitles.slice(0, 3).join(' / ')}`,
		)
		const importedCount = await evaluate(
			window,
			`window.bbLibrary.getTracks().length`,
		)
		check('中栏显示了导入的曲目', importedCount > 0, `${importedCount} 首`)

		// ---------- 布局：收藏夹工具条不能盖住曲目表 ----------
		//
		// 截图里看着像重叠，所以这里**量真实几何**而不是靠肉眼判断：
		// 工具条顶边必须 ≥ 内容区底边（可容忍 1px 取整误差）。
		// ---------- 状态与操作必须一致 ----------
		//
		// `#login-logout` 原来**从来没有根据登录态显隐过**，于是账号页出现
		// "写着你尚未登录，唯一的按钮却是退出登录"这种自相矛盾的画面
		// （视觉审查发现的）。
		const accountStates = JSON.parse(
			await evaluate(
				window,
				`(() => {
				const box = document.getElementById('login-account')
				const logout = document.getElementById('login-logout')
				const text = (box?.textContent ?? '').trim()
				const loggedOut = text.includes('尚未登录') || text.includes('未登录')
				const box2 = logout?.getBoundingClientRect()
				return JSON.stringify({
					loggedOut,
					logoutHidden: Boolean(logout?.hidden),
					logoutPainted: Boolean(box2 && box2.width > 1 && box2.height > 1),
				})
			})()`,
			),
		)
		check(
			'未登录时「退出登录」不显示（状态与操作一致）',
			!accountStates.loggedOut ||
				(accountStates.logoutHidden && !accountStates.logoutPainted),
			`未登录=${accountStates.loggedOut} hidden=${accountStates.logoutHidden} 画出来了=${accountStates.logoutPainted}`,
		)
		const geometry = await evaluate(
			window,
			`(() => {
				const bar = document.getElementById('favorite-bar')
				const content = document.getElementById('content')
				const main = document.querySelector('.main')
				if (!bar || !content || !main) return { ok: false, reason: 'missing element' }
				const b = bar.getBoundingClientRect()
				const c = content.getBoundingClientRect()
				const m = main.getBoundingClientRect()
				return {
					ok: true,
					barTop: Math.round(b.top),
					barBottom: Math.round(b.bottom),
					barHeight: Math.round(b.height),
					contentTop: Math.round(c.top),
					contentBottom: Math.round(c.bottom),
					mainBottom: Math.round(m.bottom),
					barHidden: bar.hidden,
					scrollHeight: content.scrollHeight,
					clientHeight: content.clientHeight,
				}
			})()`,
		)
		if (!geometry.ok) {
			check('收藏夹工具条与内容区不重叠', false, geometry.reason)
		} else {
			/*
			 * ⚠️ 断言从「工具条在内容区**下方**」改成「两者**不重叠**」。
			 *
			 * 工具条原本挂在 `#content` 下面（页面最底部），而它的提示写着
			 * "填入任意 B 站用户的 UID" —— 输入框离提示整屏远。
			 * 现在它挪到了内容区**上方**（紧邻标题与那行提示），
			 * 所以"在下方"这个方向不再成立；真正要守的是**不重叠**。
			 */
			check(
				'收藏夹工具条与内容区不重叠（无论在上还是在下）',
				geometry.barBottom <= geometry.contentTop + 1 ||
					geometry.barTop >= geometry.contentBottom - 1,
				`工具条 [${geometry.barTop}, ${geometry.barBottom}]，内容区 [${geometry.contentTop}, ${geometry.contentBottom}]`,
			)
			check(
				'工具条在 .main 容器内（未被裁掉）',
				geometry.barBottom <= geometry.mainBottom + 1,
				`工具条 bottom=${geometry.barBottom}, main bottom=${geometry.mainBottom}`,
			)
			check(
				'内容区可滚动（曲目多于可视高度时不会硬挤掉工具条）',
				geometry.scrollHeight >= geometry.clientHeight,
				`scrollHeight=${geometry.scrollHeight}, clientHeight=${geometry.clientHeight}`,
			)
		}
	} else {
		todo('收藏夹预览与导入', '未能列出收藏夹，后续步骤跳过')
	}

	// ---------- 13. 可选：真实凭据下的行为 ----------
	const testCookie = process.env.BILIBILI_TEST_COOKIE
	if (testCookie) {
		console.log('[login] 检测到 BILIBILI_TEST_COOKIE，验证真实登录后的行为')
		await evaluate(window, `window.bbAuth.open('cookie')`)
		await sleep(400)
		await typeInto(window, '#login-cookie-input', testCookie)
		await click(window, '#login-cookie-submit')
		const loggedIn = await waitFor(
			window,
			`(() => {
				const button = document.getElementById('account-open')
				if (button?.dataset.loggedIn !== 'true') return false
				// 已登录时按钮会换成 account_circle 图标（颜色也会变）
				return { ok: true, label: button.getAttribute('aria-label') }
			})()`,
			40_000,
			'loggedin',
		)
		check(
			'粘贴真实 cookie 后登录成功',
			loggedIn.ok,
			loggedIn.ok ? loggedIn.value.badge : JSON.stringify(loggedIn.value),
		)
		await shot(window, 'login-10-logged-in')
	} else {
		todo(
			'扫码登录的最终确认（手机端点击确认）',
			'需要真人用哔哩哔哩 App 扫描；探针只能验证到二维码渲染与轮询启动',
		)
		todo(
			'登录后音质升级为杜比 / Hi-Res',
			'需要有效账号；设置 BILIBILI_TEST_COOKIE 后可自动验证',
		)
		todo(
			'登录后可见私密收藏夹',
			'需要有效账号；设置 BILIBILI_TEST_COOKIE 后可自动验证',
		)
	}

	return finish(window)
}

function finish(window) {
	fs.mkdirSync(path.dirname(REPORT), { recursive: true })
	const passed = checks.filter((c) => c.ok).length
	const failed = checks.length - passed
	fs.writeFileSync(
		REPORT,
		JSON.stringify({ checks, screenshots, pending, passed, failed }, null, 2),
	)
	console.log(`[login] 报告已写入 ${REPORT}`)
	console.log(
		`[login] 结果: ${passed} 通过 / ${failed} 失败 / ${pending.length} 待人工验证`,
	)
	if (window) window.destroy()
}

module.exports = { run }
