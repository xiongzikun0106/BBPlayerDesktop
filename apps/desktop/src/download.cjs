/**
 * 下载（Phase 4.3）：把 B 站音频存成**可离线播放的本地文件**。
 *
 * ## 与移动端的关系（调研结论，用来对齐行为而不是凭空设计）
 *
 * 移动端的下载不是 `expo-file-system`，而是 Android Media3 的
 * ExoPlayer offline download（`packages/orpheus/android/.../DownloadUtil.kt`）。
 * 关键点与桌面端的对应关系：
 *
 * | 移动端 | 桌面端 |
 * | --- | --- |
 * | CDN 请求带 `Referer: https://www.bilibili.com/` | 同（实测无 Referer 即 403） |
 * | Cookie 只发给 **API**，不发给 CDN | 同（沿用它就能保持行为一致） |
 * | 并发默认 1，可调 1–6 | 默认 2（桌面带宽更充裕，但保守起步） |
 * | 落 `<filesDir>/media_download`，永不过期 | 落 `userData/downloads` |
 * | 导出扩展名恒为 `.m4a`（m4s 与 m4a 同为 ISOBMFF，无需转码） | **同，恒为 `.m4a`** |
 * | 文件名清洗 `[\\/:*?"<>|] -> _`，空则用 id | 同（同一套字符集） |
 *
 * ## 为什么不做「边下边转码」
 *
 * 测过的事实：B 站的 dash 音频是 **m4s**，而 m4s 与 m4a 同为 ISOBMFF 容器，
 * **改扩展名即可播放**，不需要 ffmpeg 转码（移动端也是这么做的，
 * 它的注释写着「m4s 与 m4a 同为 ISOBMFF 容器，无需转码」）。
 * 因此桌面端也不引入 ffmpeg —— 那会给打包平添几十 MB 与签名麻烦。
 *
 * ## 断点续传
 *
 * 用 `.part` 临时文件 + HTTP `Range`。B 站主线 CDN 原生支持 Range（实测 206），
 * 所以重试时能接着下，而不是从零开始。
 */
const fs = require('node:fs')
const path = require('node:path')

const { getAudioStream } = require('./bilibili-api.cjs')

/** 与 bilibili-api 保持一致的请求头（`Referer` 是硬性要求） */
const REFERER = 'https://www.bilibili.com/'
const DESKTOP_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 扩展名恒为 `.m4a`，与移动端一致 */
const EXPORT_EXTENSION = '.m4a'

/**
 * 文件名清洗：把 Windows/Linux 都不允许的字符换成 `_`。
 *
 * 与移动端 `ExportDownloadsHelper.buildFileName` 用的是**同一个字符集**
 * `[\\/:*?"<>|]`，这样同一首歌在两端导出的文件名一致。
 */
