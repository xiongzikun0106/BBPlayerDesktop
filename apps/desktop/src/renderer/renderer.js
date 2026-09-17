/**
 * 渲染进程：B 站音频播放验证界面。
 *
 * 关键点：音频走 `bbplayer-audio://` 自定义协议（主进程代理），
 * 而不是直接指向 CDN —— 因为主线 CDN 有防盗链且不发 CORS 头。
 *
 * 同时暴露 `window.bbTest`，让自动化脚本能「点击级」驱动播放并断言状态。
 */

const els = {
	bvid: document.getElementById('bvid'),
	load: document.getElementById('load'),
	status: document.getElementById('status'),
	audio: document.getElementById('audio'),
	play: document.getElementById('play'),
	pause: document.getElementById('pause'),
	progress: document.getElementById('progress'),
	time: document.getElementById('time'),
	log: document.getElementById('log'),
	title: document.getElementById('m-title'),
	cid: document.getElementById('m-cid'),
	duration: document.getElementById('m-duration'),
	quality: document.getElementById('m-quality'),
	host: document.getElementById('m-host'),
	proxy: document.getElementById('m-proxy'),
}

/** 事件计数：用于断言「确实发生了网络/解码活动」 */
const counters = {
	loadstart: 0,
	durationchange: 0,
	loadedmetadata: 0,
	progress: 0,
	canplay: 0,
	playing: 0,
	play: 0,
	pause: 0,
	seeking: 0,
	seeked: 0,
	waiting: 0,
	stalled: 0,
	error: 0,
	ended: 0,
}

/** 已解码的字节区间（来自 buffered），能证明 Range 请求生效 */
function bufferedRanges() {
	const audio = els.audio
	const ranges = []
	try {
		for (let i = 0; i < audio.buffered.length; i++) {
			ranges.push([audio.buffered.start(i), audio.buffered.end(i)])
		}
	} catch {
		// buffered 在未就绪时可能抛错，忽略
	}
	return ranges
}

function describeError() {
	const error = els.audio.error
	if (!error) return null
	const names = {
		1: 'MEDIA_ERR_ABORTED',
		2: 'MEDIA_ERR_NETWORK',
		3: 'MEDIA_ERR_DECODE',
		4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
	}
	return {
		code: error.code,
		name: names[error.code] ?? `UNKNOWN(${error.code})`,
		message: error.message ?? null,
	}
}

let lastResolved = null

function log(message) {
	const line = `[${new Date().toLocaleTimeString()}] ${message}`
	els.log.textContent += `${line}\n`
	els.log.scrollTop = els.log.scrollHeight
}

function setStatus(text, kind = 'idle') {
	els.status.textContent = text
	els.status.className = `status status--${kind}`
}

function formatTime(seconds) {
	if (!Number.isFinite(seconds)) return '0.00'
	return seconds.toFixed(2)
}

function updateTimeDisplay() {
	els.time.textContent = `${formatTime(els.audio.currentTime)} / ${formatTime(els.audio.duration)}`
	if (Number.isFinite(els.audio.duration) && els.audio.duration > 0) {
		els.progress.value = String(
			Math.round((els.audio.currentTime / els.audio.duration) * 1000),
		)
	}
}

// ---------------------------------------------------------------
// 事件绑定：记录 + 更新 UI
// ---------------------------------------------------------------

for (const name of Object.keys(counters)) {
	els.audio.addEventListener(name, () => {
		counters[name] += 1
		if (name === 'error') {
			const error = describeError()
			log(
				`error: ${error ? `${error.name} ${error.message ?? ''}` : 'unknown'}`,
			)
			setStatus(`播放失败：${error?.name ?? '未知错误'}`, 'bad')
		} else if (name === 'playing') {
			setStatus('正在播放', 'ok')
		} else if (name === 'loadedmetadata') {
			setStatus('元数据已加载', 'ok')
		}
		updateTimeDisplay()
	})
}

els.audio.addEventListener('timeupdate', updateTimeDisplay)

// ---------------------------------------------------------------
// 交互
// ---------------------------------------------------------------

