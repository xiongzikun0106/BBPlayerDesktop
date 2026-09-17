/**
 * 桌面端（Node / Electron 主进程）的端口实现。
 *
 * `packages/core` 只认识 `packages/core/src/ports` 里的接口；这里把
 * Node 的能力接上去：`node:sqlite` 作数据库、文件作 KV 与凭据存储、
 * Node 原生 `fetch` 作 HTTP。
 */
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

/** 数据目录：交给 Electron 的 userData，或退回临时目录（纯 Node 场景） */
function resolveDataDir() {
	if (process.env.BBPLAYER_DATA_DIR) return process.env.BBPLAYER_DATA_DIR
	try {
		// 只在 Electron 里可用；纯 Node 下 require 会抛，走 catch
		const { app } = require('electron')
		if (app?.getPath) return app.getPath('userData')
	} catch {
		// 非 Electron 环境
	}
	return path.join(process.env.TEMP ?? '/tmp', 'bbplayer-desktop')
}

/**
 * 在 Electron 里把 `userData` / `sessionData` 指到我们自己的数据目录。
 *
 * ⚠️ 必须在 `app.whenReady()` **之前**调用。若在 ready 之后再改路径：
 * Chromium 的磁盘缓存已按旧路径初始化，改路径后缓存目录不存在，会持续报
 * `Gpu Cache Creation failed: -2` / `Unable to create cache`，最终
 * **network service 崩溃并重启** —— 表现为媒体请求挂住、一直不播。
 * 这是实测踩到的坑：`--ui-probe` 里点「播放全部」后 `paused=false` 但
 * `currentTime` 永远停在 0，而日志里就是上面那两行缓存错误。
 *
 * `sessionData` 一并指过去，确保 Chromium 的缓存有可写目录。
 */
function configureElectronPaths() {
	if (!process.env.BBPLAYER_DATA_DIR) return false
	try {
		const { app } = require('electron')
		if (!app?.setPath) return false
		fs.mkdirSync(process.env.BBPLAYER_DATA_DIR, { recursive: true })
		app.setPath('userData', process.env.BBPLAYER_DATA_DIR)
		app.setPath('sessionData', process.env.BBPLAYER_DATA_DIR)
		return true
	} catch {
		return false
	}
}

const DATA_DIR = resolveDataDir()
fs.mkdirSync(DATA_DIR, { recursive: true })

const KV_FILE = path.join(DATA_DIR, 'kv.json')
const COOKIE_FILE = path.join(DATA_DIR, 'bilibili-cookie.json')
const DB_FILE = path.join(DATA_DIR, 'bbplayer.db')

// ---------------------------------------------------------------
// KV：整个文件读写，规模很小（配置 + 缓存键）
// ---------------------------------------------------------------

function readJsonFile(file, fallback) {
	try {
		if (!fs.existsSync(file)) return fallback
		return JSON.parse(fs.readFileSync(file, 'utf8'))
	} catch {
		return fallback
	}
}

function writeJsonFile(file, value) {
	try {
		fs.writeFileSync(file, JSON.stringify(value, null, '\t'))
	} catch (error) {
		// oxlint-disable-next-line no-console -- 端口层无法依赖 core 的 logger（它本身要用端口），故直接输出
		console.error(`[ports] 写入 ${path.basename(file)} 失败:`, error.message)
	}
}

let kvCache = readJsonFile(KV_FILE, {})

const storage = {
	getString: (key) => kvCache[key],
	getBoolean: (key) => {
		const value = kvCache[key]
		if (value === undefined) return undefined
		return value === true || value === 'true'
	},
	set: (key, value) => {
		kvCache[key] = value
		writeJsonFile(KV_FILE, kvCache)
	},
	delete: (key) => {
		delete kvCache[key]
		writeJsonFile(KV_FILE, kvCache)
	},
	contains: (key) => key in kvCache,
	clearAll: () => {
		kvCache = {}
		writeJsonFile(KV_FILE, kvCache)
	},
}

// ---------------------------------------------------------------
// 安全存储：这里用同一份 JSON（桌面端真正落地时应换成系统钥匙串）
// ---------------------------------------------------------------

const secureCache = readJsonFile(KV_FILE.replace('kv.json', 'secure.json'), {})

const secureStorage = {
	getItem: async (key) => secureCache[key] ?? null,
	setItem: async (key, value) => {
		secureCache[key] = value
		writeJsonFile(KV_FILE.replace('kv.json', 'secure.json'), secureCache)
	},
	deleteItem: async (key) => {
		delete secureCache[key]
		writeJsonFile(KV_FILE.replace('kv.json', 'secure.json'), secureCache)
	},
}

// ---------------------------------------------------------------
// SQLite（node:sqlite，Node 22.5+ 内置）
// ---------------------------------------------------------------

const db = new DatabaseSync(DB_FILE)
// 外键约束默认关闭，必须每次连接时手动开启（与移动端 db.ts 的做法一致）
db.exec('PRAGMA foreign_keys = ON;')

/**
 * 数据库是否已被显式关闭。
 *
 * 恢复备份时必须先把连接关掉：Windows 上**打开着的文件不能被 rename**
 * （实测 `EBUSY: resource busy or locked`），而恢复的语义是整体替换数据库
 * 文件。移动端也一样 —— 它 `expoDb.closeSync()` 之后替换文件，并要求
 * **重启应用**才算恢复完成。
 *
 * 所以这里用一个断路器：关闭之后所有访问都抛明确的错误，而不是让调用方
 * 拿到一个「看起来能用、其实读到的是旧内存页」的连接（那会静默毁数据）。
 */
let dbClosed = false