function sanitizeFilename(name) {
	return String(name ?? '')
		.replaceAll(/[\\/:*?"<>|]/g, '_')
		.trim()
}

/**
 * 由曲目信息生成文件名（不含扩展名）。
 *
 * 空标题时退回用 bvid，避免出现「只有一个 `.m4a` 的隐藏文件」。
 */
function buildFilename(track) {
	const base = sanitizeFilename(track.title) || track.bvid || 'unknown'
	// 防止标题清洗后只剩点和空格（Windows 上这种名字无法创建）
	const safe =
		base.replaceAll(/^[.\s]+|[.\s]+$/g, '') || track.bvid || 'unknown'
	return `${safe}${EXPORT_EXTENSION}`
}

/** 在目标目录里找不冲突的名字：`歌名.m4a`、`歌名 (2).m4a`、… */
function uniquePath(dir, filename) {
	const ext = path.extname(filename)
	const stem = filename.slice(0, -ext.length || undefined)
	let candidate = path.join(dir, filename)
	let index = 2
	while (fs.existsSync(candidate)) {
		candidate = path.join(dir, `${stem} (${index})${ext}`)
		index += 1
		if (index > 9999) break
	}
	return candidate
}

/** 下载任务的状态机 */
const TASK_STATE = {
	QUEUED: 'queued',
	RESOLVING: 'resolving',
	DOWNLOADING: 'downloading',
	DONE: 'done',
	FAILED: 'failed',
	CANCELED: 'canceled',
}

/**
 * 任务 -> 对外快照（不含 AbortController 之类不可序列化的东西）。
 *
 * 刻意放在模块作用域而不是 `createDownloadManager` 内部：它不捕获任何
 * 闭包变量，放外面更清楚，也避免 `unicorn/consistent-function-scoping`
 * 的提示（该规则正是用来指出这类「其实不必在闭包里」的函数）。
 */
function snapshot(task) {
	const percent =
		task.bytesTotal && task.bytesTotal > 0
			? Math.round((task.bytesWritten / task.bytesTotal) * 100)
			: null
	return {
		bvid: task.bvid,
		title: task.title,
		state: task.state,
		bytesWritten: task.bytesWritten ?? 0,
		bytesTotal: task.bytesTotal ?? null,
		percent,
		quality: task.quality ?? null,
		tier: task.tier ?? null,
		upstreamHost: task.upstreamHost ?? null,
		path: task.path ?? null,
		filename: task.filename ?? null,
		error: task.error ?? null,
	}
}

/**
 * 创建下载管理器。
 *
 * @param {object} options
 * @param {string} options.downloadDir 落盘目录
 * @param {number} [options.maxParallel] 并发上限（1–6，与移动端同区间）
 * @param {(bvid: string) => Promise<{url: string, backupUrls?: string[], tier?: string, qualityId?: number}>} [options.resolveStream]
 *        解析音频地址。默认走 `bilibili-api.cjs`；**注入点存在的意义**是
 *        让验证脚本能对着本地 HTTP 服务器跑真实的 Range/续传/完整性逻辑，
 *        而不必依赖公网 CDN 的随机性。
 * @param {(message: string, meta?: object) => void} [options.log]
 */
function createDownloadManager({
	downloadDir,
	maxParallel = 2,
	resolveStream: injectedResolver,
	log = () => {},
}) {
	/**
	 * 夹到 1–6，与移动端 `setMaxParallelDownloads` 的区间一致。
	 *
	 * 用 `Number.isFinite` 而不是 `|| 1`：后者会把**合法的 0** 也当成
	 * 「没传」而变成 1（结果看似一样但语义不清）。非数字（如 `'abc'`）会
	 * 让 `Number.isFinite` 为假，落到 1 —— 正是想要的「非法值退回 1」。
	 */
	const requested = maxParallel
	const limit = Number.isFinite(requested)
		? Math.min(6, Math.max(1, requested))
		: 1
	fs.mkdirSync(downloadDir, { recursive: true })

	/** @type {Map<string, object>} bvid -> 任务 */
	const tasks = new Map()
	/** bvid -> AbortController */
	const controllers = new Map()
	/** @type {Set<(event: object) => void>} */
	const listeners = new Set()

	function emit(event) {
		for (const listener of listeners) {
			try {
				listener(event)
			} catch (error) {
				log(`下载事件订阅者抛错：${error.message}`)
			}
		}
	}

	/** 已完成的下载（扫描磁盘，避免依赖内存状态） */
	function listDownloaded() {
		if (!fs.existsSync(downloadDir)) return []
		return fs
			.readdirSync(downloadDir)
			.filter((name) => name.toLowerCase().endsWith(EXPORT_EXTENSION))
			.map((name) => {
				const full = path.join(downloadDir, name)
				const stat = fs.statSync(full)
				return {
					filename: name,
					path: full,
					bytes: stat.size,
					downloadedAt: stat.mtimeMs,
				}
			})
			.sort((a, b) => b.downloadedAt - a.downloadedAt)
	}

	/** 某个 bvid 是否已经下过（按标题匹配文件名，尽力而为） */
	function findExisting(track) {
		const target = buildFilename(track)
		const stem = target.slice(0, -EXPORT_EXTENSION.length)
		if (!fs.existsSync(downloadDir)) return null
		const match = fs
			.readdirSync(downloadDir)
			.filter((name) => name === target || name.startsWith(`${stem} (`))
			.map((name) => path.join(downloadDir, name))
			.filter((full) => fs.existsSync(full))
			.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
		return match[0] ?? null
	}

	/**
	 * 下一条任务出队。
	 *
	 * 用「每次取一条」而不是一次性排空，这样中途加入的任务也能被调度。
	 */
	function pump() {
		const running = [...tasks.values()].filter(
			(task) =>
				task.state === TASK_STATE.RESOLVING ||
				task.state === TASK_STATE.DOWNLOADING,
		).length
		if (running >= limit) return

		const next = [...tasks.values()].find(
			(task) => task.state === TASK_STATE.QUEUED,
		)
		if (!next) return

		void runTask(next)
	}

	async function runTask(task) {
		const controller = new AbortController()
		controllers.set(task.bvid, controller)

		try {
			// 1) 解析音频地址（这一步会请求 API，需要 Cookie 才能拿到高音质）
			task.state = TASK_STATE.RESOLVING
			emit({ type: 'updated', task: snapshot(task) })

			const stream = await resolveStream(task.bvid)
			task.tier = stream.tier
			task.quality = stream.qualityId
			task.upstreamHost = new URL(stream.url).host

			// 2) 决定落盘路径
			const filename = buildFilename(task)
			const finalPath = task.targetPath ?? uniquePath(downloadDir, filename)
			task.targetPath = finalPath
			// `.part` 临时文件：只有下完才 rename，避免半截文件被当成已完成
			const partPath = `${finalPath}.part`

			// 3) 断点续传：已有 `.part` 就带 Range 接着下
			let startByte = 0
			if (fs.existsSync(partPath)) {
				startByte = fs.statSync(partPath).size
			}

			const headers = {
				Referer: REFERER,
				'User-Agent': DESKTOP_UA,
			}
			if (startByte > 0) headers.Range = `bytes=${startByte}-`

			task.state = TASK_STATE.DOWNLOADING
			emit({ type: 'updated', task: snapshot(task) })

			const response = await fetchWithFallback(
				[stream.url, ...(stream.backupUrls ?? [])],
				headers,
				controller.signal,
			)
			if (!response.ok) {
				throw new Error(`CDN 返回 HTTP ${response.status}`)
			}

			// 服务端忽略了 Range（回了 200 而不是 206）-> 从头写
			const resuming = startByte > 0 && response.status === 206 && response.body
			if (startByte > 0 && !resuming) {
				log(`上游未接受 Range（HTTP ${response.status}），从头下载`)
				startByte = 0
			}

			const totalHeader = response.headers.get('content-length')
			const total =
				totalHeader === null ? null : Number(totalHeader) + startByte
			task.bytesTotal = total

			// ⚠️ 写入必须**显式带 position**。
			// 第一版只写 `fs.writeSync(handle, chunk)`，依赖文件游标：续传时
			// `ftruncateSync` 会把游标留在末尾，于是首个 chunk 被写到
			// `startByte` 而不是 0 —— 结果是「前 startByte 字节全是 0 + 后面
			// 180000 字节」，文件只有 180000 字节且完全错位。
			// 由 `verify-download.mjs` 的「续传后文件与源逐字节相同」断言抓到。
			const handle = fs.openSync(partPath, resuming ? 'r+' : 'w')
			let written = startByte
			try {
				if (resuming) fs.ftruncateSync(handle, startByte)
				for await (const chunk of response.body) {
					// position = 当前已写到的偏移，与游标状态无关
					fs.writeSync(handle, chunk, 0, chunk.length, written)
					written += chunk.length
					task.bytesWritten = written
					emit({ type: 'updated', task: snapshot(task) })
				}
			} catch (error) {
				// 上游中途断开时 Node 的 fetch 会抛 `TypeError: terminated`，
				// 这个消息对用户毫无意义 —— 翻译成「不完整」，并保留下面的
				// .part 供重试续传（见下面的完整性校验）。
				if (written < (total ?? Number.POSITIVE_INFINITY)) {
					throw new Error(
						`下载中断：已收到 ${written} 字节` +
							`${total === null ? '' : `，期望 ${total} 字节`}（.part 已保留，可重试续传）—— 上游原因：${error.message}`,
						// 保留原始错误，便于排查底层原因（连接被重置 / 超时 / …）
						{ cause: error },
					)
				}
				throw error
			} finally {
				fs.closeSync(handle)
			}

			// 4) 校验完整性（有 Content-Length 时必须对得上）
			if (total !== null && written !== total) {
				throw new Error(
					`下载不完整：收到 ${written} 字节，期望 ${total} 字节（.part 已保留，可重试续传）`,
				)
			}

			fs.renameSync(partPath, finalPath)

			task.state = TASK_STATE.DONE
			task.bytesWritten = written
			task.path = finalPath
			task.filename = path.basename(finalPath)
			task.doneAt = Date.now()
			log(
				`下载完成：${task.filename}（${written} 字节，音质 ${task.quality ?? '?'}）`,
			)
			emit({ type: 'done', task: snapshot(task) })
		} catch (error) {
			if (controller.signal.aborted) {
				task.state = TASK_STATE.CANCELED
				log(`下载已取消：${task.bvid}`)
			} else {
				task.state = TASK_STATE.FAILED
				task.error = error.message
				log(`下载失败：${task.bvid} — ${error.message}`)
			}
			emit({ type: 'updated', task: snapshot(task) })
		} finally {
			controllers.delete(task.bvid)
			// 腾出并发位后继续调度
			pump()
		}
	}

	/**
	 * 按顺序尝试主地址与备用地址。
	 *
	 * B 站会给 1–3 个 `backupUrl`（同内容的不同 CDN 节点）。逐个尝试能
	 * 显著减少「某个节点抽风就整首失败」的情况 —— 移动端**没有**用
	 * `backup_url`，这里补上是有意的改进。
	 */
	async function fetchWithFallback(urls, headers, signal) {
		let lastError = null
		for (const url of urls) {
			try {
				const response = await fetch(url, { headers, signal })
				if (response.ok || response.status === 206) return response
				lastError = new Error(`HTTP ${response.status}`)
				log(
					`节点返回 HTTP ${response.status}，尝试下一个：${new URL(url).host}`,
				)
			} catch (error) {
				if (signal.aborted) throw error
				lastError = error
				log(`节点请求失败（${error.message}），尝试下一个`)
			}
		}
		throw lastError ?? new Error('没有可用的下载地址')
	}

	/**
	 * 解析音频地址。
	 *
	 * 生产路径：`getVideoInfo` 拿 cid，再 `getAudioStream` 走音质阶梯
	 * （未登录时服务端只下发标准音质，见 `bilibili-api.cjs`）。
	 */
	async function resolveStream(bvid) {
		if (injectedResolver) return await injectedResolver(bvid)
		const { getVideoInfo } = require('./bilibili-api.cjs')
		const info = await getVideoInfo(bvid)
		return await getAudioStream(bvid, info.cid)
	}

	// 任务快照由模块作用域的 snapshot() 提供（它不捕获闭包变量）

	return {
		/** 入队一首；已在队列里则返回既有任务 */
		enqueue(track) {
			const bvid = track?.bvid
			if (!bvid) throw new Error('缺少 bvid，无法下载')
			const existing = tasks.get(bvid)
			if (existing) return snapshot(existing)

			const task = {
				bvid,
				title: track.title ?? bvid,
				artist: track.artist ?? track.artist_name ?? null,
				state: TASK_STATE.QUEUED,
				bytesWritten: 0,
				bytesTotal: null,
				enqueuedAt: Date.now(),
			}
			tasks.set(bvid, task)
			emit({ type: 'updated', task: snapshot(task) })
			pump()
			return snapshot(task)
		},

		/** 批量入队 */
		enqueueMany(tracks) {
			return (tracks ?? []).map((track) => this.enqueue(track))
		},

		/** 取消（未开始或进行中都可） */
		cancel(bvid) {
			const task = tasks.get(bvid)
			if (!task) return false
			const controller = controllers.get(bvid)
			if (controller) controller.abort()
			else if (task.state === TASK_STATE.QUEUED) {
				task.state = TASK_STATE.CANCELED
				emit({ type: 'updated', task: snapshot(task) })
			}
			return true
		},

		/** 清掉已结束的任务记录，但**保留磁盘上的文件** */
		clearFinished() {
			let removed = 0
			for (const [bvid, task] of tasks) {
				if (
					task.state === TASK_STATE.DONE ||
					task.state === TASK_STATE.FAILED ||
					task.state === TASK_STATE.CANCELED
				) {
					tasks.delete(bvid)
					removed += 1
				}
			}
			return removed
		},

		/** 删除一个已下载的文件 */
		remove(bvid) {
			const task = tasks.get(bvid)
			const target = task?.path
			if (!target) return false
			try {
				fs.unlinkSync(target)
				tasks.delete(bvid)
				return true
			} catch {
				return false
			}
		},

		listTasks: () => [...tasks.values()].map(snapshot),
		listDownloaded,
		findExisting,
		/** 已下载文件占用的总字节数 */
		totalBytes() {
			return listDownloaded().reduce((sum, item) => sum + item.bytes, 0)
		},
		downloadDir,
		maxParallel: limit,
		EXPORT_EXTENSION,
		STATE: TASK_STATE,

		on(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},

		describe() {
			return {
				downloadDir,
				maxParallel: limit,
				downloadedCount: listDownloaded().length,
				totalBytes: this.totalBytes(),
				activeTaskCount: [...tasks.values()].filter(
					(task) =>
						task.state === TASK_STATE.RESOLVING ||
						task.state === TASK_STATE.DOWNLOADING,
				).length,
				taskCount: tasks.size,
			}
		},
	}
}

module.exports = {
	createDownloadManager,
	sanitizeFilename,
	buildFilename,
	uniquePath,
	TASK_STATE,
	EXPORT_EXTENSION,
	REFERER,
	DESKTOP_UA,
}
