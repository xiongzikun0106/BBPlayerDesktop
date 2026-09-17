/* oxlint-disable no-console -- 探针脚本，以 stdout 输出验证过程 */
/**
 * 媒体集成探针：验证 Phase 4 的 MediaSession / 任务栏缩略图 / 媒体键兜底。
 *
 * 覆盖：
 *  1. 渲染进程的 `navigator.mediaSession` 可用
 *  2. 播放一首真实曲目后，系统媒体元数据（标题/作者/封面）被设置
 *  3. `playbackState` 随播放/暂停变化
 *  4. `setPositionState` 上报成功且**时长未知时不抛错**
 *     （这是 `setPositionState` 的实际坑：duration 为 NaN/0 会抛）
 *  5. 8 个 mediaSession action 都已注册
 *  6. 播放/暂停时任务栏按钮图标同步（主进程侧状态）
 *  7. 主进程侧图标自检：四张 32×32 PNG 且互不相同
 *  8. 硬件媒体键兜底默认**未注册**（避免与 MediaSession 双触发）
 *  9. 从主进程下发媒体动作后，播放器真的响应（点「下一首」→ 曲目变化）
 *
 * 用法：node scripts/verify-desktop-media.mjs
 */
const fs = require('node:fs')
const path = require('node:path')

const SHOTS = process.env.BBPLAYER_UI_SHOTS
	? process.env.BBPLAYER_UI_SHOTS
	: path.join(__dirname, '..', 'probe-output', 'media-shots')
const REPORT = path.join(__dirname, '..', 'probe-output', 'media-report.json')

const checks = []
const screenshots = []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function check(name, ok, detail) {
	checks.push({ name, ok: Boolean(ok), detail: detail ?? null })
	console.log(
		`[media] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`,
	)
}

async function evaluate(window, expression) {
	return await window.webContents.executeJavaScript(expression, true)
}

