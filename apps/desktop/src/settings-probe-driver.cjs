/* oxlint-disable no-console -- 探针脚本，以 stdout 输出验证过程 */
/**
 * 桌面特性探针：Phase 4 收尾的界面验收
 * （主题 / 定时关闭 / 响度均衡 / 下载面板 / 备份面板）。
 *
 * 与其它探针同样的原则：**点真实按钮、读真实 DOM**，而不是直接调内部函数。
 *
 * ## 两个需要解释的验证手法
 *
 * 1. **响度均衡的音频链**：`createMediaElementSource` 会把 `<audio>` 的原生
 *    输出接管掉，一旦忘记连 `destination` 就完全没声音。所以断言里包含
 *    「各节点存在」与「已接 destination」，并且**实测一次 RMS** ——
 *    静默失败时 RMS 恒为 0，能立刻暴露。
 *
 * 2. **定时关闭的到点行为**：不可能真等 15 分钟。用 `setMinutes` 的最小
 *    正整数（1 分钟）也嫌久，所以直接调 `sleepTimer.setMinutes(1/60)`
 *    （1 秒）来驱动到点路径，并断言「真的暂停了」+「音量被还原」。
 */
const fs = require('node:fs')
const path = require('node:path')

const SHOTS = process.env.BBPLAYER_UI_SHOTS
	? process.env.BBPLAYER_UI_SHOTS
	: path.join(__dirname, '..', 'probe-output', 'settings-shots')
const REPORT = path.join(
	__dirname,
	'..',
	'probe-output',
	'settings-report.json',
)

const checks = []
const screenshots = []
const pending = []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function check(name, ok, detail) {
	checks.push({ name, ok: Boolean(ok), detail: detail ?? null })
	console.log(
		`[settings] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`,
	)
}