/** 断路器：库已关闭时拒绝任何访问，并给出可执行的提示 */
function assertOpen(operation) {
	if (dbClosed) {
		throw new Error(
			`数据库已关闭（${operation}）：恢复备份后需要重启应用才能继续使用`,
		)
	}
}

/** 显式关闭数据库连接。恢复备份前必须调用；关闭后本进程内不可再访问。 */
function closeDatabase() {
	if (dbClosed) return false
	dbClosed = true
	try {
		db.close()
	} catch {
		// 已关闭或从未打开都无所谓，目标是「连接确实不在了」
	}
	return true
}

function isDatabaseClosed() {
	return dbClosed
}

const sqlite = {
	execSync: (source) => {
		assertOpen('execSync')
		return db.exec(source)
	},
	runSync: (source, params) => {
		assertOpen('runSync')
		return db.prepare(source).run(...(params ?? []))
	},
	getFirstSync: (source, params) => {
		assertOpen('getFirstSync')
		return db.prepare(source).get(...(params ?? [])) ?? null
	},
	getAllSync: (source, params) => {
		assertOpen('getAllSync')
		return db.prepare(source).all(...(params ?? []))
	},
	withTransactionSync: (task) => {
		assertOpen('withTransactionSync')
		db.exec('BEGIN')
		try {
			task()
			db.exec('COMMIT')
		} catch (error) {
			db.exec('ROLLBACK')
			throw error
		}
	},
}

// ---------------------------------------------------------------
// B 站凭据
// ---------------------------------------------------------------
//
// cookie 的**读写都归 `bilibili-login.cjs` 管**（那边负责 safeStorage 加密落盘），
// 这里只做端口适配：core 的客户端调 `getCookie()`，我们从登录管理器取。
//
// 用 holder 而不是直接 require 登录模块，是为了避免
// `ports.cjs` → `bilibili-login.cjs` → （将来可能的）core 客户端 → `ports.cjs`
// 成环。`main.cjs` 在启动时注册管理器。

const { getLoginManager } = require('./bilibili-login-holder.cjs')

const bilibili = {
	getCookie: async () => getLoginManager()?.getCookie() ?? null,
	setCookie: async (cookie) => {
		// 由登录模块统一处理校验与加密，这里只在确实拿到管理器时转发
		const manager = getLoginManager()
		if (!manager) {
			throw new Error('登录管理器未初始化，无法写入 cookie')
		}
		await manager.importCookie(cookie)
	},
}

// ---------------------------------------------------------------
// Logger（写文件 + 控制台）
// ---------------------------------------------------------------

const LOG_FILE = path.join(DATA_DIR, 'desktop.log')

function writeLog(level, scope, message, meta) {
	const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), scope]
	if (message !== undefined) parts.push(String(message))
	if (meta !== undefined) {
		try {
			parts.push(typeof meta === 'string' ? meta : JSON.stringify(meta))
		} catch {
			parts.push('[unserializable]')
		}
	}
	const line = `${parts.join(' ')}\n`
	try {
		fs.appendFileSync(LOG_FILE, line)
	} catch {
		// 日志写失败不应影响主流程
	}
	if (process.env.BBPLAYER_LOG_STDOUT === '1' || level === 'error') {
		process.stdout.write(`[${scope}] ${line}`)
	}
}

function makeLogger(scope) {
	return {
		debug: (message, meta) => writeLog('debug', scope, message, meta),
		info: (message, meta) => writeLog('info', scope, message, meta),
		warn: (message, meta) => writeLog('warn', scope, message, meta),
		error: (message, meta) => writeLog('error', scope, message, meta),
		extend: (nested) => makeLogger(`${scope}.${nested}`),
	}
}

// ---------------------------------------------------------------
// 组装
// ---------------------------------------------------------------

const desktopPorts = {
	logger: makeLogger('desktop'),
	storage,
	secureStorage,
	db: { client: db, sqlite, orm: null },
	http: (input, init) =>
		fetch(String(input), {
			method: init?.method,
			headers: init?.headers,
			body: init?.body,
			signal: init?.signal,
		}),
	bilibili,
}

/** 采集诊断信息，验证脚本会检查这些值 */
function describePorts() {
	const login = getLoginManager()
	return {
		dataDir: DATA_DIR,
		kvFile: KV_FILE,
		cookieFile: COOKIE_FILE,
		dbFile: DB_FILE,
		logFile: LOG_FILE,
		hasCookie: Boolean(login?.getCookie()),
		// 不含 cookie 值，只报结构与加密状态
		login: login?.describe() ?? null,
	}
}

// ---------------------------------------------------------------
// 向 core 注册
// ---------------------------------------------------------------
//
// core 内部的模块（B 站 API 客户端、数据迁移等）通过 `getCorePorts()` 取平台能力，
// 因此必须在**任何 core 调用之前**完成注册。放在模块加载时注册，是最不容易漏的时机。
//
// 这里用惰性 require 避免「ports.cjs ↔ core-loader.cjs」的循环引用问题：
// core-loader 只依赖 jiti，不依赖本文件。
const { loadCore } = require('./core-loader.cjs')
const core = loadCore()
core.registerCorePorts(desktopPorts)

module.exports = {
	desktopPorts,
	configureElectronPaths,
	describePorts,
	sqlite,
	db,
	storage,
	DATA_DIR,
	/** 恢复备份前必须调用：关闭连接才能替换数据库文件（Windows 会 EBUSY） */
	closeDatabase,
	isDatabaseClosed,
	/** 做 scope 为 `desktop` 的 logger；主进程各处用它统一写日志文件 */
	logger: desktopPorts.logger,
	/** 已注册的 core 模块（避免各文件重复 loadCore） */
	core,
}
