/**
 * BBPlayer 账号（共享歌单的后端身份）
 *
 * ## 为什么桌面端需要第二个账号体系
 *
 * B 站登录态只能解锁 B 站的内容（私密收藏夹、会员音轨）。共享歌单是
 * **BBPlayer 自己后端**的能力（`apps/backend`，Hono + Postgres），它有独立的
 * 账号与 JWT。两套身份互不相干，B 站 cookie 拿到共享后端毫无用处。
 *
 * ## 与 B 站登录态的刻意区别
 *
 * | | B 站登录 | BBPlayer 账号 |
 * | --- | --- | --- |
 * | 凭据 | cookie 字典（可粘贴导入） | 用户名 + 密码换 JWT |
 * | 失效 | 有有效期，需重新扫码 | JWT **没有 `exp`**，实测不会过期 |
 * | 存储 | `bilibili-cookie.json` | `bbplayer-account.json` |
 *
 * JWT 没有 `exp` 是**读后端 `signToken` 得到的结论**（`sign({sub, role}, secret)`，
 * 没传 `exp`）。因此本模块**不做刷新**：401 一律视为「令牌无效」，清掉登录态并
 * 让用户重新登录 —— 而不是假装能刷新（后端根本没有 refresh 端点）。
 *
 * ## 落盘
 *
 * 沿用 `bilibili-login.cjs` 的凭据存储手法：优先 Electron `safeStorage`，
 * 无可用密钥环时退回明文并**如实标记** `encrypted: false`，不静默降级。
 * 两个分支写出的结构必须同形（都摊平 `token`/`account`/`baseUrl`/`savedAt`），
 * 否则只有一条分支能读回来 —— 那个坑在 B 站凭据上踩过一次。
 *
 * ## 后端地址可配
 *
 * 默认 `https://be.bbplayer.roitium.com`（与移动端 `EXPO_PUBLIC_BBPLAYER_API_URL`
 * 的默认值一致）。可改成自建实例 —— 自建是**真实需求**（后端是开源的一部分），
 * 也让验证脚本能对着本地 `wrangler dev` 跑而**不去写上游的生产库**。
 */

const fs = require('node:fs')
const path = require('node:path')

const { DATA_DIR, logger, storage } = require('./ports.cjs')

const DEFAULT_BASE_URL = 'https://be.bbplayer.roitium.com'
const ACCOUNT_MAGIC = 'bbplayer-account-v1'
const ACCOUNT_FILE = path.join(DATA_DIR, 'bbplayer-account.json')
const BASE_URL_KEY = 'bbplayer.apiBaseUrl'

/** 用户名/密码的长度下限，与后端 `validators/auth.ts` 一一对应 */
const USERNAME_MIN = 3
const PASSWORD_MIN = 8

/**
 * 取 Electron 的 `safeStorage`；纯 Node（验证脚本）下返回 null。
 *
 * 用 try/catch 而不是先判断模块是否存在：纯 Node 下 `require('electron')`
 * 会抛 `Cannot find module`，那是**预期路径**而不是错误。
 */
function maybeSafeStorage() {
	try {
		const { safeStorage } = require('electron')
		return safeStorage ?? null
	} catch {
		return null
	}
}

/** 后端返回的错误。
 *
 * 带 `status`（HTTP 码）和 `code`（后端 `error` 字段）。所有调用方都能据此
 * 决定「是重登还是提示」—— 因此**不把 401 吞成 undefined**。
 */
class ApiError extends Error {
	constructor(status, code, message, body) {
		super(message)
		this.name = 'ApiError'
		this.status = status
		this.code = code
		this.body = body
	}
}

/**
 * 把后端的 `error` 字段翻成人话。未知码原样透出，不猜。
 *
 * ⚠️ 键必须与后端**逐字符一致**。后端 `routes/playlists.ts` 返回的是
 * `{ error: 'Playlist not found' }`（**空格分隔**，不是下划线），
 * 第一版写成 `Playlist_not_found` 于是这条映射**从来没命中过**，
 * 用户看到的是一句夹着英文原码的兜底文案。
 */
const ERROR_MESSAGES = {
	invalid_body: '请求参数不合法（用户名至少 3 位、密码至少 8 位）',
	username_already_exists: '该用户名已被占用',
	invalid_credentials: '用户名或密码错误',
	account_not_found: '账号不存在（可能已在服务端被删除）',
	'Playlist not found': '共享歌单不存在，或已被创建者删除',
	Forbidden: '没有权限执行该操作（可能已被移出这个歌单）',
	Unauthorized: '登录状态无效，请重新登录 BBPlayer 账号',
	'Invalid or expired token': '登录状态已失效，请重新登录 BBPlayer 账号',
}

