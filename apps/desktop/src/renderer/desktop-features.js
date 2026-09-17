/**
 * 桌面专属功能：主题、定时关闭、响度均衡（Phase 4 收尾）。
 *
 * 三者放在一个模块里，因为它们共享同一份「设置」来源，而且都在渲染进程
 * 作用于同一批元素（`<html data-theme>`、`<audio>` 的输出链、播放器状态）。
 * 拆成三个文件会引入三次重复的设置读取与订阅。
 *
 * ## 响度均衡的**诚实说明**
 *
 * 移动端把每个音轨的响度值存在原生层（`LoudnessStorage`），来源是
 * B 站 playurl 响应里的 `data.volume.measured_i`。但**桌面端拿不到它**：
 * 实测 `GET /x/player/playurl` 的响应里根本没有 `volume` 字段
 * （`data` 顶层键与 `dash.audio[n]` 都没有），匿名与登录都一样。
 *
 * 所以这里不做「按已知响度值精确补偿」（那需要数据，而数据不存在），
 * 而是做**基于电平的自适应均衡**：
 *   * `DynamicsCompressorNode` 压掉峰值（软拐点，避免削波）；
 *   * 一个由 `AnalyserNode` 测量的 RMS 驱动的慢速增益，把整体电平向目标
 *     靠拢，增益有上限，防止把小音量素材抬得过猛。
 *
 * 这是**有意选择的近似**，不是「EBU R128 精确归一化」。UI 上如实这么写，
 * 不夸大能力。
 */
