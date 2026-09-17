/**
 * MediaSession：系统媒体键、任务栏缩略图按钮、SMTC/MPRIS 元数据。
 *
 * ## 为什么走渲染进程的 `navigator.mediaSession`
 *
 * Electron 是 Chromium，`navigator.mediaSession` 在 Windows 上直接对接
 * **SMTC**（System Media Transport Controls），在 Linux 上对接 **MPRIS**
 * （Chromium 通过 D-Bus 暴露）。这意味着媒体键、锁屏/系统面板上的封面与
 * 标题、以及「在这台设备上播放」面板**都不需要我们写原生代码**。
 *
 * 唯一要注意的：Electron 默认可能把这些按键吃在应用菜单的快捷键上，
 * 因此启动时调 `webContents.setIgnoreMenuShortcuts(true)` 把它们让给
 * MediaSession。
 *
 * ## 分两层，避免互相打架
 *
 * 1. **主路径**：渲染进程的 MediaSession（`navigator.mediaSession`）。
 *    系统层面统一，兼容第三方媒体控制软件。
 * 2. **兜底路径**：主进程 `globalShortcut` 注册 `MediaPlayPause` 等。
 *    **默认关闭** —— 它和 MediaSession 同时生效会导致一次按键触发两次
 *    （播放→暂停→播放，表现为「按了没反应」）。只在
 *    `BBPLAYER_MEDIA_KEYS=global` 时启用，用于排查「MediaSession 收不到键」。
 *
 * `globalShortcut` 在 **Wayland 上通常不生效**（Chromium 的已知限制），
 * 这也是把兜底路径设为可选、而不是主路径的原因之一。
 */
