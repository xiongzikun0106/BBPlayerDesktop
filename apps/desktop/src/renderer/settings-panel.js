/**
 * 设置面板（Phase 4 收尾）：下载 / 备份与 WebDAV / 主题 / 定时关闭 / 响度均衡。
 *
 * ## 为什么用侧滑抽屉而不是弹窗
 *
 * 设置项里有需要**边看边操作**的内容（下载任务进度、备份列表），
 * 居中弹窗会挡住播放条与队列。侧滑抽屉占据右半屏，主界面仍可见可操作。
 *
 * ## 长任务必须显示进度且可离开
 *
 * 上传备份、下载备份、批量下载都可能跑几十秒。这些操作**不阻塞**面板：
 * 状态文本写在各自那一行，用户可以关掉面板去做别的（主进程继续跑）。
 */
;(function () {
	'use strict'

	const els = {
		/**
		 * 设置现在是**一级页面**（阶段 3），不再是右侧抽屉。
		 * 导航模型是「分类列表 → 子页」，与移动端一致。
		 */
		view: document.getElementById('view-settings'),
		open: document.getElementById('settings-open'),
		categories: document.getElementById('settings-categories'),
		panelsBox: document.getElementById('settings-panels'),
		categoryButtons: document.querySelectorAll('[data-settings-category]'),
		back: document.getElementById('settings-back'),
		back2: document.getElementById('settings-close'),
		/**
		 * 分类名列表（用于校验 `switchCategory` 收到的是个真分类）。
		 *
		 * 刻意不叫 `tabs`：那会把"页签"的心智留在代码里，
		 * 而现在的模型是"分类列表 → 子页"。
		 */
		categoryKeys: [...document.querySelectorAll('[data-settings-panel]')].map(
			(el) => el.dataset.settingsPanel,
		),
		panels: document.querySelectorAll('[data-settings-panel]'),

		// 下载
		downloadDir: document.getElementById('settings-download-dir'),
		downloadParallel: document.getElementById('settings-download-parallel'),
		downloadOpen: document.getElementById('settings-download-open'),
		downloadRefresh: document.getElementById('settings-download-refresh'),
		downloadTasks: document.getElementById('settings-download-tasks'),
		downloadList: document.getElementById('settings-download-list'),
		downloadStatus: document.getElementById('settings-download-status'),

		// 备份
		webdavUrl: document.getElementById('settings-webdav-url'),
		webdavUser: document.getElementById('settings-webdav-user'),
		webdavPassword: document.getElementById('settings-webdav-password'),
		webdavDirectory: document.getElementById('settings-webdav-directory'),
		webdavSave: document.getElementById('settings-webdav-save'),
		webdavTest: document.getElementById('settings-webdav-test'),
		webdavUpload: document.getElementById('settings-webdav-upload'),
		webdavRefresh: document.getElementById('settings-webdav-refresh'),
		backupExport: document.getElementById('settings-backup-export'),
		backupList: document.getElementById('settings-backup-list'),
		backupStatus: document.getElementById('settings-backup-status'),
		// 「诊断信息」区（实现细节唯一的去处）
		backupSecurity: document.getElementById('settings-backup-security'),
		backupOpenFolder: document.getElementById('settings-backup-open-folder'),
		credentialStorage: document.getElementById('settings-credential-storage'),
		shareBaseUrl: document.getElementById('settings-share-base-url'),
		dataDir: document.getElementById('settings-data-dir'),
		restart: document.getElementById('settings-restart'),

		// 外观
		themes: document.querySelectorAll('[data-theme-choice]'),
		materials: document.querySelectorAll('[data-material-choice]'),
		accents: document.querySelectorAll('[data-accent-choice]'),

		// 播放
		sleepPresets: document.getElementById('settings-sleep-presets'),
		sleepCustom: document.getElementById('settings-sleep-custom'),
		sleepSet: document.getElementById('settings-sleep-set'),
		sleepCancel: document.getElementById('settings-sleep-cancel'),
		sleepStatus: document.getElementById('settings-sleep-status'),
		loudnessToggle: document.getElementById('settings-loudness'),
		loudnessStatus: document.getElementById('settings-loudness-status'),
		loudnessTarget: document.getElementById('settings-loudness-target'),
		loudnessTargetValue: document.getElementById(
			'settings-loudness-target-value',
		),
	}

	const setStatus = (node, text, kind) => {
		if (!node) return
		node.textContent = text ?? ''
		node.className = `settings-status${kind ? ` settings-status--${kind}` : ''}`
	}

	function unwrap(result, what) {
		if (!result || result.ok !== true) {
			throw new Error(`${what}失败：${result?.error ?? '未知错误'}`)
		}
		return result.data
	}

	const formatBytes = (bytes) => {
		if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
		const units = ['B', 'KB', 'MB', 'GB']
		let value = bytes
		let unit = 0
		while (value >= 1024 && unit < units.length - 1) {
			value /= 1024
			unit += 1
		}
		return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
	}

	const formatTime = (ms) =>
		new Date(ms).toLocaleString('zh-CN', { hour12: false })

	// ---------------------------------------------------------------
	// 依赖（由 renderer.js 注入）
	// ---------------------------------------------------------------

	let features = null
	let currentSettings = null
	/**
	 * 依赖是否已注入。
	 *
	 * ⚠️ 这个守卫不是形式主义：`settings-panel.js` 与 `desktop-features.js`
	 * 都在 `renderer.js` 之前执行，脚本加载时就会绑定下面那些事件监听器。
	 * 第一版没有守卫，于是 `features` 仍是 `null`，启动后点「浅色」主题或
	 * 任一预设按钮都会抛 `Cannot read properties of null`，**表现为点了没反应**。
	 * 由 `verify-desktop-settings.mjs` 的主题/定时关闭断言抓到。
	 */
	let ready = false

	/**
	 * @param {object} deps
	 * @param {object} deps.applyTheme
	 * @param {object} deps.sleepTimer
	 * @param {object} deps.loudness
	 * @param {() => Promise<object>} deps.readSettings
	 * @param {(patch: object) => Promise<object>} deps.writeSettings
	 * @param {number[]} [deps.sleepPresets]
	 */
	/**
	 * 把滑块当前值换算成已填充比例，写进 `--range-fill`。
	 *
	 * 滑块统一自绘（`appearance: none`）之后，进度不能再靠 Chromium 原生的
	 * 填充着色，CSS 用这个变量把轨道分成「已填充（主色）」与「剩余」两段。
	 * 因此**任何** `<input type="range">` 在设置值之后都必须调一次，
	 * 否则它会显示成空轨道（探针的「滑块已自绘并写入了已播放比例」就是抓这个）。
	 */
	function syncRangeFill(input) {
		if (!input) return
		const min = Number(input.min || 0)
		const max = Number(input.max || 100)
		const value = Number(input.value)
		if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return
		const percent = ((value - min) / (max - min)) * 100
		input.style.setProperty(
			'--range-fill',
			`${Math.max(0, Math.min(100, percent))}%`,
		)
	}

	function init(deps) {
		features = deps
		ready = true
		buildSleepPresets(deps.sleepPresets)
		void refreshSettings()
	}

	/** 未注入依赖时的统一提示（而不是抛异常或静默无反应） */
	function notReady(node) {
		setStatus(
			node,
			'设置尚未初始化完成，请稍候重试（依赖注入在启动流程里）',
			'bad',
		)
		return false
	}

	async function refreshSettings() {
		if (!ready) return null
		try {
			currentSettings = await features.readSettings()
			renderTheme(currentSettings.theme)
			renderMaterial(currentSettings.materialLevel)
			renderAccent(currentSettings.accentMode, currentSettings.accentColor)
			renderSleep(currentSettings.sleepEndsAt)
			renderLoudness(currentSettings.loudnessNormalization)
			if (els.loudnessTarget && currentSettings.loudnessTargetDb != null) {
				els.loudnessTarget.value = String(-currentSettings.loudnessTargetDb)
				syncRangeFill(els.loudnessTarget)
			}
			if (els.downloadParallel && currentSettings.downloadMaxParallel != null) {
				els.downloadParallel.value = String(currentSettings.downloadMaxParallel)
			}
			// 歌词：自动匹配（默认开 —— 用 `!== false` 而不是真值判断，
			// 这样旧版本设置里没有这个键时也能得到"开"）
			const lyricsAuto = document.getElementById('settings-lyrics-auto')
			if (lyricsAuto) {
				lyricsAuto.checked = currentSettings.lyricsAutoMatch !== false
			}
		} catch (error) {
			setStatus(els.backupStatus, error.message, 'bad')
		}
		return currentSettings
	}

	// ---------------------------------------------------------------
	// 外观
	// ---------------------------------------------------------------

	function renderTheme(theme) {
		for (const button of els.themes) {
			button.classList.toggle('is-active', button.dataset.themeChoice === theme)
		}
		features.applyTheme(theme)
	}

	for (const button of els.themes) {
		button.addEventListener('click', () => {
			void (async () => {
				if (!ready) {
					notReady(els.backupStatus)
					return
				}
				const theme = button.dataset.themeChoice
				await features.writeSettings({ theme })
				await refreshSettings()
			})()
		})
	}

	/**
	 * 材质强度。
	 *
	 * 与主题走同一条路：写设置 → 主进程重新解析 → 推送 `theme:changed`
	 * → `theme.js` 把 `data-material` 标到 `<html>` 上，CSS 靠它切模糊强度。
	 * 渲染进程这边**不需要**自己拼 CSS —— 强度档位是主进程的单一真相。
	 */
	/**
	 * 配色：系统主题色 / 自定义（阶段 4）。
	 *
	 * 与「显示模式」是两个维度：模式决定亮暗，种子决定色相。
	 */
	function renderAccent(accentMode, accentColor) {
		for (const button of els.accents) {
			button.classList.toggle(
				'is-active',
				button.dataset.accentChoice === (accentMode ?? 'system'),
			)
		}
		const row = document.getElementById('settings-accent-row')
		if (row) row.hidden = (accentMode ?? 'system') !== 'custom'
		const input = document.getElementById('settings-accent-color')
		if (input && /^#[0-9a-fA-F]{6}$/.test(String(accentColor ?? ''))) {
			input.value = String(accentColor)
		}
		const label = document.getElementById('settings-accent-hex')
		if (label && input) label.textContent = input.value
	}

	for (const button of els.accents) {
		button.addEventListener('click', () => {
			void (async () => {
				if (!ready) {
					notReady(els.backupStatus)
					return
				}
				await features.writeSettings({
					accentMode: button.dataset.accentChoice,
				})
				await refreshSettings()
			})()
		})
	}
	document
		.getElementById('settings-accent-color')
		?.addEventListener('input', (event) => {
			const value = event.target.value
			const label = document.getElementById('settings-accent-hex')
			if (label) label.textContent = value
			// `input` 事件在拖动取色器时高频触发 —— 只在 change 时落盘，
			// 否则每拖一格就写一次设置、推一次主题
		})
	document
		.getElementById('settings-accent-color')
		?.addEventListener('change', (event) => {
			void (async () => {
				await features?.writeSettings?.({ accentColor: event.target.value })
				await refreshSettings()
			})()
		})

	function renderMaterial(level) {
		for (const button of els.materials) {
			button.classList.toggle(
				'is-active',
				button.dataset.materialChoice === level,
			)
		}
	}

	for (const button of els.materials) {
		button.addEventListener('click', () => {
			void (async () => {
				if (!ready) {
					notReady(els.backupStatus)
					return
				}
				await features.writeSettings({
					materialLevel: button.dataset.materialChoice,
				})
				await refreshSettings()
			})()
		})
	}

	// ---------------------------------------------------------------
	// 定时关闭
	// ---------------------------------------------------------------

	/**
	 * 建预设按钮。
	 *
	 * 必须在 `init()` 里（拿到 `sleepPresets` 之后）调用，不能在脚本加载时
	 * 就建 —— 那时 `features.sleepPresets` 还是 undefined（同 `ready` 守卫的原因）。
	 */
	function buildSleepPresets(presets) {
		if (!els.sleepPresets) return
		els.sleepPresets.textContent = ''
		for (const minutes of presets ?? [15, 30, 45, 60]) {
			const button = document.createElement('button')
			button.dataset.testid = `sleep-preset-${minutes}`
			button.textContent = `${minutes} 分钟`
			button.addEventListener('click', () => void setSleep(minutes))
			els.sleepPresets.appendChild(button)
		}
	}

	async function setSleep(minutes) {
		if (!ready) {
			notReady(els.sleepStatus)
			return
		}
		try {
			const endsAt = features.sleepTimer.setMinutes(minutes)
			await features.writeSettings({ sleepEndsAt: endsAt })
			renderSleep(endsAt)
			setStatus(els.sleepStatus, `已设置：${minutes} 分钟后暂停`, 'ok')
		} catch (error) {
			setStatus(els.sleepStatus, error.message, 'bad')
		}
	}

	els.sleepSet?.addEventListener('click', () => {
		if (!ready) {
			notReady(els.sleepStatus)
			return
		}
		const minutes = Number.parseInt(els.sleepCustom?.value ?? '', 10)
		if (!Number.isFinite(minutes) || minutes <= 0) {
			setStatus(els.sleepStatus, '请输入正整数分钟数', 'bad')
			return
		}
		void setSleep(minutes)
	})

	els.sleepCancel?.addEventListener('click', () => {
		void (async () => {
			if (!ready) {
				notReady(els.sleepStatus)
				return
			}
			features.sleepTimer.cancel()
			await features.writeSettings({ sleepEndsAt: null })
			renderSleep(null)
			setStatus(els.sleepStatus, '已取消定时关闭', 'ok')
		})()
	})

	/** 每秒刷新倒数；到点后由 features 回调触发，这里只负责显示 */
	let sleepDisplayTimer = null

	function renderSleep(endsAt) {
		if (!els.sleepStatus) return
		if (sleepDisplayTimer) {
			clearInterval(sleepDisplayTimer)
			sleepDisplayTimer = null
		}
		if (!endsAt) {
			setStatus(els.sleepStatus, '未启用')
			return
		}

		const update = () => {
			const left = Math.max(0, endsAt - Date.now())
			const total = Math.ceil(left / 1000)
			const mm = String(Math.floor(total / 60)).padStart(2, '0')
			const ss = String(total % 60).padStart(2, '0')
			setStatus(
				els.sleepStatus,
				`剩余 ${mm}:${ss}（${formatTime(endsAt)} 暂停）`,
				'busy',
			)
			if (left <= 0) {
				if (sleepDisplayTimer) clearInterval(sleepDisplayTimer)
				sleepDisplayTimer = null
				setStatus(els.sleepStatus, '已暂停播放（定时关闭已触发）', 'ok')
			}
		}
		update()
		sleepDisplayTimer = setInterval(update, 1000)
	}

	// ---------------------------------------------------------------
	// 响度均衡
	// ---------------------------------------------------------------

	function renderLoudness(enabled) {
		if (els.loudnessToggle) els.loudnessToggle.checked = Boolean(enabled)
		const state = features.loudness.describe()
		setStatus(
			els.loudnessStatus,
			enabled
				? `已启用（目标 ${state.targetDb} dB，最大增益 ${state.maxGainDb} dB）—— 基于电平的自适应，不是 EBU R128 精确归一化`
				: '未启用（B 站 playurl 不返回逐曲响度数据，详见文件注释）',
			enabled ? 'ok' : null,
		)
	}

	els.loudnessToggle?.addEventListener('change', () => {
		void (async () => {
			if (!ready) {
				notReady(els.loudnessStatus)
				return
			}
			const wanted = els.loudnessToggle.checked
			let actual = wanted
			if (wanted) {
				actual = await features.loudness.enable()
				if (!actual) {
					els.loudnessToggle.checked = false
					setStatus(
						els.loudnessStatus,
						'启用失败：当前环境不支持 Web Audio',
						'bad',
					)
					return
				}
			} else {
				features.loudness.disable()
			}
			await features.writeSettings({ loudnessNormalization: actual })
			renderLoudness(actual)
		})()
	})

	els.loudnessTarget?.addEventListener('input', () => {
		const db = -Number(els.loudnessTarget.value)
		if (els.loudnessTargetValue) {
			els.loudnessTargetValue.textContent = `${db} dB`
		}
		// 拖动时也要重画已填充段（滑块已自绘，原生填充没了）
		syncRangeFill(els.loudnessTarget)
	})

	els.loudnessTarget?.addEventListener('change', () => {
		void (async () => {
			const db = -Number(els.loudnessTarget.value)
			await features.writeSettings({ loudnessTargetDb: db })
			// 目标是建链时读入的，改了需要重建才生效 —— 如实告知而不是假装生效
			setStatus(
				els.loudnessStatus,
				`目标已改为 ${db} dB；重新开关一次「响度均衡」后生效`,
				'busy',
			)
		})()
	})

	// ---------------------------------------------------------------
	// 下载
	// ---------------------------------------------------------------

	let downloadTicker = null

	async function refreshDownloads() {
		try {
			const info = unwrap(await window.bbplayer.download.info(), '读取下载信息')
			if (els.downloadDir) {
				els.downloadDir.textContent = info.downloadDir
				els.downloadDir.title = info.downloadDir
			}

			const tasks = unwrap(
				await window.bbplayer.download.listTasks(),
				'读取下载任务',
			)
			const files = unwrap(
				await window.bbplayer.download.listDownloaded(),
				'读取已下载文件',
			)

			renderDownloadTasks(tasks)
			renderDownloaded(files, info)
			return { info, tasks, files }
		} catch (error) {
			setStatus(els.downloadStatus, error.message, 'bad')
			return null
		}
	}

	function renderDownloadTasks(tasks) {
		if (!els.downloadTasks) return
		els.downloadTasks.textContent = ''
		const active = tasks.filter(
			(task) => !['done', 'failed', 'canceled'].includes(task.state),
		)
		if (active.length === 0) {
			const p = document.createElement('p')
			p.className = 'muted'
			p.textContent = '没有进行中的下载'
			els.downloadTasks.appendChild(p)
			return
		}
		for (const task of active) {
			const row = document.createElement('div')
			row.className = 'settings-row'
			row.dataset.testid = `download-task-${task.bvid}`

			const label = document.createElement('span')
			label.className = 'settings-row__label'
			label.textContent = task.title
			label.title = task.title
			row.appendChild(label)

			const progress = document.createElement('progress')
			if (task.percent !== null) progress.value = task.percent
			else progress.removeAttribute('value')
			progress.max = 100
			row.appendChild(progress)

			const detail = document.createElement('span')
			detail.className = 'muted mono'
			detail.textContent =
				task.percent === null
					? `${formatBytes(task.bytesWritten)}`
					: `${task.percent}% · ${formatBytes(task.bytesWritten)}`
			row.appendChild(detail)

			const cancel = document.createElement('button')
			cancel.dataset.testid = `download-cancel-${task.bvid}`
			cancel.textContent = '取消'
			cancel.addEventListener('click', () => {
				void (async () => {
					await window.bbplayer.download.cancel(task.bvid)
					await refreshDownloads()
				})()
			})
			row.appendChild(cancel)

			els.downloadTasks.appendChild(row)
		}
	}

	function renderDownloaded(files, info) {
		if (!els.downloadList) return
		els.downloadList.textContent = ''

		const summary = document.createElement('p')
		summary.className = 'muted'
		summary.dataset.testid = 'download-summary'
		summary.textContent = `已下载 ${info.downloadedCount} 个文件，共 ${formatBytes(info.totalBytes)}`
		els.downloadList.appendChild(summary)

		for (const file of files.slice(0, 30)) {
			const row = document.createElement('div')
			row.className = 'settings-row'
			row.dataset.testid = `downloaded-${file.filename}`

			const label = document.createElement('span')
			label.className = 'settings-row__label'
			label.textContent = file.filename
			label.title = file.path
			row.appendChild(label)

			const size = document.createElement('span')
			size.className = 'muted mono'
			size.textContent = formatBytes(file.bytes)
			row.appendChild(size)

			els.downloadList.appendChild(row)
		}
	}

	els.downloadRefresh?.addEventListener('click', () => void refreshDownloads())

	els.downloadOpen?.addEventListener('click', () => {
		void (async () => {
			try {
				const data = unwrap(
					await window.bbplayer.download.openFolder(),
					'打开下载目录',
				)
				setStatus(els.downloadStatus, `已在文件管理器中打开 ${data.dir}`, 'ok')
			} catch (error) {
				setStatus(els.downloadStatus, error.message, 'bad')
			}
		})()
	})

	els.downloadParallel?.addEventListener('change', () => {
		void (async () => {
			const value = Number(els.downloadParallel.value)
			await features.writeSettings({ downloadMaxParallel: value })
			setStatus(
				els.downloadStatus,
				`并发已设为 ${value}；重启应用后对新的下载队列生效`,
				'busy',
			)
		})()
	})

	// ---------------------------------------------------------------
	// 备份 / WebDAV
	// ---------------------------------------------------------------

	/**
	 * 刷新「诊断信息」折叠区。
	 *
	 * 这里的东西**故意不放在主流程上**：凭据怎么存、后端地址是什么、
	 * 数据落在哪个目录 —— 用户在自己想看的时候能查到就够了。
	 * 主界面里出现这些只会让人以为「是不是出问题了」。
	 *
	 * 后端地址放在这里也是同一个道理：它可改（自建实例是真实需求），
	 * 但不该和「登录账号」并排出现在共享面板的正中间。
	 */
	async function refreshDiagnostics() {
		try {
			const info = unwrap(await window.bbplayer.diagnostics(), '读取诊断信息')
			if (els.credentialStorage) {
				els.credentialStorage.textContent =
					info.bilibiliCredentialEncrypted === null
						? '—'
						: info.bilibiliCredentialEncrypted
							? '已加密'
							: '未加密'
			}
			if (els.shareBaseUrl && document.activeElement !== els.shareBaseUrl) {
				els.shareBaseUrl.value = info.shareBaseUrl ?? ''
			}
			if (els.dataDir) els.dataDir.textContent = info.dataDir ?? '—'
		} catch {
			// 诊断信息读不到不影响任何功能，安静地留个占位符
			if (els.dataDir) els.dataDir.textContent = '—'
		}
	}

	els.shareBaseUrl?.addEventListener('change', () => {
		void (async () => {
			try {
				const data = unwrap(
					await window.bbplayer.share.setBaseUrl(els.shareBaseUrl.value),
					'修改后端地址',
				)
				els.shareBaseUrl.value = data.baseUrl ?? els.shareBaseUrl.value
			} catch (error) {
				setStatus(els.backupStatus, error.message, 'bad')
			}
		})()
	})

	async function refreshBackupConfig() {
		try {
			const config = unwrap(
				await window.bbplayer.backup.config(),
				'读取备份配置',
			)
			if (els.webdavUrl) els.webdavUrl.value = config.url ?? ''
			if (els.webdavUser) els.webdavUser.value = config.username ?? ''
			if (els.webdavDirectory) {
				els.webdavDirectory.value = config.directory ?? '/BBPlayer'
			}
			if (els.webdavPassword) {
				// 密码从不回传，用占位符表示「已保存」
				els.webdavPassword.value = ''
				els.webdavPassword.placeholder = config.hasPassword
					? '（已保存，留空表示不修改）'
					: '密码'
			}
			if (els.backupSecurity) {
				// 这一段在「诊断信息」折叠区里，不在主流程上。
				// 所以用最短的说法，且**不标红**：它不是错误，只是事实。
				setStatus(
					els.backupSecurity,
					!config.hasPassword
						? '未保存'
						: config.passwordEncrypted
							? '已加密'
							: '未加密',
					null,
				)
			}
			return config
		} catch (error) {
			setStatus(els.backupStatus, error.message, 'bad')
			return null
		}
	}

	els.webdavSave?.addEventListener('click', () => {
		void (async () => {
			setStatus(els.backupStatus, '正在保存…', 'busy')
			try {
				const password = els.webdavPassword?.value ?? ''
				const data = unwrap(
					await window.bbplayer.backup.saveConfig({
						url: els.webdavUrl?.value?.trim() ?? '',
						username: els.webdavUser?.value?.trim() ?? '',
						directory: els.webdavDirectory?.value?.trim() ?? '',
						// 留空 = 不修改已保存的密码（避免「只改地址」时被迫重输）
						...(password ? { password } : {}),
					}),
					'保存备份配置',
				)
				if (els.webdavPassword) els.webdavPassword.value = ''
				// 「已保存」就够了。密码怎么存的属于诊断信息，不属于保存结果的反馈 ——
				// 用户在保存密码时不需要被教育「你的系统没有密钥环」。
				setStatus(els.backupStatus, '已保存', 'ok')
				await refreshBackupConfig()
			} catch (error) {
				setStatus(els.backupStatus, error.message, 'bad')
			}
		})()
	})

	els.webdavTest?.addEventListener('click', () => {
		void (async () => {
			setStatus(els.backupStatus, '正在测试连接…', 'busy')
			try {
				const data = unwrap(
					await window.bbplayer.backup.testConnection(),
					'连接测试',
				)
				setStatus(
					els.backupStatus,
					`连接成功（目录 ${data.directory} 已就绪）`,
					'ok',
				)
			} catch (error) {
				setStatus(els.backupStatus, error.message, 'bad')
			}
		})()
	})

	els.backupExport?.addEventListener('click', () => {
		void (async () => {
			setStatus(els.backupStatus, '正在导出到本地…', 'busy')
			try {
				const data = unwrap(
					await window.bbplayer.backup.exportLocal(),
					'本地导出',
				)
				// ⚠️ 只报「成功了、多大」，不报文件名与绝对路径。
				// 原来那句 `已导出 backup-….bbplayer（1654.4 KB）→ C:\Users\…\Temp\…`
				// 是调试信息：路径长到会把面板撑破，而且用户要的是
				// 「文件在哪」→ 给一个「打开所在文件夹」按钮比给一串路径有用。
				setStatus(
					els.backupStatus,
					`已导出备份文件（${formatBytes(data.bytes)}）`,
					'ok',
				)
			} catch (error) {
				setStatus(els.backupStatus, error.message, 'bad')
			}
		})()
	})

	els.backupOpenFolder?.addEventListener('click', () => {
		void (async () => {
			try {
				unwrap(await window.bbplayer.backup.openFolder(), '打开备份目录')
			} catch (error) {
				setStatus(els.backupStatus, error.message, 'bad')
			}
		})()
	})

	els.restart?.addEventListener('click', () => {
		void window.bbplayer.relaunch()
	})

	els.webdavUpload?.addEventListener('click', () => {
		void (async () => {
			setStatus(els.backupStatus, '正在生成备份并上传…', 'busy')
			try {
				const data = unwrap(await window.bbplayer.backup.upload(), '上传备份')
				setStatus(
					els.backupStatus,
					`已上传 ${data.name}（${formatBytes(data.bytes)}）→ ${data.path}`,
					'ok',
				)
				await refreshRemoteBackups()
			} catch (error) {
				setStatus(els.backupStatus, error.message, 'bad')
			}
		})()
	})

	async function refreshRemoteBackups() {
		if (!els.backupList) return
		els.backupList.textContent = ''
		setStatus(els.backupStatus, '正在读取远端备份…', 'busy')
		try {
			const list = unwrap(
				await window.bbplayer.backup.listRemote(),
				'列出远端备份',
			)
			if (list.length === 0) {
				const p = document.createElement('p')
				p.className = 'muted'
				p.textContent = '远端没有备份（文件名需匹配 backup-*.bbplayer）'
				els.backupList.appendChild(p)
				setStatus(els.backupStatus, '远端暂无备份', null)
				return
			}
			for (const item of list) {
				const row = document.createElement('div')
				row.className = 'settings-row'
				row.dataset.testid = `remote-backup-${item.name}`

				const label = document.createElement('span')
				label.className = 'settings-row__label'
				label.textContent = item.name
				label.title = item.path
				row.appendChild(label)

				const meta = document.createElement('span')
				meta.className = 'muted mono'
				meta.textContent =
					item.lastModified === null ? '—' : formatTime(item.lastModified)
				row.appendChild(meta)

				const restore = document.createElement('button')
				restore.dataset.testid = `restore-${item.name}`
				restore.textContent = '恢复'
				restore.addEventListener('click', () => void restoreRemote(item))
				row.appendChild(restore)

				els.backupList.appendChild(row)
			}
			setStatus(els.backupStatus, `远端 ${list.length} 份备份`, 'ok')
		} catch (error) {
			// ⚠️ 出错时也要在列表区域留一行说明。
			// 第一版只在状态栏写字、列表留空 —— 面板上看起来「什么都没有」，
			// 用户分不清「没有备份」和「读取失败」。由
			// `verify-desktop-settings.mjs` 的「备份列表渲染出内容」断言抓到。
			const failure = document.createElement('p')
			failure.className = 'muted'
			failure.dataset.testid = 'backup-list-error'
			// 一句话 + 指回上面那个按钮，不要写成一段故障分析。
			failure.textContent =
				'读取不到远端备份。先检查上面的地址与密码，然后点「刷新远端列表」。'
			els.backupList.appendChild(failure)
			setStatus(els.backupStatus, error.message, 'bad')
		}
	}

	els.webdavRefresh?.addEventListener(
		'click',
		() => void refreshRemoteBackups(),
	)

	/**
	 * 恢复备份。
	 *
	 * ⚠️ 恢复会**关闭数据库连接**并替换数据文件，之后必须重启应用。
	 * 所以必须二次确认，并在成功后把这一点明确说出来，而不是让用户
	 * 对着一个「操作成功但什么都不动了」的界面。
	 */
	async function restoreRemote(item) {
		const confirmed = window.confirm(
			`确定用远端备份覆盖本地数据吗？\n\n${item.name}\n\n` +
				'• 当前数据会被整体替换（旧库会留一份 .before-restore 备份）\n' +
				'• 恢复后需要重启应用才能继续使用',
		)
		if (!confirmed) return

		setStatus(els.backupStatus, '正在下载并恢复…', 'busy')
		try {
			const data = unwrap(
				await window.bbplayer.backup.downloadRemote(item.path),
				'恢复备份',
			)
			void data
			// ⚠️ 原来这里打印的是
			// `恢复完成（exportedAt=…）。请重启应用；数据迁移：migrateX=ok …`
			// —— 那是把内部字段名和迁移函数名直接甩给用户。
			// 用户要知道的只有一件事：**现在要重启**。于是直接给按钮。
			setStatus(els.backupStatus, '已恢复。重启应用后生效。', 'ok')
			if (els.restart) els.restart.hidden = false
		} catch (error) {
			setStatus(els.backupStatus, error.message, 'bad')
		}
	}

	// ---------------------------------------------------------------
	// 开关 / 页签
	// ---------------------------------------------------------------

	// ---------------------------------------------------------------
	// 账号 / 通用 / 关于（阶段 3 新增的分类）
	// ---------------------------------------------------------------

	/**
	 * Bilibili 账号：**只显示头像 + 昵称**（用户明确要求）。
	 *
	 * 账号页要回答的是"我现在是谁"，不是"你的凭据存在哪"——
	 * 后者属于「关于 › 诊断信息」。所以这里没有 mid、没有登录时间、
	 * 没有加密方式，只有一张脸和一个名字。
	 */
	async function refreshAccountSummary() {
		const avatar = document.getElementById('settings-bili-avatar')
		const name = document.getElementById('settings-bili-name')
		const sub = document.getElementById('settings-bili-sub')
		const login = document.getElementById('settings-bili-login')
		const logout = document.getElementById('settings-bili-logout')
		if (!name) return

		let status = null
		try {
			status = await window.bbplayer.loginStatus()
		} catch {
			// 拿不到就当未登录，不打断设置页
		}
		const user = status?.user ?? null
		const loggedIn = Boolean(status?.loggedIn)

		if (name) name.textContent = loggedIn ? (user?.uname ?? '已登录') : '未登录'
		if (sub)
			sub.textContent = loggedIn
				? (user?.vipLabel ?? '')
				: '登录后可读私密收藏夹'
		if (login) login.hidden = loggedIn
		if (logout) logout.hidden = !loggedIn

		if (avatar) {
			avatar.textContent = ''
			if (loggedIn && user?.face) {
				const img = document.createElement('img')
				img.src = user.face
				img.alt = ''
				// 头像加载失败就退回图标，不留破图
				img.addEventListener('error', () => {
					avatar.textContent = ''
					const span = document.createElement('span')
					span.className = 'icon icon--lg'
					span.textContent = 'person'
					avatar.appendChild(span)
				})
				avatar.appendChild(img)
			} else {
				const span = document.createElement('span')
				span.className = `icon icon--lg${loggedIn ? '' : ''}`
				span.textContent = loggedIn ? 'account_circle' : 'person'
				avatar.appendChild(span)
			}
		}

		// 分类列表上的副标题也要跟着更新（列表里就能看出登录状态）
		const rowSub = document.getElementById('settings-cat-bili-sub')
		if (rowSub)
			rowSub.textContent = loggedIn ? (user?.uname ?? '已登录') : '未登录'
	}

	/**
	 * BBPlayer 账号：共享歌单用的账号。
	 *
	 * 与 B 站账号是**两回事** —— 写清楚这一点，用户才不会以为登了一个就够。
	 * 这里只做展示 + 一个去共享面板的入口（注册/登录的完整流程在那儿）。
	 */
	async function refreshBbplayerSummary() {
		const name = document.getElementById('settings-bbplayer-name')
		const sub = document.getElementById('settings-bbplayer-sub')
		const rowSub = document.getElementById('settings-cat-bbplayer-sub')
		if (!name) return

		let account = null
		try {
			// `describe()` 是共享面板给自动化用的摘要，正好也是这里需要的
			account = window.bbShare?.describe?.() ?? null
		} catch {
			// 共享面板不可用就当未登录
		}

		const loggedIn = Boolean(account?.loggedIn)
		const display = account?.account?.name ?? account?.account?.username ?? null
		name.textContent = loggedIn ? (display ?? '已登录') : '未登录'
		if (sub) {
			sub.textContent = loggedIn ? '共享歌单已开启同步' : '去共享面板注册或登录'
		}
		if (rowSub) {
			rowSub.textContent = loggedIn ? (display ?? '已登录') : '共享歌单用的账号'
		}
	}

	/**
	 * 通用：数据目录 + 快捷键。
	 *
	 * ⚠️ 数据目录是**实现细节**，但它在「通用」里是有用的（用户要备份/迁移），
	 * 所以给的是"打开所在文件夹"这个**动作**，路径本身只在诊断信息里露出。
	 */
	async function refreshGeneral() {
		const dir = document.getElementById('settings-general-dir')
		if (!dir) return
		try {
			const info = await window.bbplayer.diagnostics?.()
			dir.textContent = info?.ok ? (info.data?.dataDir ?? '—') : '—'
		} catch {
			dir.textContent = '—'
		}
	}

	/** 关于：版本号 + 诊断信息 */
	async function refreshAbout() {
		const version = document.getElementById('settings-about-version')
		try {
			const info = await window.bbplayer.diagnostics?.()
			if (version) {
				version.textContent = info?.ok ? (info.data?.versions?.app ?? '—') : '—'
			}
		} catch {
			if (version) version.textContent = '—'
		}
		await refreshDiagnostics()
	}

	/** 分类名 → 子页标题（内容由各分类的渲染函数填） */
	const CATEGORY_TITLES = {
		theme: '主题',
		appearance: '外观',
		playback: '播放',
		lyrics: '歌词',
		download: '下载',
		'account-bili': 'Bilibili 账号',
		'account-bbplayer': 'BBPlayer 账号',
		backup: '备份与恢复',
		general: '通用',
		about: '关于',
	}

	/**
	 * 打开某个分类的子页。
	 *
	 * 与旧的「页签」相比多了一件事：**隐藏分类列表、显示子页、露出返回按钮**。
	 * 这是"分类列表 → 子页"这个导航模型的核心（移动端就是这样）。
	 *
	 * @param {string} tab 分类名
	 */
	function switchCategory(tab) {
		if (!els.categoryKeys.includes(tab)) return
		for (const panel of els.panels) {
			panel.classList.toggle('is-active', panel.dataset.settingsPanel === tab)
		}
		if (els.categories) els.categories.hidden = true
		if (els.panelsBox) els.panelsBox.hidden = false
		if (els.back) els.back.hidden = false
		// 标题用**外壳**的 #page-title（页面里只有这一处标题）
		const title = document.getElementById('page-title')
		if (title) title.textContent = CATEGORY_TITLES[tab] ?? '设置'
		window.bbState?.set?.({ settingsCategory: tab })

		if (tab === 'download') void refreshDownloads()
		if (tab === 'account-bili') void refreshAccountSummary()
		if (tab === 'account-bbplayer') void refreshBbplayerSummary()
		if (tab === 'general') void refreshGeneral()
		if (tab === 'about') void refreshAbout()
		if (tab === 'backup') {
			// ⚠️ 必须**同时**加载远端列表。
			// 第一版只调 refreshBackupConfig()，于是打开备份页签时列表区是空白的，
			// 用户得先点一次「刷新远端列表」才知道有什么 —— 由
			// `verify-desktop-settings.mjs` 的「备份列表渲染出内容」断言抓到。
			void refreshBackupConfig()
			void refreshRemoteBackups()
			void refreshDiagnostics()
		}
		if (tab === 'playback') void refreshSettings()
		if (tab === 'appearance') void refreshSettings()
	}

	for (const button of els.categoryButtons) {
		button.addEventListener('click', () =>
			switchCategory(button.dataset.settingsCategory),
		)
	}
	els.back?.addEventListener('click', () => showCategories())

	/** 回到分类列表（返回按钮，或再次点左栏的「设置」） */
	function showCategories() {
		if (els.categories) els.categories.hidden = false
		if (els.panelsBox) els.panelsBox.hidden = true
		if (els.back) els.back.hidden = true
		const title = document.getElementById('page-title')
		if (title) title.textContent = '设置'
		for (const panel of els.panels) panel.classList.remove('is-active')
		window.bbState?.set?.({ settingsCategory: null })
	}

	/**
	 * 打开设置（左栏的一个目的地）。
	 *
	 * @param {string} [category] 直接进某一类；不传就停在分类列表
	 */
	function open(category) {
		if (!els.view) return
		els.view.hidden = false
		if (category) switchCategory(category)
		else showCategories()
	}

	function close() {
		if (!els.view) return
		els.view.hidden = true
		if (downloadTicker) {
			clearInterval(downloadTicker)
			downloadTicker = null
		}
	}

	els.open?.addEventListener('click', () => open())

	// —— 账号 / 通用 分类里的动作 ——
	//
	// 每个动作都只是**转发**到既有的实现（登录弹窗、共享面板、歌词窗口），
	// 不在这里复制一份逻辑 —— 复制出来的第二份必然会与第一份漂移。
	document
		.getElementById('settings-bili-login')
		?.addEventListener('click', () => window.bbAuth?.open?.('qr'))
	document
		.getElementById('settings-bili-logout')
		?.addEventListener('click', () => {
			void (async () => {
				await window.bbAuth?.logout?.()
				await refreshAccountSummary()
			})()
		})
	document
		.getElementById('settings-bbplayer-open')
		?.addEventListener('click', () => {
			// 共享面板是页内动作；从设置里跳过去要同时把它显示出来
			void window.bbShare?.show?.()
			window.bbUI?.setActiveNav?.('share')
		})
	document
		.getElementById('settings-general-open-folder')
		?.addEventListener('click', () => void window.bbplayer.backupOpenFolder?.())
	document
		.getElementById('settings-general-shortcuts')
		?.addEventListener('click', () => {
			// 快捷键说明住在顶栏的弹层里，这里把它打开给用户看
			window.bbShortcuts?.open?.()
		})
	document
		.getElementById('settings-lyrics-window')
		?.addEventListener(
			'click',
			() => void window.bbplayer.lyricsWindow?.toggle?.(),
		)
	document
		.getElementById('settings-lyrics-auto')
		?.addEventListener('change', (event) => {
			void (async () => {
				await features?.writeSettings?.({
					lyricsAutoMatch: Boolean(event.target.checked),
				})
				await refreshSettings()
			})()
		})
	// ⚠️ 设置不再是浮层，所以**没有"点遮罩关闭"**这回事 ——
	// 它是一个页面，离开靠点左栏的别的目的地。
	els.back2?.addEventListener('click', close)

	/**
	 * 分类子页打开时轮询下载进度。
	 *
	 * 用轮询而不是主进程推送：桌面端是本地磁盘写入，500ms 一次的开销可忽略，
	 * 而少一条推送通道就少一处状态同步 bug（与 preload 里的注释一致）。
	 */
	function startDownloadPolling() {
		if (downloadTicker) return
		downloadTicker = setInterval(() => {
			if (els.view?.hidden) return
			const active = els.view?.querySelector(
				'[data-settings-panel="download"].is-active',
			)
			if (active) void refreshDownloads()
		}, 800)
	}

	window.bbSettings = {
		init,
		open,
		close,
		showCategories,
		switchCategory,
		/** @deprecated 旧名字，保留一个版本以免外部调用点漏改 */
		switchTab: switchCategory,
		refreshSettings,
		refreshDownloads,
		refreshRemoteBackups,
		startDownloadPolling,
		/** 供自动化断言 */
		describe: () => ({
			currentSettings,
			viewHidden: els.view?.hidden ?? true,
			categoryListVisible: !els.categories?.hidden,
			activeCategory:
				document.querySelector('[data-settings-panel].is-active')?.dataset
					.settingsPanel ?? null,
			categories: els.categoryKeys,
		}),
	}
})()
