/* oxlint-disable no-console -- 验证脚本，以 stdout 输出 */
/**
 * Phase 4 验收：下载（落盘 / 续传 / 完整性 / 并发 / 文件名）。
 *
 * ## 为什么要起本地 HTTP 服务器
 *
 * 下载逻辑里最容易错的是 **Range 续传**与**完整性校验**，而公网 CDN
 * 的节点行为是随机的（同一首歌可能被路由到不实现 Range 的 PCDN 节点）。
 * 对着它测，失败了你分不清是代码错还是节点抽风。所以这里起一个
 * **行为可控**的本地服务器，可切换：
 *   * `range`    支持 Range 并回 206 —— 验证续传
 *   * `ignore`   忽略 Range 回 200 —— 验证代码能识别并从头下
 *   * `truncate` 声称 300000 字节但只发 50000 —— 验证完整性校验拦得住
 *   * `primaryBroken` 主地址 500 —— 验证备用地址回退
 *
 * ## 子进程的写法
 *
 * 不用字符串模板拼 JS（那样双份转义很容易出错，实测被 PowerShell 的
 * 引号规则坑过），而是把「一段函数」序列化后交给子进程执行：
 * 函数体是真实代码，有语法高亮与检查，且**不需要手工处理换行/转义**。
 *
 * 用法：node scripts/verify-download.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')

const DATA_DIR = path.join(os.tmpdir(), `bbplayer-download-${Date.now()}`)
const DOWNLOAD_DIR = path.join(DATA_DIR, 'downloads')
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })

/** 内容可辨识：每个字节 = (index % 251)，便于逐字节比对 */
const PAYLOAD = Buffer.alloc(300_000)
for (let i = 0; i < PAYLOAD.length; i += 1) PAYLOAD[i] = i % 251
// 落一份到磁盘，供子进程做逐字节比对的基准
fs.writeFileSync(path.join(DATA_DIR, 'expected.bin'), PAYLOAD)

let passed = 0
let failed = 0
function check(label, ok, detail = '') {
	if (ok) {
		passed++
		console.log(`  ✅ ${label}${detail ? `  — ${detail}` : ''}`)
	} else {
		failed++
		console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`)
	}
}

/**
 * 在 apps/desktop 里跑一段**异步函数体**，返回它的返回值。
 *
 * `body` 是真实函数对象（不是字符串），所以：
 *   * 不需要手工处理换行、引号、模板字面量的转义；
 *   * 有语法检查与编辑器高亮；
 *   * 参数通过下面的 `args` 注入，避免字符串拼 JSON。
 *
 * @param {(...args: unknown[]) => unknown} body
 * @param {unknown[]} [args]
 */
function runInDesktop(body, args = []) {
	return new Promise((resolve, reject) => {
		const script = `
			;(async () => {
				const fn = ${body.toString()}
				try {
					const value = await fn(...${JSON.stringify(args)})
					console.log('__RESULT__' + JSON.stringify(value))
				} catch (error) {
					console.log('__RESULT__' + JSON.stringify({ __error: error.message }))
				}
			})()
		`
		const child = spawn(process.execPath, ['-e', script], {
			cwd: DESKTOP,
			env: { ...process.env, BBPLAYER_DATA_DIR: DATA_DIR },
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', (chunk) => {
			stdout += chunk.toString()
		})
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString()
		})
		const timer = setTimeout(() => {
			child.kill()
			reject(new Error(`超时:\n${stdout}\n${stderr}`))
		}, 90_000)
		child.on('exit', (code) => {
			clearTimeout(timer)
			const marker = stdout.lastIndexOf('__RESULT__')
			if (marker === -1) {
				reject(
					new Error(
						`无结果（exit=${code}）\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
					),
				)
				return
			}
			const parsed = JSON.parse(
				stdout.slice(marker + '__RESULT__'.length).trim(),
			)
			if (parsed?.__error) reject(new Error(parsed.__error))
			else resolve(parsed)
		})
	})
}

// ===============================================================
// 可控的本地音频服务器
// ===============================================================

const serverState = {
	mode: 'range',
	primaryBroken: false,
	requests: [],
}

