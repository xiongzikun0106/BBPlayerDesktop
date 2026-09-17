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
		drawer: document.getElementById('settings-drawer'),
		open: document.getElementById('settings-open'),
		close: document.getElementById('settings-close'),
		tabs: document.querySelectorAll('[data-settings-tab]'),
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
		backupSecurity: document.getElementById('settings-backup-security'),

		// 外观
		themes: document.querySelectorAll('[data-theme-choice]'),

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
			renderSleep(currentSettings.sleepEndsAt)
			renderLoudness(currentSettings.loudnessNormalization)
			if (els.loudnessTarget && currentSettings.loudnessTargetDb != null) {
				els.loudnessTarget.value = String(-currentSettings.loudnessTargetDb)
			}
			if (els.downloadParallel && currentSettings.downloadMaxParallel != null) {
				els.downloadParallel.value = String(currentSettings.downloadMaxParallel)
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
				setStatus(
					els.backupSecurity,
					config.passwordEncrypted
						? 'WebDAV 密码由系统密钥环加密保存'
						: config.hasPassword
							? '⚠️ 系统密钥环不可用，WebDAV 密码未加密保存'
							: '尚未保存 WebDAV 密码',
					config.passwordEncrypted ? 'ok' : config.hasPassword ? 'bad' : null,
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
				setStatus(
					els.backupStatus,
					data.passwordEncrypted === true
						? '已保存（密码已加密）'
						: '已保存（密码未加密 —— 系统密钥环不可用）',
					data.passwordEncrypted === false ? 'busy' : 'ok',
				)
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
				setStatus(
					els.backupStatus,
					`已导出 ${data.filename}（${formatBytes(data.bytes)}）→ ${data.path}`,
					'ok',
				)
			} catch (error) {
				setStatus(els.backupStatus, error.message, 'bad')
			}
		})()
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
			failure.textContent =
				'读取远端备份失败（列表为空）。常见原因：尚未配置 WebDAV，或上面的连接测试未通过。'
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
			const migrated = data.dataMigrations?.results ?? {}
			setStatus(
				els.backupStatus,
				`恢复完成（exportedAt=${data.manifest?.exportedAt ?? '?'}）。` +
					'请重启应用；数据迁移：' +
					Object.entries(migrated)
						.map(([name, status]) => `${name}=${status}`)
						.join(' '),
				'ok',
			)
		} catch (error) {
			setStatus(els.backupStatus, error.message, 'bad')
		}
	}

	// ---------------------------------------------------------------
	// 开关 / 页签
	// ---------------------------------------------------------------

	function switchTab(tab) {
		for (const button of els.tabs) {
			button.classList.toggle('is-active', button.dataset.settingsTab === tab)
		}
		for (const panel of els.panels) {
			panel.classList.toggle('is-active', panel.dataset.settingsPanel === tab)
		}
		if (tab === 'download') void refreshDownloads()
		if (tab === 'backup') {
			// ⚠️ 必须**同时**加载远端列表。
			// 第一版只调 refreshBackupConfig()，于是打开备份页签时列表区是空白的，
			// 用户得先点一次「刷新远端列表」才知道有什么 —— 由
			// `verify-desktop-settings.mjs` 的「备份列表渲染出内容」断言抓到。
			void refreshBackupConfig()
			void refreshRemoteBackups()
		}
		if (tab === 'playback') void refreshSettings()
		if (tab === 'appearance') void refreshSettings()
	}

	for (const button of els.tabs) {
		button.addEventListener('click', () =>
			switchTab(button.dataset.settingsTab),
		)
	}

	function open(tab) {
		if (!els.drawer) return
		els.drawer.hidden = false
		els.drawer.classList.add('is-open')
		switchTab(tab ?? 'appearance')
	}

	function close() {
		if (!els.drawer) return
		els.drawer.hidden = true
		els.drawer.classList.remove('is-open')
		if (downloadTicker) {
			clearInterval(downloadTicker)
			downloadTicker = null
		}
	}

	els.open?.addEventListener('click', () => open())
	els.close?.addEventListener('click', close)
	// 遮罩点击关闭
	els.drawer?.addEventListener('click', (event) => {
		if (event.target === els.drawer) close()
	})

	/**
	 * 面板打开时轮询下载进度。
	 *
	 * 用轮询而不是主进程推送：桌面端是本地磁盘写入，500ms 一次的开销可忽略，
	 * 而少一条推送通道就少一处状态同步 bug（与 preload 里的注释一致）。
	 */
	function startDownloadPolling() {
		if (downloadTicker) return
		downloadTicker = setInterval(() => {
			if (els.drawer?.hidden) return
			const active = els.drawer?.querySelector(
				'[data-settings-panel="download"].is-active',
			)
			if (active) void refreshDownloads()
		}, 800)
	}

	window.bbSettings = {
		init,
		open,
		close,
		switchTab,
		refreshSettings,
		refreshDownloads,
		refreshRemoteBackups,
		startDownloadPolling,
		/** 供自动化断言 */
		describe: () => ({
			currentSettings,
			drawerHidden: els.drawer?.hidden ?? true,
			activeTab:
				document.querySelector('[data-settings-tab].is-active')?.dataset
					.settingsTab ?? null,
		}),
	}
})()