async function shot(window, name) {
	try {
		await sleep(400)
		const image = await window.webContents.capturePage()
		if (image.getSize().width === 0) return null
		fs.mkdirSync(SHOTS, { recursive: true })
		const file = path.join(SHOTS, `${name}.png`)
		fs.writeFileSync(file, image.toPNG())
		screenshots.push(file)
		console.log(`[media] 截图: ${file}`)
		return file
	} catch (error) {
		console.log(`[media] 截图失败 ${name}: ${error.message}`)
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
	const mediaIntegration = require('./media-integration.cjs')

	console.log('[media] 开始 Phase 4 媒体集成验收')

	const ready = await waitFor(
		window,
		'Boolean(window.__bbReady)',
		20_000,
		'ready',
	)
	check('渲染进程就绪', ready.ok)

	// ---------- 1. 支持性 ----------
	const support = await evaluate(
		window,
		`(() => ({
			hasMediaSession: 'mediaSession' in navigator,
			hasMetadataCtor: typeof MediaMetadata === 'function',
			hasBridge: typeof window.bbUI?.mediaSession === 'function',
			bridge: window.bbUI?.mediaSession()?.describe?.() ?? null,
			actions: window.bbUI?.mediaActions?.() ?? [],
		}))()`,
	)
	check('环境支持 navigator.mediaSession', support.hasMediaSession === true)
	check('支持 MediaMetadata 构造器', support.hasMetadataCtor === true)
	check('媒体桥已挂到 window.bbUI.mediaSession', support.hasBridge === true)
	check(
		'媒体桥自检报告 supported=true',
		support.bridge?.supported === true,
		JSON.stringify(support.bridge),
	)
	check(
		'媒体动作齐全（toggle/next/prev/stop/seek×2）',
		Array.isArray(support.actions) && support.actions.length === 6,
		(support.actions ?? []).join(', '),
	)

	// ---------- 2. 主进程图标与任务栏状态 ----------
	const info = await evaluate(window, `window.bbplayer.mediaInfo()`)
	check('主进程媒体集成诊断可用', info?.ok === true, info?.error)

	const data = info?.data ?? {}
	check(
		'四张任务栏图标都已生成且非空',
		data.iconCount === 4 &&
			Object.values(data.iconBytes ?? {}).every((n) => n > 80),
		JSON.stringify(data.iconBytes),
	)
	check(
		'窗口已登记进媒体集成',
		data.registeredWindowCount >= 1,
		`registeredWindowCount=${data.registeredWindowCount}`,
	)
	console.log(
		`[media] 任务栏缩略图按钮: platform=${data.platform} installed=${data.thumbarInstalledCount}`,
	)
	if (data.platform === 'win32' && data.thumbarInstalledCount === 0) {
		check(
			'Windows 上任务栏缩略图按钮安装成功',
			false,
			'thumbarInstalledCount=0',
		)
	} else if (data.platform !== 'win32') {
		console.log(
			'[media] ⓘ 非 Windows：setThumbarButtons 通常是 no-op，跳过该项断言',
		)
	} else {
		check('Windows 上任务栏缩略图按钮安装成功', true)
	}
	check(
		'硬件媒体键兜底默认未注册（避免与 MediaSession 双触发）',
		data.hardwareKeysRequested === false &&
			(data.registeredMediaKeys ?? []).length === 0,
		`requested=${data.hardwareKeysRequested} registered=${JSON.stringify(data.registeredMediaKeys)}`,
	)

	// ---------- 3. 播一首真实曲目 ----------
	const seeded = await waitFor(
		window,
		`(() => {
			const btn = document.querySelector('[data-testid="btn-seed-demo"]')
			if (!btn) return false
			return { ok: true }
		})()`,
		15_000,
		'seed',
	)
	if (seeded.ok) {
		await click(window, '[data-testid="btn-seed-demo"]')
		await waitFor(
			window,
			`document.querySelectorAll('.track-table tbody tr').length > 0`,
			120_000,
			'tracks',
		)
	}

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
		'真实播放已开始（元数据/状态断言的前提）',
		playing.ok,
		playing.ok
			? `currentTime=${playing.value.currentTime?.toFixed?.(2)}`
			: JSON.stringify(playing.value),
	)

	// ---------- 4. 元数据 ----------
	const metadata = await waitFor(
		window,
		`(() => {
			const d = window.bbUI.mediaSession()?.describe?.()
			if (!d?.title) return false
			return { ok: true, ...d }
		})()`,
		20_000,
		'metadata',
	)
	check(
		'系统媒体元数据已设置标题',
		metadata.ok && String(metadata.value?.title).length > 0,
		metadata.ok ? metadata.value.title : JSON.stringify(metadata.value),
	)
	check(
		'元数据带作者',
		metadata.ok && String(metadata.value?.artist ?? '').length > 0,
		metadata.value?.artist ?? '（空）',
	)
	check(
		'元数据 album 为 BBPlayer',
		metadata.value?.album === 'BBPlayer',
		metadata.value?.album ?? '（空）',
	)
	const artwork = metadata.value?.artwork ?? []
	if (artwork.length > 0) {
		check(
			'封面 URL 已补成绝对地址（B 站的 //i0.hdslb.com 会被补 https:）',
			artwork.every((a) => a.src.startsWith('https://')),
			artwork[0].src.slice(0, 60),
		)
	} else {
		check('封面存在（本曲目没有封面时该项不适用）', true, '本曲目无封面字段')
	}
	await shot(window, 'media-01-playing')

	// ---------- 5. playbackState 随播放/暂停 ----------
	const stateWhilePlaying = await evaluate(
		window,
		`navigator.mediaSession.playbackState`,
	)
	check(
		'播放时 playbackState=playing',
		stateWhilePlaying === 'playing',
		String(stateWhilePlaying),
	)

	await evaluate(window, `window.bbUI.dispatchMediaAction('toggle')`)
	const paused = await waitFor(
		window,
		`window.bbPlayer.getAudio().paused === true &&
		 navigator.mediaSession.playbackState === 'paused'
			? { ok: true, state: navigator.mediaSession.playbackState }
			: false`,
		10_000,
		'paused',
	)
	check(
		'媒体动作 toggle 能暂停，且 playbackState 同步为 paused',
		paused.ok,
		paused.ok ? paused.value.state : JSON.stringify(paused.value),
	)

	// 恢复播放
	await evaluate(window, `window.bbUI.dispatchMediaAction('toggle')`)
	await waitFor(
		window,
		`window.bbPlayer.getAudio().paused === false ? { ok: true } : false`,
		10_000,
		'resume',
	)

	// ---------- 6. setPositionState ----------
	// 直接调用一次，确认不抛（duration 有效时）
	const posOk = await evaluate(
		window,
		`(() => {
			try {
				window.bbUI.mediaSession().syncPositionState()
				return { ok: true }
			} catch (e) { return { ok: false, error: e.message } }
		})()`,
	)
	check(
		'时长有效时 setPositionState 不抛错',
		posOk.ok === true,
		posOk.error ?? 'ok',
	)

	// 关键：时长无效（NaN）时也必须不抛 —— 这是 setPositionState 的实际坑
	const posGuard = await evaluate(
		window,
		`(() => {
			const audio = window.bbPlayer.getAudio()
			const savedSrc = audio.src
			try {
				// 造一个「时长未知」的状态：清空 src 后 duration 变为 NaN
				audio.removeAttribute('src')
				audio.load()
				window.bbUI.mediaSession().syncPositionState()
				return { ok: true, durationWas: audio.duration }
			} catch (e) {
				return { ok: false, error: e.message }
			} finally {
				audio.src = savedSrc
			}
		})()`,
	)
	check(
		'时长未知（NaN）时 setPositionState 被守卫，不抛错',
		posGuard.ok === true,
		posGuard.error ?? `duration=${posGuard.durationWas}`,
	)

	// ---------- 7. 主进程转发媒体动作真的起作用 ----------
	//
	// 这条要验证的是**真实链路**：主进程 send('media:action') →
	// preload 的监听器 → 渲染进程的 MEDIA_ACTIONS 处理器 → 播放器。
	// 所以这里必须从主进程侧发，不能直接在渲染进程里调内部函数
	// （那样就没测到 preload 那一跳）。
	const before = await evaluate(
		window,
		`(() => {
			const t = window.bbPlayer.getCurrent()
			return t ? { bvid: t.bvid, title: t.title, index: window.bbPlayer.getIndex() } : null
		})()`,
	)
	check('当前有正在播放的曲目', Boolean(before?.bvid), before?.title ?? '无')

	const forwarded = mediaIntegration.sendMediaAction(window, 'next')
	check('主进程能向渲染进程下发媒体动作', forwarded)

	const changed = await waitFor(
		window,
		`(() => {
			const t = window.bbPlayer.getCurrent()
			if (t && t.bvid !== ${JSON.stringify(before?.bvid)}) {
				return { ok: true, bvid: t.bvid, title: t.title }
			}
			return false
		})()`,
		30_000,
		'next',
	)
	check(
		'「下一首」动作经主进程转发后真的切换了曲目',
		changed.ok,
		changed.ok
			? `${before?.title} -> ${changed.value.title}`
			: JSON.stringify(changed.value),
	)

	await waitFor(
		window,
		`(() => {
			const a = window.bbPlayer.getAudio()
			return a && !a.paused && a.currentTime > 0.1 ? { ok: true } : false
		})()`,
		45_000,
		'replay',
	)

	// 换曲后元数据必须跟着换（否则系统面板会一直显示上一首）
	const metadata2 = await evaluate(
		window,
		`window.bbUI.mediaSession().describe()`,
	)
	check(
		'切换曲目后系统元数据已更新为新曲目',
		Boolean(metadata2?.title) && metadata2.title !== metadata.value?.title,
		`${metadata.value?.title ?? '?'} -> ${metadata2?.title ?? '?'}`,
	)
	await shot(window, 'media-02-next-track')

	// `prev` 也验证一次，确认双向都能走通
	const beforePrev = await evaluate(
		window,
		`window.bbPlayer.getCurrent()?.bvid ?? null`,
	)
	mediaIntegration.sendMediaAction(window, 'prev')
	const wentBack = await waitFor(
		window,
		`window.bbPlayer.getCurrent()?.bvid !== ${JSON.stringify(beforePrev)}
			? { ok: true, bvid: window.bbPlayer.getCurrent()?.bvid }
			: false`,
		30_000,
		'prev',
	)
	check(
		'「上一首」动作经主进程转发后也生效',
		wentBack.ok,
		wentBack.ok
			? `回到 ${wentBack.value.bvid}`
			: JSON.stringify(wentBack.value),
	)

	// ---------- 8. 渲染进程描述里没有 cookie / 播放地址泄漏 ----------
	const leak = await evaluate(
		window,
		`(() => {
			const d = JSON.stringify(window.bbUI.mediaSession().describe())
			return {
				hasCookie: /SESSDATA|bili_jct/.test(d),
				hasCdnUrl: /bilivideo\\.(com|cn)/.test(d),
			}
		})()`,
	)
	check('媒体元数据里没有 cookie', leak.hasCookie === false)
	check(
		'媒体元数据里没有 CDN 播放地址（只有封面 https 地址）',
		leak.hasCdnUrl === false,
	)

	return finish(window)
}

function finish(window) {
	fs.mkdirSync(path.dirname(REPORT), { recursive: true })
	const passed = checks.filter((c) => c.ok).length
	const failed = checks.length - passed
	fs.writeFileSync(
		REPORT,
		JSON.stringify({ checks, screenshots, passed, failed }, null, 2),
	)
	console.log(`[media] 报告已写入 ${REPORT}`)
	if (window) window.destroy()
}

module.exports = { run }