const server = http.createServer((req, res) => {
	const range = req.headers.range ?? null
	serverState.requests.push({ path: req.url ?? '', range })

	if (serverState.primaryBroken && req.url === '/audio-primary.m4s') {
		res.writeHead(500)
		res.end('boom')
		return
	}

	if (serverState.mode === 'ignore') {
		res.writeHead(200, {
			'Content-Type': 'audio/mp4',
			'Content-Length': PAYLOAD.length,
		})
		res.end(PAYLOAD)
		return
	}

	if (serverState.mode === 'truncate') {
		res.writeHead(200, {
			'Content-Type': 'audio/mp4',
			'Content-Length': PAYLOAD.length,
		})
		res.end(PAYLOAD.subarray(0, 50_000))
		return
	}

	if (range) {
		const match = /bytes=(\d+)-/.exec(range)
		const start = match ? Number(match[1]) : 0
		const body = PAYLOAD.subarray(start)
		res.writeHead(206, {
			'Content-Type': 'audio/mp4',
			'Content-Length': body.length,
			'Content-Range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
			'Accept-Ranges': 'bytes',
		})
		res.end(body)
		return
	}

	res.writeHead(200, {
		'Content-Type': 'audio/mp4',
		'Content-Length': PAYLOAD.length,
		'Accept-Ranges': 'bytes',
	})
	res.end(PAYLOAD)
})

console.log('=== Phase 4 验收：下载 ===\n')

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
const ORIGIN = `http://127.0.0.1:${port}`
console.log(`本地音频服务器：${ORIGIN}（${PAYLOAD.length} 字节）`)
console.log(`下载目录：${DOWNLOAD_DIR}\n`)

const EXPECTED_PATH = path.join(DATA_DIR, 'expected.bin')