function describeError(code, fallback) {
	if (!code) return fallback || '请求失败'
	return ERROR_MESSAGES[code] ?? `${fallback || '请求失败'}（${code}）`
}

/** 规范化用户输入的地址：去掉尾斜杠，补上协议 */
function normalizeBaseUrl(raw) {
	const trimmed = String(raw ?? '').trim()
	if (!trimmed) return DEFAULT_BASE_URL
	const withScheme = /^https?:\/\//i.test(trimmed)
		? trimmed
		: `https://${trimmed}`
	return withScheme.replace(/\/+$/, '')
}

function createAccountModule({ file = ACCOUNT_FILE, fetchImpl } = {}) {
	/** @type {{token: string|null, account: object|null, savedAt: number|null}} */
	let state = { token: null, account: null, savedAt: null }

	function warn(level, message) {
		try {
			logger[level]?.(message)
		} catch {
			// 日志失败不能影响登录流程
		}
	}

	// ---------------------------------------------------------------
	// 后端地址：存在 KV 里而不是凭据文件里 —— 地址不是机密，
	// 且用户改地址时不应该连带把令牌一起重写（那会丢掉加密态）。
	// ---------------------------------------------------------------

	function getBaseUrl() {
		// 环境变量优先：验证脚本与自建实例都靠它，避免为了换地址去改用户设置
		const fromEnv = process.env.BBPLAYER_API_URL
		if (fromEnv) return normalizeBaseUrl(fromEnv)
		const stored = storage.getString(BASE_URL_KEY)
		return stored ? normalizeBaseUrl(stored) : DEFAULT_BASE_URL
	}

	function setBaseUrl(raw) {
		const next = normalizeBaseUrl(raw)
		if (next === DEFAULT_BASE_URL) storage.delete(BASE_URL_KEY)
		else storage.set(BASE_URL_KEY, next)
		return next
	}

	// ---------------------------------------------------------------
	// 凭据落盘
	// ---------------------------------------------------------------

	function load() {
		let raw
		try {
			raw = fs.readFileSync(file, 'utf8')
		} catch {
			return
		}
		if (!raw.trim()) return

		let parsed
		try {
			parsed = JSON.parse(raw)
		} catch (error) {
			warn('warn', `账号文件不是合法 JSON，已忽略: ${error.message}`)
			return
		}
		if (parsed?.magic !== ACCOUNT_MAGIC) {
			warn('warn', '账号文件 magic 不匹配，已忽略（不猜测旧格式）')
			return
		}

		if (parsed.encrypted) {
			const safeStorage = maybeSafeStorage()
			if (!safeStorage?.isEncryptionAvailable?.()) {
				warn(
					'warn',
					'账号文件是加密的，但当前系统没有可用密钥环（safeStorage 不可用），已忽略',
				)
				return
			}
			try {
				const inner = JSON.parse(
					safeStorage.decryptString(Buffer.from(parsed.payload, 'base64')),
				)
				state = {
					token: inner.token ?? null,
					account: inner.account ?? null,
					savedAt: inner.savedAt ?? null,
				}
			} catch (error) {
				warn('warn', `账号文件解密失败: ${error.message}`)
			}
			return
		}

		state = {
			token: parsed.token ?? null,
			account: parsed.account ?? null,
			savedAt: parsed.savedAt ?? null,
		}
	}

	function save() {
		const flat = {
			token: state.token,
			account: state.account,
			savedAt: state.savedAt,
		}
		const safeStorage = maybeSafeStorage()

		let encrypted = false
		let payload = null
		if (safeStorage?.isEncryptionAvailable?.()) {
			try {
				payload = safeStorage
					.encryptString(JSON.stringify(flat))
					.toString('base64')
				encrypted = true
			} catch (error) {
				warn('warn', `账号令牌加密失败，退回未加密存储: ${error.message}`)
			}
		}

		const onDisk = encrypted
			? { magic: ACCOUNT_MAGIC, encrypted: true, payload }
			: {
					magic: ACCOUNT_MAGIC,
					encrypted: false,
					// 与加密分支**同形**：摊平同样的字段
					...flat,
					note: 'plaintext fallback: 系统无可用密钥环（safeStorage 不可用），此文件未加密',
				}

		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, JSON.stringify(onDisk, null, 2), 'utf8')
		return encrypted
	}

	function isStorageEncrypted() {
		try {
			const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
			return parsed?.encrypted === true
		} catch {
			return false
		}
	}

	function clear() {
		state = { token: null, account: null, savedAt: null }
		try {
			fs.rmSync(file, { force: true })
		} catch (error) {
			warn('warn', `删除账号文件失败: ${error.message}`)
		}
	}

	// ---------------------------------------------------------------
	// HTTP
	// ---------------------------------------------------------------

	/**
	 * 发一次请求。
	 *
	 * `auth: true` 时带 `Authorization: Bearer <token>`；**没有令牌直接抛 401**
	 * 而不是发一个注定 401 的请求 —— 前端能立刻给出「请先登录 BBPlayer 账号」，
	 * 不用等一次网络往返。
	 */
	async function request(pathname, { method = 'GET', body, auth = true } = {}) {
		const doFetch = fetchImpl ?? globalThis.fetch
		const headers = { Accept: 'application/json' }
		if (body !== undefined) headers['Content-Type'] = 'application/json'

		if (auth) {
			if (!state.token) {
				throw new ApiError(401, 'no_token', '请先登录 BBPlayer 账号')
			}
			headers.Authorization = `Bearer ${state.token}`
		}

		const url = `${getBaseUrl()}${pathname}`
		let response
		try {
			response = await doFetch(url, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			})
		} catch (error) {
			// 网络层错误没有 HTTP 码：如实标记，调用方据此区分「服务不可达」
			throw new ApiError(0, 'network_error', `无法连接后端：${error.message}`)
		}

		const text = await response.text()
		let parsed = null
		if (text.trim()) {
			try {
				parsed = JSON.parse(text)
			} catch {
				parsed = { raw: text }
			}
		}

		if (!response.ok) {
			const code = parsed?.error ?? null
			// 令牌失效：立刻清掉本地登录态，避免后续每个请求都白跑一次
			if (response.status === 401 && auth) {
				warn('warn', 'BBPlayer 令牌被服务端拒绝（401），已清除本地登录态')
				clear()
			}
			throw new ApiError(
				response.status,
				code,
				describeError(code, `HTTP ${response.status}`),
				parsed,
			)
		}

		return parsed
	}

	// ---------------------------------------------------------------
	// 账号
	// ---------------------------------------------------------------

	function status() {
		return {
			loggedIn: Boolean(state.token && state.account),
			account: state.account,
			baseUrl: getBaseUrl(),
			defaultBaseUrl: DEFAULT_BASE_URL,
			encrypted: isStorageEncrypted(),
			savedAt: state.savedAt,
		}
	}

	/** 本地校验：**在发请求之前**就把明显不合法的输入挡下来，省一次往返 */
	function validateCredentials({ username, password }) {
		const name = String(username ?? '').trim()
		if (name.length < USERNAME_MIN) {
			throw new ApiError(
				400,
				'invalid_body',
				`用户名至少 ${USERNAME_MIN} 个字符`,
			)
		}
		if (String(password ?? '').length < PASSWORD_MIN) {
			throw new ApiError(400, 'invalid_body', `密码至少 ${PASSWORD_MIN} 个字符`)
		}
		return { username: name, password }
	}

	async function authenticate(pathname, { username, password, name: display }) {
		const body = validateCredentials({ username, password })
		if (display) body.name = String(display).trim()

		const result = await request(pathname, {
			method: 'POST',
			body,
			auth: false,
		})

		if (!result?.token || !result?.account) {
			throw new ApiError(
				500,
				'malformed_response',
				'后端没有返回令牌（响应结构不符）',
			)
		}

		state = {
			token: result.token,
			account: result.account,
			savedAt: Date.now(),
		}
		const encrypted = save()
		logger.info(
			`BBPlayer 账号已登录：${result.account.name}（${result.account.username}），加密存储=${encrypted}`,
		)
		return { account: result.account, encrypted }
	}

	const register = (payload) => authenticate('/auth/register', payload)
	const login = (payload) => authenticate('/auth/login', payload)

	async function logout() {
		clear()
		logger.info('BBPlayer 账号已退出登录')
		return { loggedIn: false }
	}

	/** 拉当前账号。401 时 `request` 已经清掉登录态，这里不重复处理 */
	async function me() {
		const result = await request('/auth/me')
		if (result?.account) {
			state.account = result.account
			save()
		}
		return result?.account ?? null
	}

	async function updateProfile(patch) {
		const result = await request('/auth/profile', {
			method: 'PATCH',
			body: patch,
		})
		if (result?.account) {
			state.account = result.account
			save()
		}
		return result?.account ?? null
	}

	load()

	return {
		DEFAULT_BASE_URL,
		ApiError,
		getBaseUrl,
		setBaseUrl,
		status,
		register,
		login,
		logout,
		me,
		updateProfile,
		request,
		/** 验证脚本用：不经过 Electron 也能拿到当前令牌 */
		getToken: () => state.token,
	}
}

module.exports = {
	DEFAULT_BASE_URL,
	ACCOUNT_FILE,
	ACCOUNT_MAGIC,
	ApiError,
	normalizeBaseUrl,
	describeError,
	createAccountModule,
}