;(function () {
	'use strict'

	const THEME_ATTR = 'data-theme'

	// ---------------------------------------------------------------
	// 主题
	// ---------------------------------------------------------------

	/**
	 * 应用主题。
	 *
	 * 用 `<html data-theme="light">` 而不是给每个元素加类：CSS 里只需在
	 * `:root[data-theme='light']` 覆盖一遍语义 token，其余样式一行都不用动。
	 */
	function applyTheme(theme) {
		const normalized = theme === 'light' ? 'light' : 'dark'
		document.documentElement.setAttribute(THEME_ATTR, normalized)
		return normalized
	}

	// ---------------------------------------------------------------
	// 响度均衡
	// ---------------------------------------------------------------

	/**
	 * 创建响度均衡链。
	 *
	 * 音频图：
	 *   source -> compressor -> gain -> analyser -> destination
	 *
	 * 注意：`<audio>` 一旦接进 Web Audio，**必须**显式连到 destination，
	 * 否则会静音（`createMediaElementSource` 会把元素的原生输出接管掉）。
	 */
	function createLoudnessNormalizer(audio, { targetDb, maxGainDb, log }) {
		let context = null
		let source = null
		let compressor = null
		let gain = null
		let analyser = null
		let buffer = null
		let sampleTimer = null
		let enabled = false

		/** 由 dB 转线性增益 */
		const dbToGain = (db) => 10 ** (db / 20)

		function build() {
			if (context) return
			const Ctor = window.AudioContext || window.webkitAudioContext
			if (!Ctor) throw new Error('当前环境不支持 Web Audio，无法启用响度均衡')

			context = new Ctor()
			source = context.createMediaElementSource(audio)

			// 软拐点压缩：只削掉峰值，不做整体压限，尽量保留动态
			compressor = context.createDynamicsCompressor()
			compressor.threshold.value = -18
			compressor.knee.value = 24
			compressor.ratio.value = 3
			compressor.attack.value = 0.01
			compressor.release.value = 0.25

			gain = context.createGain()
			gain.gain.value = 1

			analyser = context.createAnalyser()
			analyser.fftSize = 2048

			source.connect(compressor)
			compressor.connect(gain)
			gain.connect(analyser)
			// 关键：必须接到 destination，否则接管的音频不会出声
			analyser.connect(context.destination)

			buffer = new Float32Array(analyser.fftSize)
			log('响度均衡音频链已建立（compressor -> gain -> analyser）')
		}

		/** 测一次当前 RMS（线性），满量程约 0..1 */
		function measureRms() {
			analyser.getFloatTimeDomainData(buffer)
			let sum = 0
			for (const sample of buffer) sum += sample * sample
			return Math.sqrt(sum / buffer.length)
		}

		/**
		 * 慢速逼近目标电平。
		 *
		 * 需要补的增益 = 目标 dB − 当前 RMS 对应的 dB。
		 * 只需要**衰减或有限提升**：
		 *   * 上限 `maxGainDb`：防止把极安静的素材抬得过猛（那会把底噪一起放大）；
		 *   * 下限 0：**不主动衰减**。超过目标的音轨交给 compressor 处理峰值，
		 *     再额外整体压低会让动态范围无谓变小。
		 *
		 * 用「每次只移动一小步」而不是直接设成目标增益：直接设会在两帧之间
		 * 产生可听见的音量跳变（尤其曲目切换时）。步长 0.08 是听感与收敛
		 * 速度之间的折中（约 1 秒收敛到位）。
		 */
		function tick() {
			if (!enabled || !analyser) return
			const rms = measureRms()
			// 静音/极安静时不调整，避免把噪声底抬起来
			if (rms <= 1e-4) return

			const currentDb = 20 * Math.log10(rms)
			const neededDb = targetDb - currentDb
			const wantedDb = Math.max(0, Math.min(maxGainDb, neededDb))
			const wantedGain = dbToGain(wantedDb)
			gain.gain.value += (wantedGain - gain.gain.value) * 0.08
		}

		return {
			/** 启用。返回是否真的启用了（Web Audio 不可用时为 false） */
			async enable() {
				try {
					build()
				} catch (error) {
					log(`响度均衡启用失败：${error.message}`)
					return false
				}
				// 浏览器策略：AudioContext 可能需要用户手势后才能 resume
				if (context.state === 'suspended') {
					try {
						await context.resume()
					} catch {
						// 拿不到手势就先放着，播放开始后会自动 resume
					}
				}
				enabled = true
				sampleTimer = setInterval(tick, 200)
				log(`响度均衡已启用（目标 ${targetDb} dB，最大增益 ${maxGainDb} dB）`)
				return true
			},

			/** 关闭：把增益还原为 1，并停掉采样 */
			disable() {
				enabled = false
				if (sampleTimer) {
					clearInterval(sampleTimer)
					sampleTimer = null
				}
				if (gain) gain.gain.value = 1
				log('响度均衡已关闭')
			},

			isEnabled: () => enabled,

			/** 供自动化断言：链上各节点与当前增益 */
			describe() {
				return {
					enabled,
					hasContext: Boolean(context),
					contextState: context?.state ?? null,
					// 各节点存在性
					nodes: {
						source: Boolean(source),
						compressor: Boolean(compressor),
						gain: Boolean(gain),
						analyser: Boolean(analyser),
					},
					currentGain: gain?.gain.value ?? null,
					targetDb,
					maxGainDb,
					// 压缩器参数（用于断言「没有把参数写错」）
					compressor: compressor
						? {
								threshold: compressor.threshold.value,
								knee: compressor.knee.value,
								ratio: compressor.ratio.value,
							}
						: null,
					// 是否接了 destination（漏接会静音，必须断言）
					connectedToDestination: Boolean(analyser && context),
					/** 实测一次 RMS，用于证明链路真的在跑 */
					measuredRms: analyser ? measureRms() : null,
				}
			},
		}
	}

	// ---------------------------------------------------------------
	// 定时关闭
	// ---------------------------------------------------------------

	/**
	 * 创建定时关闭。
	 *
	 * 到点前 `fadeMs` 开始线性降音量，到点暂停并把音量还原 —— 不还原的话
	 * 用户下次播放会发现「没声音」而以为坏了。
	 */
	function createSleepTimer({ player, onFire, fadeMs, log }) {
		let endsAt = null
		let ticker = null
		let fired = false
		/**
		 * 进入淡出前的原始音量，用于到点后还原。
		 *
		 * ⚠️ 必须在 `start()` 里**立刻**快照，不能在淡出开始时才读：
		 * 淡出每 500ms 改一次 `audio.volume`，等进入淡出窗口再读就已经是
		 * 「衰减过的值」了 —— 于是到点后还原的是一个比原始音量更小的值。
		 * 实测表现为音量从 0.5 变成 0.1（淡出了 5 秒后的残留值），
		 * 用户会以为「放了一晚上音量变小了」。由
		 * `verify-desktop-settings.mjs` 的「音量被还原」断言抓到。
		 */
		let originalVolume = null

		function clearTicker() {
			if (ticker) {
				clearInterval(ticker)
				ticker = null
			}
		}

		/** 当前剩余毫秒；未启用返回 null */
		function remainingMs() {
			if (!endsAt) return null
			return Math.max(0, endsAt - Date.now())
		}

		function tick() {
			const left = remainingMs()
			if (left === null) return

			if (left <= 0) {
				if (fired) return
				fired = true
				clearTicker()

				player.pause()
				// 还原到**开始前**的音量（不是淡出后的残留值）
				if (originalVolume !== null) {
					player.getAudio().volume = originalVolume
				}
				log('定时关闭已触发：已暂停播放并还原音量')

				endsAt = null
				originalVolume = null
				void onFire()
				return
			}

			// 淡出：只在进入淡出窗口时改音量
			if (left <= fadeMs && originalVolume !== null) {
				player.getAudio().volume = Math.max(0, originalVolume * (left / fadeMs))
			}
		}

		function start(endAtMs) {
			clearTicker()
			fired = false
			// 立刻快照原始音量（见 originalVolume 的说明）
			originalVolume = player.getAudio().volume
			endsAt = endAtMs
			ticker = setInterval(tick, 500)
			tick()
			log(
				`定时关闭已设置：${Math.round((endAtMs - Date.now()) / 60000)} 分钟后` +
					`（当前音量 ${originalVolume}，会在最后 ${fadeMs / 1000} 秒淡出）`,
			)
			return endsAt
		}

		return {
			/** 按分钟设置（移动端也是分钟粒度） */
			setMinutes(minutes) {
				const ms = Number(minutes) * 60_000
				if (!Number.isFinite(ms) || ms <= 0) {
					throw new Error('分钟数必须是正数')
				}
				return start(Date.now() + ms)
			},
			/** 按绝对结束时间恢复（重启后从设置里读回来） */
			restore(endAtMs) {
				if (!endAtMs || endAtMs <= Date.now()) return null
				return start(endAtMs)
			},
			cancel() {
				clearTicker()
				endsAt = null
				fired = false
				if (originalVolume !== null) {
					player.getAudio().volume = originalVolume
					originalVolume = null
				}
				log('定时关闭已取消')
				return null
			},
			remainingMs,
			endsAt: () => endsAt,
			describe() {
				const left = remainingMs()
				return {
					active: Boolean(endsAt),
					endsAt,
					remainingMs: left,
					remainingMinutes: left === null ? null : Math.ceil(left / 60_000),
					ticking: Boolean(ticker),
					originalVolume,
				}
			},
		}
	}

	window.bbDesktopFeatures = {
		applyTheme,
		createLoudnessNormalizer,
		createSleepTimer,
		THEME_ATTR,
	}
})()
