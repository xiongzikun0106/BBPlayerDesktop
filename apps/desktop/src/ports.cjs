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

const sqlite = {
	execSync: (source) => db.exec(source),
	runSync: (source, params) => db.prepare(source).run(...(params ?? [])),
	getFirstSync: (source, params) =>
		db.prepare(source).get(...(params ?? [])) ?? null,
	getAllSync: (source, params) => db.prepare(source).all(...(params ?? [])),
	withTransactionSync: (task) => {
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
// B 站凭据（cookie 落盘）
// ---------------------------------------------------------------

let cookieCache = readJsonFile(COOKIE_FILE, null)

const bilibili = {
	getCookie: async () => cookieCache,
	setCookie: async (cookie) => {
		cookieCache = cookie
		writeJsonFile(COOKIE_FILE, cookie)
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
	return {
		dataDir: DATA_DIR,
		kvFile: KV_FILE,
		cookieFile: COOKIE_FILE,
		dbFile: DB_FILE,
		logFile: LOG_FILE,
		hasCookie: Boolean(cookieCache),
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
	describePorts,
	sqlite,
	db,
	storage,
	DATA_DIR,
	/** 已注册的 core 模块（避免各文件重复 loadCore） */
	core,
}