async function loadAndPlay(bvid) {
	counters.error = 0
	setStatus('正在解析音频地址…', 'busy')
	log(`解析 ${bvid}`)

	const resolved = await window.bbplayer.resolveAudio(bvid)
	if (!resolved.ok) {
		setStatus(`解析失败：${resolved.error}`, 'bad')
		log(`解析失败：${resolved.error}`)
		return null
	}

	lastResolved = resolved.data
	els.title.textContent = resolved.data.title
	els.cid.textContent = String(resolved.data.cid)
	els.duration.textContent = `${resolved.data.duration}s`
	els.quality.textContent = String(resolved.data.quality)
	els.host.textContent = resolved.data.upstreamHost
	els.proxy.textContent = resolved.data.proxyUrl

	log(
		`上游 CDN: ${resolved.data.upstreamHost}（backupUrl ${resolved.data.backupUrlCount} 个）`,
	)
	log(`代理地址: ${resolved.data.proxyUrl}`)

	// 关键：src 指向自定义协议，由主进程注入 Referer/UA 并流式回传
	els.audio.src = resolved.data.proxyUrl
	els.audio.load()
	setStatus('已加载，等待播放', 'ok')

	return resolved.data
}

els.load.addEventListener('click', () => {
	void loadAndPlay(els.bvid.value.trim())
})

els.play.addEventListener('click', () => {
	void els.audio.play().catch((error) => {
		setStatus(`play() 被拒绝：${error.message}`, 'bad')
	})
})

els.pause.addEventListener('click', () => {
	els.audio.pause()
})

for (const button of document.querySelectorAll('[data-seek]')) {
	button.addEventListener('click', () => {
		els.audio.currentTime = Number(button.dataset.seek)
	})
}

els.progress.addEventListener('input', () => {
	if (Number.isFinite(els.audio.duration) && els.audio.duration > 0) {
		els.audio.currentTime =
			(Number(els.progress.value) / 1000) * els.audio.duration
	}
})

// ---------------------------------------------------------------
// 自验证接口（供自动化脚本调用）
// ---------------------------------------------------------------

window.bbTest = {
	/** 完整状态快照 */
	state() {
		return {
			readyState: els.audio.readyState,
			networkState: els.audio.networkState,
			duration: els.audio.duration,
			currentTime: els.audio.currentTime,
			paused: els.audio.paused,
			ended: els.audio.ended,
			src: els.audio.src,
			error: describeError(),
			buffered: bufferedRanges(),
			counters: { ...counters },
			resolved: lastResolved
				? {
						bvid: lastResolved.bvid,
						title: lastResolved.title,
						upstreamHost: lastResolved.upstreamHost,
						proxyUrl: lastResolved.proxyUrl,
					}
				: null,
			status: els.status.textContent,
		}
	},

	/** 点「解析并加载」按钮，等元数据就绪 */
	async load(bvid) {
		if (bvid) els.bvid.value = bvid
		const info = await loadAndPlay(els.bvid.value.trim())
		if (!info) return { ok: false, error: 'resolve failed' }

		const ok = await waitFor(() => els.audio.readyState >= 1, 15000)
		return {
			ok,
			readyState: els.audio.readyState,
			duration: els.audio.duration,
			error: describeError(),
		}
	},

	/** 点「播放」按钮，等到确实开始播放 */
	async play() {
		els.play.click()
		const ok = await waitFor(
			() => !els.audio.paused && els.audio.currentTime > 0,
			15000,
		)
		return {
			ok,
			currentTime: els.audio.currentTime,
			paused: els.audio.paused,
			error: describeError(),
		}
	},

	/** 暂停 */
	pause() {
		els.pause.click()
		return { paused: els.audio.paused }
	},

	/** 通过点击「跳到 Ns」按钮做 seek，并等待 seeked 事件 */
	async seek(seconds) {
		const before = els.audio.currentTime
		const seekedBefore = counters.seeked
		els.audio.currentTime = seconds
		const ok = await waitFor(() => counters.seeked > seekedBefore, 10000)
		return {
			ok,
			before,
			after: els.audio.currentTime,
			seekedEvents: counters.seeked - seekedBefore,
			error: describeError(),
		}
	},

	/** 让播放走一段时间，用于确认时间确实在推进 */
	async advance(ms) {
		const start = els.audio.currentTime
		await new Promise((resolve) => setTimeout(resolve, ms))
		return {
			start,
			end: els.audio.currentTime,
			advanced: els.audio.currentTime - start,
		}
	},

	/** DOM 里可见的按钮文案，用于确认 UI 真的渲染出来了 */
	buttons() {
		return [...document.querySelectorAll('button')].map((b) => b.textContent)
	},

	log() {
		return els.log.textContent
	},
}

/** 轮询等待条件成立 */
function waitFor(predicate, timeoutMs) {
	return new Promise((resolve) => {
		const start = Date.now()
		const tick = () => {
			let ok = false
			try {
				ok = Boolean(predicate())
			} catch {
				ok = false
			}
			if (ok) return resolve(true)
			if (Date.now() - start > timeoutMs) return resolve(false)
			setTimeout(tick, 100)
		}
		tick()
	})
}

log('渲染进程就绪，等待解析')
window.__bbReady = true