try {
	// ===============================================================
	// 1. 纯函数：文件名清洗与去重
	// ===============================================================

	console.log('1. 文件名清洗与去重\n')

	const pure = await runInDesktop(
		(dir) => {
			const d = require('./src/download.cjs')
			const fs = require('node:fs')
			const path = require('node:path')
			fs.mkdirSync(dir, { recursive: true })
			fs.writeFileSync(path.join(dir, '歌名.m4a'), 'x')

			const uniqueFirst = path.basename(d.uniquePath(dir, '歌名.m4a'))
			fs.writeFileSync(path.join(dir, '歌名 (2).m4a'), 'x')
			const uniqueSecond = path.basename(d.uniquePath(dir, '歌名.m4a'))
			fs.writeFileSync(path.join(dir, '歌名 (3).m4a'), 'x')
			const uniqueThird = path.basename(d.uniquePath(dir, '歌名.m4a'))

			return {
				sanitize: {
					slashes: d.sanitizeFilename('a/b\\c'),
					windows: d.sanitizeFilename('a:b*c?d"e<f>g|h'),
					trimmed: d.sanitizeFilename('   空格   '),
					empty: d.sanitizeFilename(''),
				},
				filename: {
					normal: d.buildFilename({ title: '正常歌名', bvid: 'BV1' }),
					illegal: d.buildFilename({ title: 'a/b:c', bvid: 'BV1' }),
					emptyTitle: d.buildFilename({ title: '', bvid: 'BV1abc' }),
					dotsOnly: d.buildFilename({ title: '...', bvid: 'BV1abc' }),
					spacesOnly: d.buildFilename({ title: '   ', bvid: 'BV1abc' }),
					extension: d.EXPORT_EXTENSION,
				},
				unique: { uniqueFirst, uniqueSecond, uniqueThird },
			}
		},
		[path.join(DATA_DIR, 'name-test')],
	)

	check(
		'非法字符被替换为下划线（斜杠与反斜杠）',
		pure.sanitize?.slashes === 'a_b_c',
		pure.sanitize?.slashes,
	)
	check(
		'Windows 禁用字符全部被替换（与移动端同一字符集）',
		pure.sanitize?.windows === 'a_b_c_d_e_f_g_h',
		pure.sanitize?.windows,
	)
	check(
		'首尾空格被去掉',
		pure.sanitize?.trimmed === '空格',
		pure.sanitize?.trimmed,
	)
	check(
		'扩展名恒为 .m4a（与移动端一致，m4s/m4a 同为 ISOBMFF 无需转码）',
		pure.filename?.normal === '正常歌名.m4a' &&
			pure.filename?.extension === '.m4a',
		pure.filename?.normal,
	)
	check(
		'标题里的非法字符被清洗',
		pure.filename?.illegal === 'a_b_c.m4a',
		pure.filename?.illegal,
	)
	check(
		'空标题退回用 bvid（不会产生只有扩展名的文件）',
		pure.filename?.emptyTitle === 'BV1abc.m4a',
		pure.filename?.emptyTitle,
	)
	check(
		'只有点的标题也被兜住（Windows 上无法创建这种文件名）',
		pure.filename?.dotsOnly === 'BV1abc.m4a',
		pure.filename?.dotsOnly,
	)
	check(
		'只有空格的标题也被兜住',
		pure.filename?.spacesOnly === 'BV1abc.m4a',
		pure.filename?.spacesOnly,
	)
	check(
		'文件名占用时依次递增 (2) / (3)',
		pure.unique?.uniqueFirst === '歌名 (2).m4a' &&
			pure.unique?.uniqueSecond === '歌名 (3).m4a' &&
			pure.unique?.uniqueThird === '歌名 (4).m4a',
		`${pure.unique?.uniqueFirst} -> ${pure.unique?.uniqueSecond} -> ${pure.unique?.uniqueThird}`,
	)

	// ===============================================================
	// 2. 完整下载
	// ===============================================================

	console.log('\n2. 完整下载与字节完整性\n')

	const full = await runInDesktop(
		({ origin, dir, expectedPath }) => {
			const d = require('./src/download.cjs')
			const fs = require('node:fs')
			fs.mkdirSync(dir, { recursive: true })

			const manager = d.createDownloadManager({
				downloadDir: dir,
				maxParallel: 1,
				resolveStream: async () => ({
					url: `${origin}/audio.m4s`,
					tier: 'requested',
					qualityId: 30280,
				}),
				log: () => {},
			})

			return new Promise((resolve) => {
				manager.on((event) => {
					const finished =
						event.type === 'done' ||
						(event.type === 'updated' &&
							['failed', 'canceled'].includes(event.task.state))
					if (!finished) return

					const task = event.task
					const expected = fs.readFileSync(expectedPath)
					const actual = task.path
						? fs.readFileSync(task.path)
						: Buffer.alloc(0)
					resolve({
						state: task.state,
						error: task.error,
						bytesWritten: task.bytesWritten,
						bytesTotal: task.bytesTotal,
						filename: task.filename,
						identical:
							actual.length === expected.length && actual.equals(expected),
						actualBytes: actual.length,
						expectedBytes: expected.length,
						quality: task.quality,
						tier: task.tier,
						describe: manager.describe(),
						listDownloaded: manager.listDownloaded().map((x) => x.filename),
						partFiles: fs.readdirSync(dir).filter((n) => n.endsWith('.part')),
					})
				})
				manager.enqueue({ bvid: 'BV1full', title: '完整下载测试' })
			})
		},
		[
			{
				origin: ORIGIN,
				dir: path.join(DATA_DIR, 'run-full'),
				expectedPath: EXPECTED_PATH,
			},
		],
	)

	check(
		'下载状态为 done',
		full.state === 'done',
		`${full.state} ${full.error ?? ''}`,
	)
	check(
		'字节数与源文件一致',
		full.bytesWritten === PAYLOAD.length && full.bytesTotal === PAYLOAD.length,
		`${full.bytesWritten}/${full.bytesTotal}，期望 ${PAYLOAD.length}`,
	)
	check(
		'落盘内容与源逐字节相同',
		full.identical === true,
		`实际 ${full.actualBytes} 字节 vs 期望 ${full.expectedBytes} 字节`,
	)
	check(
		'文件名来自标题且扩展名为 .m4a',
		full.filename === '完整下载测试.m4a',
		full.filename,
	)
	check(
		'记录了解析到的音质档位',
		full.quality === 30280 && full.tier === 'requested',
		`quality=${full.quality} tier=${full.tier}`,
	)
	check(
		'完成后不残留 .part 临时文件',
		(full.partFiles ?? []).length === 0,
		JSON.stringify(full.partFiles),
	)
	check(
		'listDownloaded 能发现该文件',
		(full.listDownloaded ?? []).includes('完整下载测试.m4a'),
		JSON.stringify(full.listDownloaded),
	)
	check(
		'describe 报告目录与占用空间',
		full.describe?.downloadedCount === 1 &&
			full.describe?.totalBytes === PAYLOAD.length,
		JSON.stringify(full.describe),
	)

	// ===============================================================
	// 3. 断点续传
	// ===============================================================

	console.log('\n3. 断点续传（Range）\n')

	/** 预置半截 .part 的比例，用于断言服务器收到的 Range */
	const HALF_RATIO = 0.4
	const halfBytes = Math.floor(PAYLOAD.length * HALF_RATIO)

	const beforeResume = serverState.requests.length
	const resume = await runInDesktop(
		({ origin, dir, expectedPath, ratio }) => {
			const d = require('./src/download.cjs')
			const fs = require('node:fs')
			const path = require('node:path')
			fs.mkdirSync(dir, { recursive: true })

			// 预置「下载了一半」的 .part
			const expected = fs.readFileSync(expectedPath)
			const half = Math.floor(expected.length * ratio)
			fs.writeFileSync(
				path.join(dir, '续传测试.m4a.part'),
				expected.subarray(0, half),
			)

			const manager = d.createDownloadManager({
				downloadDir: dir,
				maxParallel: 1,
				resolveStream: async () => ({ url: `${origin}/audio.m4s` }),
				log: () => {},
			})

			return new Promise((resolve) => {
				manager.on((event) => {
					const finished =
						event.type === 'done' ||
						(event.type === 'updated' &&
							['failed', 'canceled'].includes(event.task.state))
					if (!finished) return
					const task = event.task
					const actual = task.path
						? fs.readFileSync(task.path)
						: Buffer.alloc(0)
					resolve({
						state: task.state,
						error: task.error,
						half,
						bytesWritten: task.bytesWritten,
						expectedBytes: expected.length,
						identical: actual.equals(expected),
					})
				})
				manager.enqueue({ bvid: 'BV1resume', title: '续传测试' })
			})
		},
		[
			{
				origin: ORIGIN,
				dir: path.join(DATA_DIR, 'run-resume'),
				expectedPath: EXPECTED_PATH,
				ratio: HALF_RATIO,
			},
		],
	)

	const resumeRequests = serverState.requests.slice(beforeResume)
	const rangedRequest = resumeRequests.find((entry) => entry.range)

	check(
		'续传后状态为 done',
		resume.state === 'done',
		`${resume.state} ${resume.error ?? ''}`,
	)
	check(
		'续传后文件与源逐字节相同',
		resume.identical === true,
		`写出 ${resume.bytesWritten} 字节，源 ${resume.expectedBytes} 字节`,
	)
	check(
		'服务器收到了带 offset 的 Range（真的续传，不是重下）',
		rangedRequest?.range === `bytes=${halfBytes}-`,
		`Range: ${rangedRequest?.range ?? '（没有带 Range 的请求）'}，预置了 ${halfBytes} 字节`,
	)

	// ===============================================================
	// 4. 上游忽略 Range
	// ===============================================================

	console.log('\n4. 上游忽略 Range 时从头下（回 200）\n')

	serverState.mode = 'ignore'
	const ignoreRange = await runInDesktop(
		({ origin, dir, expectedPath }) => {
			const d = require('./src/download.cjs')
			const fs = require('node:fs')
			const path = require('node:path')
			fs.mkdirSync(dir, { recursive: true })

			// 预置一个**内容错误**的 .part：如果代码盲目追加，结果必然不等于源
			fs.writeFileSync(
				path.join(dir, '忽略Range.m4a.part'),
				Buffer.alloc(1000, 0xab),
			)

			const manager = d.createDownloadManager({
				downloadDir: dir,
				maxParallel: 1,
				resolveStream: async () => ({ url: `${origin}/audio.m4s` }),
				log: () => {},
			})
			return new Promise((resolve) => {
				manager.on((event) => {
					const finished =
						event.type === 'done' ||
						(event.type === 'updated' &&
							['failed', 'canceled'].includes(event.task.state))
					if (!finished) return
					const task = event.task
					const expected = fs.readFileSync(expectedPath)
					const actual = task.path
						? fs.readFileSync(task.path)
						: Buffer.alloc(0)
					resolve({
						state: task.state,
						error: task.error,
						bytesWritten: task.bytesWritten,
						expectedBytes: expected.length,
						identical: actual.equals(expected),
					})
				})
				manager.enqueue({ bvid: 'BV1ignore', title: '忽略Range' })
			})
		},
		[
			{
				origin: ORIGIN,
				dir: path.join(DATA_DIR, 'run-ignore'),
				expectedPath: EXPECTED_PATH,
			},
		],
	)

	check(
		'上游回 200 时状态仍为 done',
		ignoreRange.state === 'done',
		`${ignoreRange.state} ${ignoreRange.error ?? ''}`,
	)
	check(
		'识别出上游没接受 Range，从头下对了（没有盲目追加脏数据）',
		ignoreRange.identical === true,
		`写出 ${ignoreRange.bytesWritten} 字节，源 ${ignoreRange.expectedBytes} 字节`,
	)
	serverState.mode = 'range'

	// ===============================================================
	// 5. 完整性校验
	// ===============================================================

	console.log('\n5. 完整性校验（截断必须失败而不是留下坏文件）\n')

	serverState.mode = 'truncate'
	const truncate = await runInDesktop(
		({ origin, dir }) => {
			const d = require('./src/download.cjs')
			const fs = require('node:fs')
			const path = require('node:path')
			fs.mkdirSync(dir, { recursive: true })

			const manager = d.createDownloadManager({
				downloadDir: dir,
				maxParallel: 1,
				resolveStream: async () => ({ url: `${origin}/audio.m4s` }),
				log: () => {},
			})
			return new Promise((resolve) => {
				manager.on((event) => {
					const finished =
						event.type === 'done' ||
						(event.type === 'updated' &&
							['failed', 'canceled'].includes(event.task.state))
					if (!finished) return
					resolve({
						state: event.task.state,
						error: event.task.error,
						bytesWritten: event.task.bytesWritten,
						finalFileExists: fs.existsSync(path.join(dir, '截断测试.m4a')),
						partFileExists: fs.existsSync(path.join(dir, '截断测试.m4a.part')),
						files: fs.readdirSync(dir),
					})
				})
				manager.enqueue({ bvid: 'BV1trunc', title: '截断测试' })
			})
		},
		[{ origin: ORIGIN, dir: path.join(DATA_DIR, 'run-truncate') }],
	)
	serverState.mode = 'range'

	check(
		'被截断的下载判定为 failed（不是 done）',
		truncate.state === 'failed',
		`state=${truncate.state}`,
	)
	check(
		'失败原因明确指出字节数不足，并把无意义的上游错误翻译成人话',
		/不完整|下载中断/.test(String(truncate.error)) &&
			String(truncate.error).includes('50000') &&
			String(truncate.error).includes('300000'),
		String(truncate.error).slice(0, 120),
	)
	check(
		'没有生成成品文件（不会让用户以为下好了）',
		truncate.finalFileExists === false,
		JSON.stringify(truncate.files),
	)
	check(
		'保留 .part 以便重试续传',
		truncate.partFileExists === true,
		JSON.stringify(truncate.files),
	)

	// ===============================================================
	// 6. 备用地址回退
	// ===============================================================

	console.log('\n6. 主地址失败时回退到备用地址\n')

	serverState.primaryBroken = true
	const fallback = await runInDesktop(
		({ origin, dir, expectedPath }) => {
			const d = require('./src/download.cjs')
			const fs = require('node:fs')
			fs.mkdirSync(dir, { recursive: true })

			const manager = d.createDownloadManager({
				downloadDir: dir,
				maxParallel: 1,
				resolveStream: async () => ({
					// 这个会 500
					url: `${origin}/audio-primary.m4s`,
					backupUrls: [`${origin}/audio-backup.m4s`],
				}),
				log: () => {},
			})
			return new Promise((resolve) => {
				manager.on((event) => {
					const finished =
						event.type === 'done' ||
						(event.type === 'updated' &&
							['failed', 'canceled'].includes(event.task.state))
					if (!finished) return
					const task = event.task
					const expected = fs.readFileSync(expectedPath)
					const actual = task.path
						? fs.readFileSync(task.path)
						: Buffer.alloc(0)
					resolve({
						state: task.state,
						error: task.error,
						identical: actual.equals(expected),
						upstreamHost: task.upstreamHost,
					})
				})
				manager.enqueue({ bvid: 'BV1fallback', title: '回退测试' })
			})
		},
		[
			{
				origin: ORIGIN,
				dir: path.join(DATA_DIR, 'run-fallback'),
				expectedPath: EXPECTED_PATH,
			},
		],
	)
	serverState.primaryBroken = false

	check(
		'主地址 500 时回退到备用地址并成功（移动端不用 backup_url，这里是有意补上的）',
		fallback.state === 'done' && fallback.identical === true,
		`state=${fallback.state} ${fallback.error ?? ''}`,
	)

	// ===============================================================
	// 7. 并发、去重、清理
	// ===============================================================

	console.log('\n7. 并发上限与任务管理\n')

	const concurrency = await runInDesktop(
		({ origin, dir }) => {
			const d = require('./src/download.cjs')
			const fs = require('node:fs')
			fs.mkdirSync(dir, { recursive: true })

			const manager = d.createDownloadManager({
				downloadDir: dir,
				maxParallel: 2,
				resolveStream: async () => ({ url: `${origin}/audio.m4s` }),
				log: () => {},
			})

			const tracks = [1, 2, 3, 4, 5].map((n) => ({
				bvid: `BV1c${n}`,
				title: `并发${n}`,
			}))
			manager.enqueueMany(tracks)

			const runningNow = manager
				.listTasks()
				.filter((t) => ['resolving', 'downloading'].includes(t.state)).length
			const queuedNow = manager
				.listTasks()
				.filter((t) => t.state === 'queued').length

			const before = manager.listTasks().length
			manager.enqueue(tracks[0])
			const after = manager.listTasks().length

			return new Promise((resolve) => {
				// settled 守卫：轮询成功与 60s 超时是两个独立的触发源。
				// 时间清理放在两个触发源各自的回调里（不放进 finish），
				// 这样 finish 体内只有一次 resolve —— 结构上就只可能 resolve 一次。
				let settled = false

				const timer = setInterval(() => {
					if (settled) return
					const active = manager
						.listTasks()
						.filter((t) =>
							['queued', 'resolving', 'downloading'].includes(t.state),
						).length
					if (active > 0) return

					settled = true
					clearInterval(timer)
					clearTimeout(deadline)

					// ⚠️ 必须先取状态快照，**再** clearFinished()。
					// 第一版顺序反了：clearFinished 把 5 条已结束的任务记录都删掉，
					// 之后 listTasks() 自然是空的，于是「5 首全部完成」误判为失败。
					const states = manager.listTasks().map((t) => t.state)
					const downloaded = manager
						.listDownloaded()
						.map((x) => x.filename)
						.sort()
					const cleared = manager.clearFinished()
					resolve({
						runningNow,
						queuedNow,
						before,
						after,
						states,
						downloaded,
						cleared,
						filesAfterClear: fs
							.readdirSync(dir)
							.filter((n) => n.endsWith('.m4a')).length,
						maxParallel: manager.maxParallel,
					})
				}, 100)

				const deadline = setTimeout(() => {
					if (settled) return
					settled = true
					clearInterval(timer)
					resolve({ timeout: true })
				}, 60_000)
			})
		},
		[{ origin: ORIGIN, dir: path.join(DATA_DIR, 'run-concurrent') }],
	)

	check(
		'并发上限生效（maxParallel=2 时同时最多 2 个在跑）',
		concurrency.runningNow <= 2,
		`同时在跑 ${concurrency.runningNow} 个`,
	)
	check(
		'其余任务处于排队态',
		concurrency.queuedNow >= 3,
		`排队 ${concurrency.queuedNow} 个`,
	)
	check(
		'重复入队同一首不会产生第二个任务',
		concurrency.after === concurrency.before,
		`${concurrency.before} -> ${concurrency.after}`,
	)
	check(
		'5 首全部下载完成',
		(concurrency.states ?? []).filter((s) => s === 'done').length === 5,
		JSON.stringify(concurrency.states),
	)
	check(
		'磁盘上是 5 个文件',
		(concurrency.downloaded ?? []).length === 5,
		JSON.stringify(concurrency.downloaded),
	)
	check(
		'clearFinished 清掉任务记录但保留磁盘文件',
		concurrency.cleared === 5 && concurrency.filesAfterClear === 5,
		`清掉 ${concurrency.cleared} 条记录，磁盘仍有 ${concurrency.filesAfterClear} 个文件`,
	)

	const clamp = await runInDesktop(
		(baseDir) => {
			const d = require('./src/download.cjs')
			const fs = require('node:fs')
			const path = require('node:path')
			const mk = (n) => {
				const dir = path.join(baseDir, `clamp-${n}`)
				fs.mkdirSync(dir, { recursive: true })
				return d.createDownloadManager({
					downloadDir: dir,
					maxParallel: n,
					log: () => {},
				}).maxParallel
			}
			return {
				zero: mk(0),
				huge: mk(99),
				negative: mk(-5),
				text: mk('abc'),
				ok: mk(3),
			}
		},
		[DATA_DIR],
	)

	check(
		'非法 maxParallel 被夹到 1–6（0 / 99 / -5 / 非数字）',
		clamp.zero === 1 &&
			clamp.huge === 6 &&
			clamp.negative === 1 &&
			clamp.text === 1 &&
			clamp.ok === 3,
		JSON.stringify(clamp),
	)
} finally {
	await new Promise((resolve) => server.close(() => resolve()))
}

console.log(`\n=== 结果：${passed} 通过, ${failed} 失败 ===`)
console.log(`（下载目录保留供检查：${DOWNLOAD_DIR}）`)
process.exit(failed === 0 ? 0 : 1)