;(function () {
	'use strict'

	/** MediaSession 的 action 名 -> 我们的处理器 */
	const ACTIONS = [
		'play',
		'pause',
		'previoustrack',
		'nexttrack',
		'seekbackward',
		'seekforward',
		'seekto',
		'stop',
	]

	/** 默认快进/快退步长（秒）；`setPositionState` 与硬件键都用它 */
	const SEEK_STEP = 10

	function createMediaSessionBridge({ player, log = () => {} }) {
		const supported =
			typeof navigator !== 'undefined' && 'mediaSession' in navigator
		/**
		 * 上次设置过的元数据指纹，用来跳过重复设置。
		 *
		 * ⚠️ 第一版只比较**封面 URL**，于是「连续两首都没有封面」时
		 * `null === null` 成立，直接 return —— 系统面板会一直显示第一首的
		 * 标题。这个 bug 由 `verify-desktop-media.mjs` 的
		 * 「切换曲目后系统元数据已更新」断言抓到。
		 * 指纹必须覆盖标题/作者/封面三项，缺一不可。
		 */
		let lastMetadataKey = null
		let hardwareKeysInstalled = false

		// -----------------------------------------------------------
		// 元数据
		// -----------------------------------------------------------

		/**
		 * 把封面 URL 补成绝对地址。
		 *
		 * B 站的 `pic` 有时是 `//i0.hdslb.com/...`（协议相对），
		 * `MediaMetadata` 需要绝对 URL，否则会被忽略（静默不显示封面）。
		 */
		function absoluteArtwork(url) {
			if (!url) return null
			if (url.startsWith('//')) return `https:${url}`
			if (/^https?:/.test(url)) return url
			return null
		}

		/**
		 * 更新系统面板上的曲目信息。
		 *
		 * `MediaMetadata` 的 `artwork` 尺寸声明很重要：Chromium 会用
		 * `sizes` 选一张合适的图，不声明的话某些系统面板不显示封面。
		 */
		function setMetadata(track) {
			if (!supported || !track) return

			const artwork = absoluteArtwork(track.cover)
			const title = track.title || '未知标题'
			const artist = track.artist || track.artist_name || '未知作者'

			// 指纹覆盖标题/作者/封面 —— 只看封面会让「连续两首都没封面」
			// 被误判成「没变化」而跳过更新（见上面的说明）。
			const key = `${title}\u0000${artist}\u0000${artwork ?? ''}`
			if (key === lastMetadataKey && navigator.mediaSession.metadata) {
				return
			}
			lastMetadataKey = key

			navigator.mediaSession.metadata = new MediaMetadata({
				title,
				artist,
				album: 'BBPlayer',
				artwork: artwork
					? [
							{ src: artwork, sizes: '512x512', type: 'image/jpeg' },
							{ src: artwork, sizes: '256x256', type: 'image/jpeg' },
						]
					: [],
			})
			log(`已更新系统媒体元数据：${title}`)
		}

		// -----------------------------------------------------------
		// 播放状态 / 进度
		// -----------------------------------------------------------

		function syncPlaybackState() {
			if (!supported) return
			const audio = player.getAudio()
			navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing'
		}

		/**
		 * 上报进度，供系统面板画进度条并支持拖动。
		 *
		 * `setPositionState` 在 duration 为 NaN/Infinity/0 时会**抛错**
		 * （这是规范要求），所以必须先过滤 —— 直接调用会在曲目刚加载、
		 * 时长未知时不断抛异常。
		 */
		function syncPositionState() {
			if (!supported) return
			const audio = player.getAudio()
			const { duration, currentTime } = audio
			if (
				!Number.isFinite(duration) ||
				duration <= 0 ||
				!Number.isFinite(currentTime)
			) {
				return
			}
			try {
				navigator.mediaSession.setPositionState({
					duration,
					playbackRate: audio.playbackRate || 1,
					position: Math.min(Math.max(currentTime, 0), duration),
				})
			} catch {
				// 极少数边界（如 seek 到尾后 currentTime 略大于 duration）会抛，
				// 下一帧会重新上报，忽略即可
			}
		}

		// -----------------------------------------------------------
		// action handler
		// -----------------------------------------------------------

		function installActionHandlers() {
			if (!supported) return

			/** 统一的注册包装：不支持某个 action 时静默跳过 */
			const set = (action, handler) => {
				try {
					navigator.mediaSession.setActionHandler(action, handler)
				} catch (error) {
					// 不支持的 action 会抛 TypeError，属于预期（例如 Linux 上
					// 某些 action 未实现），不影响其它 action
					log(`MediaSession action「${action}」不可用：${error.message}`)
				}
			}

			set('play', () => {
				void player.play()
			})
			set('pause', () => {
				player.pause()
			})
			set('previoustrack', () => {
				void player.playPrev()
			})
			set('nexttrack', () => {
				void player.playNext(false)
			})
			set('seekbackward', (details) => {
				player.seekBy(-(details?.seekOffset || SEEK_STEP))
			})
			set('seekforward', (details) => {
				player.seekBy(details?.seekOffset || SEEK_STEP)
			})
			set('seekto', (details) => {
				if (typeof details?.seekTime === 'number') {
					player.seekTo(details.seekTime)
				}
			})
			// `stop` 在桌面上语义模糊（既不退出应用也不清队列），
			// 统一映射为「暂停并把进度归零」，与移动端的停止行为一致
			set('stop', () => {
				player.pause()
				player.seekTo(0)
			})

			log(`已注册 ${ACTIONS.length} 个 MediaSession action`)
		}

		// -----------------------------------------------------------
		// 硬件媒体键兜底（默认关闭）
		// -----------------------------------------------------------

		/**
		 * `navigator.mediaSession` 收不到媒体键时的手动兜底。
		 *
		 * 只在 `BBPLAYER_MEDIA_KEYS=global` 时启用（见文件头注释：
		 * 与 MediaSession 同时生效会双触发）。
		 */
		async function installHardwareKeyFallback() {
			if (!window.bbplayer?.setMediaKeysEnabled) return false
			try {
				const result = await window.bbplayer.setMediaKeysEnabled(true)
				if (result?.ok && result.data?.registered?.length > 0) {
					hardwareKeysInstalled = true
					log(`硬件媒体键兜底已启用：${result.data.registered.join(', ')}`)
					return true
				}
				log(`硬件媒体键兜底未生效：${result?.error ?? '无可用按键'}`)
			} catch (error) {
				log(`硬件媒体键兜底失败：${error.message}`)
			}
			return false
		}

		// -----------------------------------------------------------
		// 接线
		// -----------------------------------------------------------

		const audio = player.getAudio()

		audio.addEventListener('play', () => {
			syncPlaybackState()
			syncPositionState()
		})
		audio.addEventListener('pause', syncPlaybackState)
		// timeupdate 频率约 4Hz，足够驱动系统进度条且开销可忽略
		audio.addEventListener('timeupdate', syncPositionState)
		// 元数据就绪后才有时长可上报
		audio.addEventListener('loadedmetadata', syncPositionState)
		audio.addEventListener('durationchange', syncPositionState)

		player.on((event) => {
			if (event.type === 'track-changed') {
				setMetadata(event.track)
				syncPlaybackState()
				syncPositionState()
			}
		})

		installActionHandlers()
		syncPlaybackState()

		// 当前已在播放的曲目（如果 MediaSession 是在播放后装上的）
		const current = player.getCurrent()
		if (current) setMetadata(current)

		// 渲染进程无法自己判断「媒体键走哪条路」—— 由主进程通过
		// `window.bbplayer.mediaInfo()` 告知（启动参数里带 `--media-keys` 时
		// 才启用 globalShortcut 兜底，见 media-integration.cjs 的说明）。
		void (async () => {
			try {
				const info = await window.bbplayer?.mediaInfo?.()
				if (info?.ok && info.data?.hardwareKeysRequested) {
					await installHardwareKeyFallback()
				}
			} catch (error) {
				log(`读取媒体键配置失败：${error.message}`)
			}
		})()

		return {
			supported,
			setMetadata,
			syncPlaybackState,
			syncPositionState,
			hardwareKeysInstalled: () => hardwareKeysInstalled,
			/** 供自动化断言：系统当前看到的元数据 */
			describe() {
				if (!supported) return { supported: false }
				const md = navigator.mediaSession.metadata
				return {
					supported: true,
					playbackState: navigator.mediaSession.playbackState,
					title: md?.title ?? null,
					artist: md?.artist ?? null,
					album: md?.album ?? null,
					artwork: (md?.artwork ?? []).map((a) => ({
						src: a.src,
						sizes: a.sizes,
					})),
				}
			},
		}
	}

	window.createMediaSessionBridge = createMediaSessionBridge
})()
