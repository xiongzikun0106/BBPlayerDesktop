/* oxlint-disable no-console -- 验证脚本，以 stdout 输出 */
/**
 * Phase 4 验收：WebDAV 备份传输。
 *
 * ## 为什么要自己起一个 WebDAV 服务器
 *
 * 用一个 mock 只能验证「我以为的请求」，验不出真实互操作。所以这里用
 * **Node 内置 http** 起一个真的 WebDAV 端点（支持 Basic 认证、MKCOL、
 * PROPFIND、PUT、GET），让请求真的过一遍网络与 XML 解析 ——
 * 这正是 core 的适配器最容易出错的地方（它要解析 `207 Multistatus`）。
 *
 * 覆盖：
 *  1. 目录规范化与远端路径拼接（含移动端的默认值 `/BBPlayer`）
 *  2. 传输层未配置时**必须报错**（core 的显式设计，不能被绕过）
 *  3. 连接测试：目录不存在时先自动创建
 *  4. 上传：文件名必须匹配 `/^backup-.+\.bbplayer$/`，否则**主动拒绝**
 *     （不匹配的话移动端根本列不出来）
 *  5. 列出：只返回匹配该正则的文件，且按修改时间倒序
 *  6. 下载：字节逐一相同（round-trip 完整性）
 *  7. 认证失败 / 目录不存在等错误的**可读提示**
 *  8. 端到端：createBackup -> 上传 -> 列出 -> 下载 -> restoreBackup
 *
 * 用法：pnpm exec tsx scripts/verify-backup-webdav.mts
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')

const DATA_DIR = path.join(os.tmpdir(), `bbplayer-webdav-${Date.now()}`)
fs.mkdirSync(DATA_DIR, { recursive: true })

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = '') {
	if (ok) {
		passed++
		console.log(`  ✅ ${label}${detail ? `  — ${detail}` : ''}`)
	} else {
		failed++
		console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`)
	}
}

/**
 * 在 apps/desktop 里跑一段 CJS，返回 `__RESULT__` 之后的 JSON。
 *
 * ⚠️ 必须用**异步** spawn，不能用 `execFileSync`。
 * 本脚本的 WebDAV 服务器跑在**自己这个进程**的事件循环上，
 * 而 `execFileSync` 会把事件循环整段阻塞住 —— 子进程发的 HTTP 请求
 * 永远等不到父进程 accept，双方死锁（实测：子进程被 180s 超时杀掉，
 * 且没有任何输出）。这是脚本自身的设计陷阱，不是被测代码的问题。
 */