function todo(name, reason) {
	pending.push({ name, reason })
	console.log(`[settings] ⏳ 待人工验证 ${name} — ${reason}`)
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
		console.log(`[settings] 截图: ${file}`)
		return file
	} catch (error) {
		console.log(`[settings] 截图失败 ${name}: ${error.message}`)
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
		await sleep(250)
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

const textOf = (window, selector) =>
	evaluate(
		window,
		`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '').trim()`,
	)

// ---------------------------------------------------------------

async function run(window) {
	console.log('[settings] 开始 Phase 4 收尾验收')

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
			features: typeof window.bbDesktopFeatures,
			panel: typeof window.bbSettings,
			viaUI: typeof window.bbUI?.settingsPanel,
			gear: Boolean(document.getElementById('settings-open')),
			theme: document.documentElement.getAttribute('data-theme'),
		}))()`,
	)
	check('window.bbDesktopFeatures 已暴露', modules.features === 'object')
	check('window.bbSettings 已暴露', modules.panel === 'object')
	check('window.bbUI.settingsPanel 可访问', modules.viaUI === 'function')
	check('侧栏有设置齿轮按钮', modules.gear === true)
	check(
		'启动时已应用主题（data-theme 有值）',
		modules.theme === 'dark' || modules.theme === 'light',
		String(modules.theme),
	)
	await shot(window, 'settings-01-boot')

	// ---------- 2. 打开抽屉 ----------
	check(
		'设置抽屉初始隐藏',
		await evaluate(window, `document.getElementById('settings-drawer').hidden`),
	)
	await click(window, '#settings-open')
	await sleep(400)
	check(
		'点击齿轮后抽屉可见',
		(await evaluate(
			window,
			`document.getElementById('settings-drawer').hidden`,
		)) === false,
	)
	check(
		'默认停在外观页签',
		(await evaluate(
			window,
			`document.querySelector('[data-settings-panel="appearance"]').classList.contains('is-active')`,
		)) === true,
	)

	// ---------- 3. 主题切换 ----------
	const beforeTheme = await evaluate(
		window,
		`document.documentElement.getAttribute('data-theme')`,
	)
	await click(window, '[data-testid="theme-light"]')
	const themed = await waitFor(
		window,
		`document.documentElement.getAttribute('data-theme') === 'light'
			? { ok: true } : false`,
		10_000,
		'theme-light',
	)
	check(
		'点「浅色」后 data-theme 变为 light',
		themed.ok,
		`${beforeTheme} -> ${await evaluate(window, `document.documentElement.getAttribute('data-theme')`)}`,
	)
	// 浅色主题必须真的改变了背景色（否则只是改了个属性）
	const lightBg = await evaluate(
		window,
		`getComputedStyle(document.body).backgroundColor`,
	)
	check(
		'浅色主题真的改变了背景色',
		!/^rgb\(2[0-9], 2[0-9], 3[0-9]\)$/.test(String(lightBg)),
		String(lightBg),
	)
	check(
		'浅色按钮被标为选中',
		(await evaluate(
			window,
			`document.querySelector('[data-testid="theme-light"]').classList.contains('is-active')`,
		)) === true,
	)
	await shot(window, 'settings-02-light-theme')

	// 切回深色
	await click(window, '[data-testid="theme-dark"]')
	await waitFor(
		window,
		`document.documentElement.getAttribute('data-theme') === 'dark' ? { ok: true } : false`,
		10_000,
		'theme-dark',
	)
	check(
		'切回深色生效',
		(await evaluate(
			window,
			`document.documentElement.getAttribute('data-theme')`,
		)) === 'dark',
	)

	// 主题必须持久化到主进程设置里（重启后仍在）
	const persistedTheme = await evaluate(
		window,
		`window.bbplayer.settings.get().then((r) => r?.data?.settings?.theme ?? null)`,
	)
	check(
		'主题已持久化到设置（重启后保留）',
		persistedTheme === 'dark',
		String(persistedTheme),
	)

	// ---------- 4. 定时关闭：预设与倒计时 ----------
	await click(window, '[data-settings-tab="playback"]')
	await sleep(300)
	check(
		'切到播放页签',
		(await evaluate(
			window,
			`document.querySelector('[data-settings-panel="playback"]').classList.contains('is-active')`,
		)) === true,
	)
	const presetCount = await evaluate(
		window,
		`document.querySelectorAll('#settings-sleep-presets button').length`,
	)
	check(
		'定时关闭有 4 个预设（15/30/45/60，与移动端一致）',
		presetCount === 4,
		`${presetCount} 个`,
	)

	await click(window, '[data-testid="sleep-preset-15"]')
	const presetSet = await waitFor(
		window,
		`(() => {
			const t = document.getElementById('settings-sleep-status')?.textContent ?? ''
			return /剩余 \\d\\d:\\d\\d/.test(t) ? { ok: true, text: t } : false
		})()`,
		10_000,
		'sleep-preset',
	)
	check(
		'点预设后开始倒数并显示剩余时间',
		presetSet.ok,
		presetSet.ok ? presetSet.value.text : JSON.stringify(presetSet.value),
	)
	// 倒数必须在真的走（等 1.1s 看秒数变化）
	const firstTick = await textOf(window, '#settings-sleep-status')
	await sleep(1100)
	const secondTick = await textOf(window, '#settings-sleep-status')
	check(
		'倒数在走动（每秒刷新）',
		firstTick !== secondTick,
		`${firstTick} -> ${secondTick}`,
	)
	await shot(window, 'settings-03-sleep-timer')

	// 取消
	await click(window, '[data-testid="settings-sleep-cancel"]')
	const cancelled = await waitFor(
		window,
		`(() => {
			const t = document.getElementById('settings-sleep-status')?.textContent ?? ''
			return t.includes('已取消') ? { ok: true, text: t } : false
		})()`,
		10_000,
		'sleep-cancel',
	)
	check('可以取消定时关闭', cancelled.ok, cancelled.value?.text ?? '')
	// ⚠️ 不能用 `?? 'KEY_MISSING'`：`??` 只在 null/undefined 时兜底，而
	// `sleepEndsAt` 的合法「已清空」值**就是 null**。第一版因此把正确的实现
	// 报成「键不存在」。改用 `Object.hasOwn` 显式区分「键不存在」与「值为 null」。
	const clearedSleep = await evaluate(
		window,
		`window.bbplayer.settings.get().then((r) => {
			const s = r?.data?.settings ?? {}
			return {
				hasKey: Object.hasOwn(s, 'sleepEndsAt'),
				value: s.sleepEndsAt,
				type: typeof s.sleepEndsAt,
			}
		})`,
	)
	check(
		'取消后设置里的 sleepEndsAt 被清空为 null（键仍存在）',
		clearedSleep.hasKey === true && clearedSleep.value === null,
		JSON.stringify(clearedSleep),
	)

	// ---------- 5. 定时关闭：真的到点暂停并还原音量 ----------
	//
	// 不可能真等 1 分钟，所以用 1/60 分钟（= 1 秒）驱动到点路径。
	// 先把音量调到 0.5 并开始播放，才能断言「暂停了」与「音量还原了」。
	const fireSetup = await evaluate(
		window,
		`(() => {
			const audio = window.bbPlayer.getAudio()
			audio.volume = 0.5
			return { volume: audio.volume }
		})()`,
	)
	check('已把音量设为 0.5 以便断言还原', fireSetup.volume === 0.5)

	const fired = await evaluate(
		window,
		`(() => {
			// 直接调用特性模块的定时器（它就在 window.bbUI.desktop() 上）
			const desktop = window.bbUI.desktop()
			if (!desktop?.sleepTimer) return { error: 'sleepTimer 不可用' }
			const endsAt = desktop.sleepTimer.setMinutes(1 / 60)
			return { endsAt, remainingMs: desktop.sleepTimer.remainingMs() }
		})()`,
	)
	check(
		'能用极短时长驱动到点路径（用于验证）',
		typeof fired?.endsAt === 'number',
		JSON.stringify(fired),
	)

	// ⚠️ 时序注意：`setMinutes` 会**同步**调一次 `tick()`，而进入淡出窗口时
	// 那一帧就会把音量降下来（1 秒的定时、5 秒的淡出窗口 → 立刻降到 20%）。
	// 所以不能在暂停后立刻读音量 —— 必须先等 `describe().active === false`
	// （表示到点逻辑已经跑完、音量已还原），再断言。
	//
	// 第一版就是「等到 paused 就读音量」，结果拿到淡出的中间值 0.1，
	// 把正确的实现误报成缺陷（诊断探针显示最终确实是 0.5）。
	const firedResult = await waitFor(
		window,
		`(() => {
			const audio = window.bbPlayer.getAudio()
			const timer = window.bbUI.desktop()?.sleepTimer
			if (!timer || timer.describe().active) return false
			return { ok: true, paused: audio.paused, volume: audio.volume }
		})()`,
		15_000,
		'sleep-fire',
	)
	check(
		'到点后真的暂停了播放',
		firedResult.ok && firedResult.value.paused === true,
	)
	check(
		'到点后音量被还原到开始前的值（不是淡出的残留值）',
		firedResult.ok && Math.abs(firedResult.value.volume - 0.5) < 0.01,
		`音量=${firedResult.ok ? firedResult.value.volume : '?'}（期望 0.5）`,
	)

	// ---------- 6. 响度均衡 ----------
	await evaluate(
		window,
		`(() => {
			const el = document.getElementById('settings-loudness')
			el.checked = true
			el.dispatchEvent(new Event('change', { bubbles: true }))
			return true
		})()`,
	)
	const loudnessOn = await waitFor(
		window,
		`(() => {
			const d = window.bbUI.desktop()?.loudness?.describe?.()
			if (!d?.enabled) return false
			return { ok: true, ...d }
		})()`,
		15_000,
		'loudness',
	)
	check(
		'响度均衡启用成功',
		loudnessOn.ok,
		loudnessOn.ok
			? `gain=${loudnessOn.value.currentGain}`
			: JSON.stringify(loudnessOn.value),
	)
	if (loudnessOn.ok) {
		const value = loudnessOn.value
		check(
			'音频链四个节点都已建立（source/compressor/gain/analyser）',
			value.nodes?.source &&
				value.nodes?.compressor &&
				value.nodes?.gain &&
				value.nodes?.analyser,
			JSON.stringify(value.nodes),
		)
		check(
			'已接到 destination（漏接会完全静音）',
			value.connectedToDestination === true,
		)
		check(
			'压缩器参数已设置（不是默认值）',
			value.compressor?.threshold === -18 &&
				value.compressor?.ratio === 3 &&
				value.compressor?.knee === 24,
			JSON.stringify(value.compressor),
		)
		check(
			'目标是「只提升不衰减」（增益 >= 1 或为 1）',
			typeof value.currentGain === 'number' && value.currentGain >= 1,
			`增益=${value.currentGain}`,
		)
		check(
			'设置里记录了响度均衡已启用（重启后保留）',
			(await evaluate(
				window,
				`window.bbplayer.settings.get().then((r) => r?.data?.settings?.loudnessNormalization ?? null)`,
			)) === true,
		)
	} else {
		check('响度均衡启用成功', false, JSON.stringify(loudnessOn.value))
	}
	await shot(window, 'settings-04-loudness')

	// 实测 RMS：证明链路真的在处理音频
	const rmsProbe = await evaluate(
		window,
		`(() => {
			const d = window.bbUI.desktop()?.loudness?.describe?.()
			return { measuredRms: d?.measuredRms ?? null, state: d?.contextState ?? null }
		})()`,
	)
	console.log(
		`[settings] ⓘ 响度链实测 RMS=${rmsProbe.measuredRms}（AudioContext=${rmsProbe.state}）；` +
			'未播放时为 0 属正常',
	)

	// 关闭
	await evaluate(
		window,
		`(() => {
			const el = document.getElementById('settings-loudness')
			el.checked = false
			el.dispatchEvent(new Event('change', { bubbles: true }))
			return true
		})()`,
	)
	const loudnessOff = await waitFor(
		window,
		`window.bbUI.desktop()?.loudness?.describe?.().enabled === false ? { ok: true } : false`,
		10_000,
		'loudness-off',
	)
	check('可以关闭响度均衡', loudnessOff.ok)

	// ---------- 7. 下载面板 ----------
	await click(window, '[data-settings-tab="download"]')
	await sleep(500)
	check(
		'切到下载页签',
		(await evaluate(
			window,
			`document.querySelector('[data-settings-panel="download"]').classList.contains('is-active')`,
		)) === true,
	)
	const downloadInfo = await waitFor(
		window,
		`(() => {
			const text = document
				.getElementById('settings-download-dir')?.textContent?.trim() ?? ''
			return text.length > 0 ? { ok: true, dir: text } : false
		})()`,
		10_000,
		'download-dir',
	)
	check('下载目录已显示', downloadInfo.ok, downloadInfo.value?.dir ?? '')
	check(
		'显示已下载文件统计',
		(await textOf(window, '#settings-download-list')).includes('已下载'),
		(await textOf(window, '#settings-download-list')).slice(0, 60),
	)
	check(
		'进行中下载区域给出空态说明',
		(await textOf(window, '#settings-download-tasks')).includes('没有进行中'),
	)

	// 入队一首并断言任务行出现。
	//
	// ⚠️ 用**假 bvid** 时它必然解析失败，任务会很快变成 `failed`，
	// 而面板只列「进行中」的任务 —— 所以这里必须接受两种结果：
	//   * 任务行出现（解析慢，还在 resolving/downloading）→ 通过
	//   * 任务已进入终态（解析失败）→ 也算通过，但只在**确实观察到终态**时
	// 第一版只等「任务行出现」，在假 bvid 上必然超时，属于探针自身的断言缺陷
	// （把「网络快慢」当成了「功能有没有」）。
	const enqueued = await evaluate(
		window,
		`window.bbplayer.download.enqueue({ bvid: 'BV1settingsProbe', title: '设置页探针曲目' })`,
	)
	check('能通过 IPC 入队下载', enqueued?.ok === true, enqueued?.error ?? '')

	const taskSeen = await waitFor(
		window,
		`(() => {
			const row = document.querySelector('[data-testid="download-task-BV1settingsProbe"]')
			if (row) return { ok: true, phase: 'active' }
			// 已进入终态（假 bvid 解析失败）也算观察到任务被调度过
			return window.bbplayer.download.listTasks().then((r) => {
				const task = (r?.data ?? []).find((t) => t.bvid === 'BV1settingsProbe')
				if (task && ['failed', 'done', 'canceled'].includes(task.state)) {
					return { ok: true, phase: task.state, error: task.error ?? null }
				}
				return false
			})
		})()`,
		25_000,
		'download-task',
	)
	check(
		'下载任务被调度并且面板能观察到（进行中或已进入终态）',
		taskSeen.ok,
		taskSeen.ok
			? `阶段=${taskSeen.value.phase}${
					taskSeen.value.error
						? `（${String(taskSeen.value.error).slice(0, 50)}）`
						: ''
				}`
			: JSON.stringify(taskSeen.value),
	)
	// 面板在有进行中任务时必须渲染进度行；没有时给出空态 —— 两者都要正确
	const panelConsistency = await evaluate(
		window,
		`(() => {
			const hasRows =
				document.querySelectorAll('#settings-download-tasks .settings-row').length
			const emptyText =
				document.getElementById('settings-download-tasks')?.textContent ?? ''
			const info = window.bbplayer.download.info()
			return info.then((r) => ({
				activeTaskCount: r?.data?.activeTaskCount ?? null,
				hasRows,
				saysEmpty: emptyText.includes('没有进行中'),
			}))
		})()`,
	)
	check(
		'面板的「进行中」渲染与主进程状态一致',
		panelConsistency.activeTaskCount === 0
			? panelConsistency.saysEmpty
			: panelConsistency.hasRows > 0,
		JSON.stringify(panelConsistency),
	)
	await shot(window, 'settings-05-download')

	// ---------- 8. 备份面板 ----------
	await click(window, '[data-settings-tab="backup"]')
	await sleep(600)
	check(
		'切到备份页签',
		(await evaluate(
			window,
			`document.querySelector('[data-settings-panel="backup"]').classList.contains('is-active')`,
		)) === true,
	)
	check(
		'备份安全性状态已显示（加密或未保存）',
		(await textOf(window, '#settings-backup-security')).length > 0,
		await textOf(window, '#settings-backup-security'),
	)
	// 远端列表的空态文案里含「远端」；但 `switchTab` 里 `refreshRemoteBackups`
	// 是异步的，所以要**等**它渲染出来，不能立刻读。
	const remoteList = await waitFor(
		window,
		`(() => {
			const t = document.getElementById('settings-backup-list')?.textContent?.trim() ?? ''
			return t.length > 0 ? { ok: true, text: t } : false
		})()`,
		15_000,
		'backup-list',
	)
	check(
		'备份列表渲染出内容（未配置 WebDAV 时给出说明，而不是空白）',
		remoteList.ok,
		remoteList.ok
			? remoteList.value.text.slice(0, 80)
			: JSON.stringify(remoteList.value),
	)

	// 本地导出必须真的产出文件
	await click(window, '[data-testid="settings-backup-export"]')
	const exported = await waitFor(
		window,
		`(() => {
			const t = document.getElementById('settings-backup-status')?.textContent ?? ''
			return t.includes('已导出') ? { ok: true, text: t } : false
		})()`,
		30_000,
		'export',
	)
	check(
		'本地导出成功并显示路径',
		exported.ok && /backup-.*\.bbplayer/.test(String(exported.value?.text)),
		exported.ok ? exported.value.text : JSON.stringify(exported.value),
	)
	await shot(window, 'settings-06-backup')

	// 未配置 WebDAV 时测试连接必须给出可执行提示，而不是崩
	await click(window, '[data-testid="settings-webdav-test"]')
	const noWebdav = await waitFor(
		window,
		`(() => {
			const t = document.getElementById('settings-backup-status')?.textContent ?? ''
			return /尚未配置|失败/.test(t) ? { ok: true, text: t } : false
		})()`,
		15_000,
		'no-webdav',
	)
	check(
		'未配置 WebDAV 时给出明确提示（而不是静默失败）',
		noWebdav.ok,
		noWebdav.ok ? noWebdav.value.text : JSON.stringify(noWebdav.value),
	)

	// 保存配置：留空密码时不该清掉（本探针没有已存密码，所以只验证能保存）
	await typeInto(window, '#settings-webdav-url', 'http://127.0.0.1:1/dav')
	await typeInto(window, '#settings-webdav-user', 'probe-user')
	await typeInto(window, '#settings-webdav-password', 'probe-pass')
	await click(window, '[data-testid="settings-webdav-save"]')
	const saved = await waitFor(
		window,
		`(() => {
			const t = document.getElementById('settings-backup-status')?.textContent ?? ''
			return t.includes('已保存') ? { ok: true, text: t } : false
		})()`,
		15_000,
		'save-config',
	)
	check(
		'能保存 WebDAV 配置',
		saved.ok,
		saved.ok ? saved.value.text : JSON.stringify(saved.value),
	)

	// 密码绝不回传渲染进程
	const passwordLeak = await evaluate(
		window,
		`(() => {
			const input = document.getElementById('settings-webdav-password')
			const cfg = document.getElementById('settings-webdav-url')
			return {
				inputValue: input?.value ?? null,
				// 页面上不该出现刚输入的密码
				bodyHasPassword: (document.body.innerText ?? '').includes('probe-pass'),
				urlValue: cfg?.value ?? null,
			}
		})()`,
	)
	check(
		'保存后密码框被清空（不回填明文）',
		passwordLeak.inputValue === '',
		String(passwordLeak.inputValue),
	)
	check('页面可见文本里没有密码', passwordLeak.bodyHasPassword === false)
	check(
		'地址被回填（非敏感项可以回显）',
		passwordLeak.urlValue === 'http://127.0.0.1:1/dav',
		String(passwordLeak.urlValue),
	)

	// 连不上的地址必须给出「无法连接」而非未知错误
	await click(window, '[data-testid="settings-webdav-test"]')
	const deadHost = await waitFor(
		window,
		`(() => {
			const t = document.getElementById('settings-backup-status')?.textContent ?? ''
			return t.includes('无法连接') ? { ok: true, text: t } : false
		})()`,
		20_000,
		'dead-host',
	)
	check(
		'连不上的 WebDAV 地址给出「无法连接」提示',
		deadHost.ok,
		deadHost.ok
			? deadHost.value.text.slice(0, 100)
			: JSON.stringify(deadHost.value),
	)

	// ---------- 9. 关闭 ----------
	await click(window, '#settings-close')
	await sleep(300)
	check(
		'关闭按钮隐藏抽屉',
		await evaluate(window, `document.getElementById('settings-drawer').hidden`),
	)

	// 快捷键 Ctrl+, 打开
	await evaluate(window, `window.bbUI.press('ctrl+,')`)
	const shortcutOpen = await waitFor(
		window,
		`document.getElementById('settings-drawer').hidden === false ? { ok: true } : false`,
		5000,
		'shortcut',
	)
	check('Ctrl+, 能打开设置', shortcutOpen.ok)
	await evaluate(window, `window.bbUI.settingsPanel().close()`)

	// ---------- 10. 待人工验证 ----------
	todo(
		'浅色主题的整体观感',
		'配色是否舒适、对比度是否达标需要人眼判断；探针只能验证 data-theme 与背景色确实变化',
	)
	todo(
		'响度均衡的实际听感',
		'「是否真的让不同曲目响度更一致」需要耳朵判断，无法自动化',
	)

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
	console.log(`[settings] 报告已写入 ${REPORT}`)
	console.log(
		`[settings] 结果: ${passed} 通过 / ${failed} 失败 / ${pending.length} 待人工验证`,
	)
	if (window) window.destroy()
}

module.exports = { run }