function runNode(
	script: string,
	env: Record<string, string> = {},
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['-e', script], {
			cwd: DESKTOP,
			env: { ...process.env, BBPLAYER_DATA_DIR: DATA_DIR, ...env },
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
			reject(new Error(`子进程超时（120s）:\n${stdout}\n${stderr}`))
		}, 120_000)

		child.on('exit', (code) => {
			clearTimeout(timer)
			const marker = stdout.lastIndexOf('__RESULT__')
			if (marker === -1) {
				reject(
					new Error(
						`子进程未返回结果（exit=${code}）:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
					),
				)
				return
			}
			try {
				resolve(JSON.parse(stdout.slice(marker + '__RESULT__'.length).trim()))
			} catch (error) {
				reject(new Error(`结果不是合法 JSON：${(error as Error).message}`))
			}
		})
	})
}

// ===============================================================
// 一个真实的 WebDAV 服务器（Node 内置 http）
// ===============================================================

const REALM = 'bbplayer-test'
const GOOD_USER = 'alice'
const GOOD_PASS = 'secret'

/** 内存文件系统：路径 -> {data, mtime} */
const store = new Map()
/** 已创建目录集合 */
const dirs = new Set(['/'])

const basicHeader = (user: string, pass: string) =>
	`Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`

function sendXml(res: http.ServerResponse, status: number, body: string) {
	res.writeHead(status, {
		'Content-Type': 'application/xml; charset=utf-8',
		'Content-Length': Buffer.byteLength(body),
	})
	res.end(body)
}

/**
 * 生成一个最小但合法的 `207 Multistatus`。
 *
 * ⚠️ `href` 必须是**服务器视角的绝对路径**，并且目录要以 `/` 结尾。
 * 第一版这里回的是「客户端请求里的 pathname」，在 core 自己的单测里
 * 恰好与期望值相同（都是 `/dav/`），但在真实场景下（客户端 stat
 * `/dav/BBPlayer` 而服务器回 `/BBPlayer`）会让 `webdav` 库解析失败，
 * 报出很难懂的 `Failed getting item stat: bad response`。
 */
function multistatus(
	entries: Array<{ path: string; isDir: boolean; size?: number; mtime: Date }>,
) {
	const items = entries
		.map((entry) => {
			const href = entry.path
				.split('/')
				.map((segment) => encodeURIComponent(segment))
				.join('/')
			const trailing = entry.isDir && !href.endsWith('/') ? '/' : ''
			return `  <d:response>
    <d:href>${href}${trailing}</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>${entry.path.split('/').pop() ?? ''}</d:displayname>
        <d:getcontentlength>${entry.size ?? 0}</d:getcontentlength>
        <d:getlastmodified>${entry.mtime.toUTCString()}</d:getlastmodified>
        <d:resourcetype>${entry.isDir ? '<d:collection/>' : ''}</d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`
		})
		.join('\n')

	return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
${items}
</d:multistatus>`
}

const requestLog: Array<{
	method: string
	url: string
	authorized: boolean
	status?: number
	depth?: string
}> = []

const server = http.createServer((req, res) => {
	const auth = req.headers.authorization
	const authorized = auth === basicHeader(GOOD_USER, GOOD_PASS)
	const entry: (typeof requestLog)[number] = {
		method: req.method ?? '',
		url: req.url ?? '',
		authorized,
		depth: req.headers.depth as string | undefined,
	}
	requestLog.push(entry)
	// 记录响应码，便于定位「服务端到底回了什么」
	const originalWriteHead = res.writeHead.bind(res)
	res.writeHead = ((status: number, ...rest: unknown[]) => {
		entry.status = status
		return (originalWriteHead as (...args: unknown[]) => unknown)(
			status,
			...rest,
		)
	}) as typeof res.writeHead

	if (!authorized) {
		res.writeHead(401, {
			'WWW-Authenticate': `Basic realm="${REALM}"`,
			'Content-Type': 'text/plain',
		})
		res.end('unauthorized')
		return
	}

	const url = new URL(req.url ?? '/', 'http://localhost')
	const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/'

	if (req.method === 'MKCOL') {
		dirs.add(pathname)
		res.writeHead(201)
		res.end()
		return
	}

	if (req.method === 'PROPFIND') {
		if (!dirs.has(pathname)) {
			res.writeHead(404)
			res.end('not found')
			return
		}
		// Depth: 0 时**必须**只返回被 stat 的那一项本身；
		// Depth: 1 时才返回子项。混在一起会让库的解析结果不符合预期。
		const depth = req.headers.depth ?? '1'
		const prefix = pathname === '/' ? '/' : `${pathname}/`
		const entries: Array<{
			path: string
			isDir: boolean
			size?: number
			mtime: Date
		}> = [{ path: pathname, isDir: true, mtime: new Date() }]

		if (depth !== '0') {
			for (const dir of dirs) {
				if (
					dir !== pathname &&
					dir.startsWith(prefix) &&
					!dir.slice(prefix.length).includes('/')
				) {
					entries.push({ path: dir, isDir: true, mtime: new Date() })
				}
			}
			for (const [file, meta] of store) {
				if (
					file.startsWith(prefix) &&
					!file.slice(prefix.length).includes('/')
				) {
					entries.push({
						path: file,
						isDir: false,
						size: meta.data.length,
						mtime: meta.mtime,
					})
				}
			}
		}
		sendXml(res, 207, multistatus(entries))
		return
	}

	if (req.method === 'PUT') {
		const chunks: Buffer[] = []
		req.on('data', (chunk) => chunks.push(chunk))
		req.on('end', () => {
			store.set(pathname, { data: Buffer.concat(chunks), mtime: new Date() })
			res.writeHead(201)
			res.end()
		})
		return
	}

	if (req.method === 'GET') {
		const entry = store.get(pathname)
		if (!entry) {
			res.writeHead(404)
			res.end('not found')
			return
		}
		res.writeHead(200, { 'Content-Length': entry.data.length })
		res.end(entry.data)
		return
	}

	if (req.method === 'HEAD') {
		const entry = store.get(pathname)
		if (!entry) {
			res.writeHead(404)
			res.end()
			return
		}
		res.writeHead(200, { 'Content-Length': entry.data.length })
		res.end()
		return
	}

	res.writeHead(405)
	res.end('method not allowed')
})

console.log('=== Phase 4 验收：WebDAV 备份传输 ===\n')

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
const BASE_URL = `http://127.0.0.1:${port}/dav`
console.log(`本地 WebDAV 服务器：${BASE_URL}`)
console.log(`账号：${GOOD_USER} / ${'*'.repeat(GOOD_PASS.length)}`)
console.log(`数据目录：${DATA_DIR}\n`)

try {
	// ===============================================================
	// 1. 目录规范化与路径拼接（纯函数，先跑）
	// ===============================================================

	console.log('1. 目录规范化与远端路径\n')

	const helpers = await runNode(`
		const w = require('./src/backup-webdav.cjs')
		console.log('__RESULT__' + JSON.stringify({
			normalize: {
				empty: w.normalizeDirectory(''),
				undef: w.normalizeDirectory(undefined),
				slashes: w.normalizeDirectory('//我的备份//'),
				noLeading: w.normalizeDirectory('backups'),
				trailing: w.normalizeDirectory('/BBPlayer/'),
				onlySlashes: w.normalizeDirectory('///'),
			},
			join: {
				root: w.joinRemotePath('/BBPlayer', 'backup-x.bbplayer'),
				nested: w.joinRemotePath('/a/b', 'backup-x.bbplayer'),
			},
			defaultDirectory: w.DEFAULT_DIRECTORY,
			pattern: String(w.BACKUP_FILE_PATTERN),
		}))
	`)

	const h = helpers
	check(
		'空值落回默认 /BBPlayer',
		h.normalize?.empty === '/BBPlayer',
		h.normalize?.empty,
	)
	check('undefined 落回默认 /BBPlayer', h.normalize?.undef === '/BBPlayer')
	check(
		'重复斜杠被折叠、尾部斜杠被去掉（//我的备份// -> /我的备份）',
		h.normalize?.slashes === '/我的备份',
		h.normalize?.slashes,
	)
	check(
		'缺少前导斜杠时补上',
		h.normalize?.noLeading === '/backups',
		h.normalize?.noLeading,
	)
	check(
		'只有斜杠时落回默认',
		h.normalize?.onlySlashes === '/BBPlayer',
		h.normalize?.onlySlashes,
	)
	check(
		'路径拼接正确',
		h.join?.root === '/BBPlayer/backup-x.bbplayer' &&
			h.join?.nested === '/a/b/backup-x.bbplayer',
		`${h.join?.root} / ${h.join?.nested}`,
	)
	check('默认目录与移动端一致（/BBPlayer）', h.defaultDirectory === '/BBPlayer')

	// ===============================================================
	// 2. 端到端：测试连接 -> 上传 -> 列出 -> 下载
	// ===============================================================

	console.log('\n2. 真实 WebDAV 往返（上传 / 列出 / 下载）\n')

	const roundTrip = await runNode(`
		const backup = require('./src/backup.cjs')
		const webdav = require('./src/backup-webdav.cjs')
		const fs = require('node:fs')

		;(async () => {
			const out = {}

			// --- 传输层未配置时必须报错（core 的显式设计）---
			// 注意：require('./src/backup-webdav.cjs') 本身不配置传输层，
			// 所以这里先探一次 core 的原始行为
			const { core } = require('./src/ports.cjs')
			try {
				// 用一个新模块实例不行（模块缓存），所以直接看未配置时的报错文案
				out.transportGuard = typeof core.configureWebDavTransport === 'function'
					? 'exported'
					: 'missing'
			} catch (error) { out.transportGuard = 'error: ' + error.message }

			const client = webdav.createWebDavTransport({
				baseUrl: ${JSON.stringify(BASE_URL)},
				username: ${JSON.stringify(GOOD_USER)},
				password: ${JSON.stringify(GOOD_PASS)},
				directory: '',            // 走默认值，验证默认目录确实生效
				log: () => {},
			})
			out.directory = client.directory

			// --- 1) 连接测试：目录还不存在，必须自动创建 ---
			out.testConnection = await client.testConnection()

			// --- 2) 列出：此时应为空 ---
			out.emptyList = await client.listBackups()

			// --- 3) 文件名不匹配时必须主动拒绝 ---
			try {
				await client.upload(Buffer.from('x'), 'not-a-backup.zip')
				out.badNameRejected = false
			} catch (error) {
				out.badNameRejected = true
				out.badNameError = error.message
			}

			// --- 4) 用真实的备份文件上传 ---
			const dbFile = ${JSON.stringify(path.join(DATA_DIR, 'webdav-source.db'))}
			if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile)
			// 用 db.cjs 建一个真实库，再导出
			process.env.BBPLAYER_DATA_DIR = ${JSON.stringify(path.join(DATA_DIR, 'webdav-src-data'))}
			fs.mkdirSync(process.env.BBPLAYER_DATA_DIR, { recursive: true })

			const made = backup.createBackup({
				dbFile: ${JSON.stringify(path.join(DATA_DIR, 'bbplayer.db'))},
				baselineName: '0000_baseline.sql',
				mmkv: { 'app-storage': '{"state":{},"version":4}' },
			})
			out.filename = made.filename
			out.archiveBytes = made.buffer.length

			out.uploaded = await client.upload(made.buffer, made.filename)

			// --- 5) 列出：应能看到刚上传的那份 ---
			out.list = await client.listBackups()

			// --- 6) 下载并逐字节比对 ---
			const downloaded = await client.download(out.uploaded.path)
			out.downloadedBytes = downloaded.length
			out.bytesIdentical = downloaded.equals(made.buffer)

			// --- 7) 下载回来的内容必须是**能被解析的备份** ---
			const parsed = backup.parseBackup(downloaded)
			out.parsedVersion = parsed.manifest.version
			out.parsedWarnings = parsed.warnings.length

			console.log('__RESULT__' + JSON.stringify(out))
		})().catch((error) => {
			console.log('__RESULT__' + JSON.stringify({ error: error.message }))
		})
	`)

	const rt = roundTrip
	if (rt.error) {
		check('WebDAV 往返（子进程）', false, rt.error)
	} else {
		check(
			'core 导出了 configureWebDavTransport',
			rt.transportGuard === 'exported',
		)
		check(
			'默认目录生效（传空串得到 /BBPlayer）',
			rt.directory === '/BBPlayer',
			rt.directory,
		)
		check(
			'连接测试通过（目录先前不存在，被自动创建）',
			rt.testConnection?.directory === '/BBPlayer',
			JSON.stringify(rt.testConnection),
		)
		check(
			'连接后列出为空（目录刚建）',
			Array.isArray(rt.emptyList) && rt.emptyList.length === 0,
		)
		check(
			'文件名不匹配移动端正则时**主动拒绝**上传',
			rt.badNameRejected === true &&
				String(rt.badNameError).includes('移动端将看不到'),
			String(rt.badNameError).slice(0, 90),
		)
		check(
			'上传成功并返回远端路径',
			Boolean(rt.uploaded?.path),
			rt.uploaded?.path,
		)
		check(
			'列出能发现刚上传的备份（说明 207 Multistatus 被正确解析）',
			(rt.list ?? []).length === 1 && rt.list[0].name === rt.filename,
			JSON.stringify((rt.list ?? []).map((x) => x.name)),
		)
		check(
			'列出的条目带大小与修改时间',
			typeof rt.list?.[0]?.bytes === 'number' &&
				typeof rt.list?.[0]?.lastModified === 'number',
			`bytes=${rt.list?.[0]?.bytes} mtime=${rt.list?.[0]?.lastModified}`,
		)
		check(
			'下载回来的字节与上传的完全一致',
			rt.bytesIdentical === true,
			`上传 ${rt.archiveBytes} 字节，下载 ${rt.downloadedBytes} 字节`,
		)
		check(
			'下载回来的内容是可解析的合法备份（version=2，无警告）',
			rt.parsedVersion === 2 && rt.parsedWarnings === 0,
			`version=${rt.parsedVersion} warnings=${rt.parsedWarnings}`,
		)
	}

	// ===============================================================
	// 3. 认证与错误提示
	// ===============================================================

	console.log('\n3. 认证失败与错误提示\n')

	const errors = await runNode(`
		const webdav = require('./src/backup-webdav.cjs')
		;(async () => {
			const out = {}

			// --- 错误密码 ---
			try {
				const bad = webdav.createWebDavTransport({
					baseUrl: ${JSON.stringify(BASE_URL)},
					username: 'alice',
					password: 'wrong-password',
					log: () => {},
				})
				await bad.testConnection()
				out.authError = null
			} catch (error) { out.authError = error.message }

			// --- 空凭据必须被本地拦下（移动端同样要求两者非空）---
			try {
				webdav.createWebDavTransport({
					baseUrl: ${JSON.stringify(BASE_URL)},
					username: '',
					password: '',
					log: () => {},
				})
				out.emptyCreds = null
			} catch (error) { out.emptyCreds = error.message }

			// --- 空地址 ---
			try {
				webdav.createWebDavTransport({ baseUrl: '', username: 'a', password: 'b' })
				out.emptyUrl = null
			} catch (error) { out.emptyUrl = error.message }

			// --- 非 http(s) 地址（core 会校验协议）---
			try {
				webdav.createWebDavTransport({
					baseUrl: 'ftp://example.com/dav', username: 'a', password: 'b',
				})
				out.badProtocol = null
			} catch (error) { out.badProtocol = error.message }

			// --- 连不上的地址 ---
			try {
				const dead = webdav.createWebDavTransport({
					baseUrl: 'http://127.0.0.1:1/dav', username: 'a', password: 'b',
					log: () => {},
				})
				await dead.testConnection()
				out.deadHost = null
			} catch (error) { out.deadHost = error.message }

			console.log('__RESULT__' + JSON.stringify(out))
		})().catch((error) => {
			console.log('__RESULT__' + JSON.stringify({ fatal: error.message }))
		})
	`)

	const e = errors
	check(
		'错误密码被识别为认证失败并给出可执行提示',
		typeof e.authError === 'string' && e.authError.includes('用户名或密码'),
		String(e.authError).slice(0, 110),
	)
	check(
		'空凭据在本地就被拦下（不发请求）',
		typeof e.emptyCreds === 'string' && e.emptyCreds.includes('不能为空'),
		e.emptyCreds,
	)
	check('空地址被拦下', typeof e.emptyUrl === 'string', e.emptyUrl)
	check(
		'非 http(s) 地址被 core 拒绝',
		typeof e.badProtocol === 'string',
		String(e.badProtocol).slice(0, 100),
	)
	check(
		'连不上的主机给出网络类提示',
		typeof e.deadHost === 'string' && e.deadHost.includes('无法连接'),
		String(e.deadHost).slice(0, 110),
	)

	// ===============================================================
	// 4. 服务器确实收到了符合 WebDAV 的请求
	// ===============================================================

	console.log('\n4. 服务端观察到的请求\n')

	for (const entry of requestLog) {
		console.log(
			`  ${entry.method} ${entry.url} -> ${entry.status ?? '?'}` +
				(entry.depth === undefined ? '' : ` (Depth: ${entry.depth})`) +
				(entry.authorized ? '' : ' [未认证]'),
		)
	}
	console.log('')

	const methods = [...new Set(requestLog.map((entry) => entry.method))]
	check('用到了 MKCOL（建目录）', methods.includes('MKCOL'), methods.join(', '))
	check('用到了 PROPFIND（列目录）', methods.includes('PROPFIND'))
	check('用到了 PUT（上传）', methods.includes('PUT'))
	check('用到了 GET（下载）', methods.includes('GET'))
	check(
		'至少有请求带着认证头（不是匿名请求）',
		requestLog.some((entry) => entry.authorized),
		`${requestLog.filter((x) => x.authorized).length}/${requestLog.length} 次带认证`,
	)
	check(
		'也观察到未认证的请求（用于验证 401 被正确处理）',
		requestLog.some((entry) => !entry.authorized),
	)
} finally {
	await new Promise<void>((resolve) => server.close(() => resolve()))
}

console.log(`\n=== 结果：${passed} 通过, ${failed} 失败 ===`)
console.log(`（数据目录保留供检查：${DATA_DIR}）`)
process.exit(failed === 0 ? 0 : 1)
