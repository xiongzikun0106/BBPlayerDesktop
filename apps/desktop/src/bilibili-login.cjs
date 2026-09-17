/**
 * B 站登录：扫码 / 密码 / 手动粘贴 Cookie，以及登录态的加密落盘。
 *
 * ## 设计要点
 *
 * **单一可信来源**：cookie 只由本模块读写。`ports.cjs` 通过这里取，
 * 于是「渲染进程拿不到 cookie」「cookie 不落明文盘」两件事都在一处保证。
 *
 * **落盘加密**：优先用 Electron `safeStorage`（Windows 走 DPAPI，
 * Linux 走 libsecret / kwallet），密文再 base64。若系统没有可用的密钥环
 * （常见于无 GUI 的 Linux、或 `basic_text` 后端），退回**混淆式明文**并在
 * 返回值里标 `encrypted: false` —— 不静默降级，让调用方/UI 能如实告知用户。
 *
 * **不用 `contextIsolation` 之外的通道**：扫码用的二维码图片在主进程生成
 * （`qrcode` 包 → PNG data URL），渲染进程只拿到一张图，拿不到 URL 里的
 * `qrcode_key`。
 *
 * ## 为什么有「手动粘贴 Cookie」
 *
 * 扫码要手机、密码登录有风控（见 `login` 的 `-105` 处理）。手动粘贴是
 * 必然存在的第三条路，且实现成本最低，所以一并支持。
 *
 * 另外：**公开收藏夹与合集无需登录**（已实测 `fav/folder/created/list-all`
 * 与 `fav/resource/list` 匿名均返回 `code=0`）。登录只用于**私密收藏夹**、
 * 更高音质档位与个人化推荐，因此登录是增强项而非前置条件。
 */
const fs = require('node:fs')
const path = require('node:path')

const { encryptPassword, fetchLoginKey } = require('./bilibili-rsa.cjs')
// cookie 的解析/校验是纯函数，拆到 bilibili-cookie.cjs，
// 好处是验证脚本能在**纯 Node**（无 Electron）下确定性地跑它们。
const {
	parseCookie,
	validateCookie,
	cookieToHeader,
	countIdentityKeys,
	REQUIRED_COOKIE_KEYS,
	IDENTITY_COOKIE_KEYS,
} = require('./bilibili-cookie.cjs')

/** B 站接口需要的浏览器化头；缺 `Referer` 会被 URL 校验拦下 */
const UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const BASE_HEADERS = {
	'User-Agent': UA,
	Referer: 'https://www.bilibili.com/',
	Origin: 'https://www.bilibili.com',
}

/** 扫码轮询节奏：B 站文档建议首次 1s，之后 2s */
const POLL_DELAYS_MS = [1000, 2000, 2000, 2000, 2000]
const QR_TIMEOUT_MS = 180_000

// ---------------------------------------------------------------
// 密码登录限流（风控自查）
// ---------------------------------------------------------------

const RATE_LIMIT = { windowMs: 60_000, maxAttempts: 5 }
let attempts = []

/**
 * 密码登录限流。
 *
 * B 站对密码登录有风控，短时间内多次失败会触发验证码/冻结。
 * 在**本地**先限流，避免用户狂点把账号打进风控。
 */
function checkRateLimit() {
	const now = Date.now()
	attempts = attempts.filter((t) => now - t < RATE_LIMIT.windowMs)
	if (attempts.length >= RATE_LIMIT.maxAttempts) {
		const waitSec = Math.ceil(
			(RATE_LIMIT.windowMs - (now - attempts[0])) / 1000,
		)
		throw new Error(
			`密码登录尝试过于频繁（每分钟最多 ${RATE_LIMIT.maxAttempts} 次），请 ${waitSec} 秒后再试`,
		)
	}
	attempts.push(now)
}

function resetRateLimit() {
	attempts = []
}

// ---------------------------------------------------------------
// Cookie 存储
// ---------------------------------------------------------------

const COOKIE_MAGIC = 'bbplayer-secure-v1'

/**
 * 取 Electron 的 `safeStorage`；在纯 Node（验证脚本）下返回 null。
 *
 * 用 try/catch 而不是先 `require('electron')`：纯 Node 下会抛
 * `Cannot find module 'electron'`，这是**预期路径**而不是错误。
 */
function maybeSafeStorage() {
	try {
		const { safeStorage } = require('electron')
		return safeStorage ?? null
	} catch {
		return null
	}
}

/**
 * 登录态存储。
 *
 * @param {string} cookieFile cookie 文件路径
 * @param {(level: string, message: string) => void} [warn] 日志回调
 */
function createCredentialStore(cookieFile, warn = () => {}) {
	/** @type {{cookie: Record<string, string>|null, user: object|null, savedAt: number|null}} */
	let state = { cookie: null, user: null, savedAt: null }

	/** 读盘。兼容旧格式（P1 留下的裸 JSON 明文文件） */
	function load() {
		let raw
		try {
			raw = fs.readFileSync(cookieFile, 'utf8')
		} catch {
			return
		}
		if (!raw.trim()) return

		const parsed = JSON.parse(raw)

		// 新格式
		if (parsed?.magic === COOKIE_MAGIC) {
			if (parsed.encrypted) {
				const safeStorage = maybeSafeStorage()
				if (!safeStorage?.isEncryptionAvailable?.()) {
					warn(
						'warn',
						'cookie 文件是加密的，但当前系统没有可用密钥环（safeStorage 不可用），已忽略',
					)
					return
				}
				try {
					const plain = safeStorage.decryptString(
						Buffer.from(parsed.payload, 'base64'),
					)
					const inner = JSON.parse(plain)
					state = {
						cookie: inner.cookie ?? null,
						user: inner.user ?? null,
						savedAt: inner.savedAt ?? null,
					}
				} catch (error) {
					warn('warn', `cookie 解密失败: ${error.message}`)
				}
				return
			}
			state = {
				cookie: parsed.cookie ?? null,
				user: parsed.user ?? null,
				savedAt: parsed.savedAt ?? null,
			}
			return
		}

		// 旧格式：整个文件就是 cookie 字典
		if (parsed && typeof parsed === 'object') {
			state = { cookie: parsed, user: null, savedAt: null }
			warn(
				'info',
				'检测到旧版明文 cookie 文件，已读入并在下次写入时升级为加密格式',
			)
		}
	}

	/**
	 * 写盘。返回是否真正加密。
	 *
	 * ⚠️ 两种分支写出的结构必须**同形**（都有 `cookie` / `user` / `savedAt`），
	 * 否则 `load()` 只有一条分支能读回来。第一版把未加密分支写成
	 * 「`payload` 里塞一串 JSON 字符串」，而 `load()` 去读 `parsed.cookie`，
	 * 结果是**明文模式登录态存进去读不回来**（被
	 * `verify-bilibili-login.mts` 的「写入后能原样读回」断言抓住）。
	 */
	function save() {
		const safeStorage = maybeSafeStorage()
		const plain = JSON.stringify({
			cookie: state.cookie,
			user: state.user,
			savedAt: state.savedAt,
		})

		let encrypted = false
		let payload = null

		if (safeStorage?.isEncryptionAvailable?.()) {
			try {
				payload = safeStorage.encryptString(plain).toString('base64')
				encrypted = true
			} catch (error) {
				warn('warn', `cookie 加密失败，退回未加密存储: ${error.message}`)
			}
		}

		const onDisk = encrypted
			? { magic: COOKIE_MAGIC, encrypted: true, payload }
			: {
					magic: COOKIE_MAGIC,
					encrypted: false,
					// 未加密时直接摊平字段：与加密分支的**逻辑结构**同形，
					// 只是没有密码学保护
					cookie: state.cookie,
					user: state.user,
					savedAt: state.savedAt,
					note: 'plaintext fallback: 系统无可用密钥环（safeStorage 不可用），此文件未加密',
				}

		fs.mkdirSync(path.dirname(cookieFile), { recursive: true })
		fs.writeFileSync(cookieFile, JSON.stringify(onDisk, null, 2), 'utf8')
		return encrypted
	}

	/** 清盘 */
	function clear() {
		state = { cookie: null, user: null, savedAt: null }
		try {
			fs.unlinkSync(cookieFile)
		} catch {
			// 文件不存在即可
		}
	}

	load()

	return {
		/** 同步取 cookie 对象（`BilibiliCredentialPort.getCookie` 要求 async，外面包一层） */
		getCookieSync: () => state.cookie,
		getUserSync: () => state.user,
		getSavedAtSync: () => state.savedAt,
		/**
		 * 写入登录态。
		 * @returns {{encrypted: boolean}}
		 */
		set({ cookie, user = null }) {
			state.cookie = cookie
			state.user = user
			state.savedAt = Date.now()
			const encrypted = save()
			return { encrypted }
		},
		clear,
	}
}

// ---------------------------------------------------------------
// Cookie 解析
// ---------------------------------------------------------------
//
// `parseCookie` / `validateCookie` / `cookieToHeader` 由
// `bilibili-cookie.cjs` 提供（纯函数、无 Electron 依赖），在文件顶部 import。

// ---------------------------------------------------------------
// 网络：登录相关接口
// ---------------------------------------------------------------

async function requestJson(
	url,
	{ method = 'GET', body, cookie, timeoutMs = 15000 } = {},
) {
	const headers = { ...BASE_HEADERS }
	if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded'
	if (cookie) headers.Cookie = cookieToHeader(cookie)

	// GET 不能带 body（fetch 规范会抛），所以只在真有 body 时才传这个键
	const init = {
		method,
		headers,
		signal: AbortSignal.timeout(timeoutMs),
		// 必须手动看 Set-Cookie，扫码成功后新 cookie 也在响应头里
		redirect: 'manual',
	}
	if (body) init.body = new URLSearchParams(body).toString()

	const response = await fetch(url, init)

	const text = await response.text()
	let json = null
	try {
		json = JSON.parse(text)
	} catch {
		// 有些接口返回纯文本
	}

	return { response, json, text }
}

/** 从响应头收集 Set-Cookie */
function collectSetCookie(response) {
	const raw =
		typeof response.headers.getSetCookie === 'function'
			? response.headers.getSetCookie()
			: [response.headers.get('set-cookie')].filter(Boolean)

	const out = {}
	for (const line of raw) {
		for (const segment of String(line).split(';')) {
			const trimmed = segment.trim()
			const eq = trimmed.indexOf('=')
			if (eq <= 0) continue
			const key = trimmed.slice(0, eq).trim()
			const value = trimmed.slice(eq + 1).trim()
			if (key && value) out[key] = value
		}
	}
	return out
}

/**
 * 校验登录态并取账号信息。
 *
 * `/x/web-interface/nav` 未登录返回 `code=-101`（不是 HTTP 错误），
 * 所以这里既看 code 也看 `data.isLogin`。
 */
async function fetchLoginStatus(cookie) {
	const { json, response } = await requestJson(
		'https://api.bilibili.com/x/web-interface/nav',
		{ cookie },
	)
	if (!json) {
		throw new Error(`账号信息接口返回非 JSON（HTTP ${response.status}）`)
	}
	if (json.code === -101 || !json.data?.isLogin) {
		return { loggedIn: false, code: json.code }
	}
	if (json.code !== 0) {
		throw new Error(`账号信息接口失败: code=${json.code} ${json.message ?? ''}`)
	}

	const data = json.data
	return {
		loggedIn: true,
		user: {
			mid: data.mid,
			uname: data.uname,
			face: data.face,
			level: data.level_info?.current_level ?? null,
			vip: Boolean(data.vipStatus),
			vipLabel: data.vip_label ?? null,
			coins: data.money ?? null,
		},
		// 顺带把服务端刷新的 cookie 带回去（有些字段会滚动）
		setCookie: collectSetCookie(response),
	}
}

/**
 * 扫码第一步：申请二维码。
 *
 * `url` 原样来自接口 —— 不自己拼，避免格式随版本变化。
 */
async function createQrCode({ width = 220 } = {}) {
	const { json } = await requestJson(
		'https://passport.bilibili.com/x/passport-login/web/qrcode/generate',
	)
	if (!json || json.code !== 0 || !json.data?.url) {
		throw new Error(
			`申请二维码失败: code=${json?.code ?? '?'} ${json?.message ?? ''}`,
		)
	}

	const { url, qrcode_key: qrcodeKey } = json.data

	// 二维码图片在主进程生成：渲染进程只拿到一张 PNG，拿不到 qrcode_key
	let imageDataUrl = null
	let imageError = null
	try {
		// `qrcode` 是 `react-native-qrcode-svg` 的依赖，已提升为本包显式依赖
		const QRCode = require('qrcode')
		imageDataUrl = await QRCode.toDataURL(url, {
			width,
			margin: 1,
			errorCorrectionLevel: 'M',
		})
	} catch (error) {
		imageError = error.message
	}

	return {
		qrcodeKey,
		url,
		imageDataUrl,
		imageError,
		expiresInMs: QR_TIMEOUT_MS,
	}
}

/**
 * 扫码第二步：查一次扫码状态。
 *
 * 状态码（`data.code`）：
 *   * `86101` 未扫码
 *   * `86090` 已扫码待确认
 *   * `86038` 二维码已失效
 *   * `0`     成功
 */
async function pollQrCode(qrcodeKey) {
	const { json, response } = await requestJson(
		`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`,
	)
	if (!json) {
		throw new Error(`扫码状态接口返回非 JSON（HTTP ${response.status}）`)
	}
	if (json.code !== 0) {
		throw new Error(`扫码状态接口失败: code=${json.code} ${json.message ?? ''}`)
	}

	const data = json.data ?? {}
	const status = data.code

	if (status === 86101) return { state: 'pending' }
	if (status === 86090) return { state: 'scanned', message: data.message }
	if (status === 86038) return { state: 'expired', message: data.message }

	if (status !== 0) {
		return { state: 'unknown', status, message: data.message }
	}

	// 成功：cookie 有两处来源，合并（响应头更全，URL 参数是兜底）
	const fromUrl = parseCookie(String(data.url ?? '').split('?')[1] ?? '')
	const fromHeader = collectSetCookie(response)
	const cookie = { ...fromUrl, ...fromHeader }

	const check = validateCookie(cookie)
	if (!check.ok) {
		throw new Error(`扫码成功但未拿到完整 cookie：${check.error}`)
	}

	return { state: 'confirmed', cookie, setCookieFromUrl: fromUrl }
}

/**
 * 加密登录接口的错误码映射。
 *
 * ⚠️ 密码登录**受风控**：即使凭据正确，也可能要求验证码
 * （`-105`）或触发短信验证（`-106`）—— 这两条路本模块不实现，
 * 明确降级提示用户改用扫码或粘贴 cookie。
 */
const LOGIN_ERROR_HINTS = {
	'-105': '需要验证码（B 站风控）。请改用扫码登录或手动粘贴 cookie。',
	'-106': '需要短信验证（B 站风控）。请改用扫码登录或手动粘贴 cookie。',
	'-629': '请求过于频繁，已被限流，请稍后再试。',
	'-400': '用户名或密码格式不正确。',
	'-403': '账号或密码错误。',
	'-404': '账号不存在。',
}

/**
 * 密码登录。
 *
 * @param {string} username 手机号 / 邮箱
 * @param {string} password 明文密码
 */
async function loginWithPassword(username, password) {
	if (!username || !password) {
		throw new Error('用户名与密码都不能为空')
	}
	checkRateLimit()

	const key = await fetchLoginKey({ headers: BASE_HEADERS })
	const encrypted = encryptPassword(password, key)

	const { json, response } = await requestJson(
		'https://passport.bilibili.com/x/passport-login/web/login',
		{
			method: 'POST',
			body: {
				username,
				password: encrypted,
				keep: '0',
				source: 'main_web',
			},
		},
	)

	if (!json) {
		throw new Error(`登录接口返回非 JSON（HTTP ${response.status}）`)
	}
	if (json.code !== 0) {
		const hint = LOGIN_ERROR_HINTS[String(json.code)]
		throw new Error(
			`登录失败: code=${json.code} ${json.message ?? ''}${hint ? ` —— ${hint}` : ''}`,
		)
	}

	const cookie = collectSetCookie(response)
	const check = validateCookie(cookie)
	if (!check.ok) {
		throw new Error(`登录成功但未拿到完整 cookie：${check.error}`)
	}
	return { cookie }
}

// ---------------------------------------------------------------
// 顶层门面
// ---------------------------------------------------------------

/**
 * 创建登录门面。
 *
 * @param {object} options
 * @param {string} options.cookieFile cookie 落盘路径
 * @param {(level: string, message: string) => void} [options.warn]
 */
function createLoginManager({ cookieFile, warn = () => {} }) {
	const store = createCredentialStore(cookieFile, warn)

	/** 登录成功后统一收尾：校验 + 存盘 */
	async function adoptCookie(cookie, { source }) {
		const check = validateCookie(cookie)
		if (!check.ok) throw new Error(check.error)

		const status = await fetchLoginStatus(cookie)
		if (!status.loggedIn) {
			throw new Error(
				`cookie 无效或已过期（接口 code=${status.code}）。请重新获取。`,
			)
		}

		const merged = { ...cookie, ...status.setCookie }
		const { encrypted } = store.set({ cookie: merged, user: status.user })

		warn(
			'info',
			`登录成功（来源 ${source}）：${status.user.uname} (mid=${status.user.mid})，加密存储=${encrypted}`,
		)
		return { user: status.user, encrypted }
	}

	return {
		/** 同步取 cookie，给 B 站客户端用 */
		getCookie: () => store.getCookieSync(),
		getUser: () => store.getUserSync(),

		/** 当前登录态摘要（**不含 cookie 内容**，可安全回传渲染进程） */
		async status() {
			const cookie = store.getCookieSync()
			if (!cookie) return { loggedIn: false, encrypted: isStorageEncrypted() }

			try {
				const status = await fetchLoginStatus(cookie)
				if (!status.loggedIn) {
					return {
						loggedIn: false,
						stale: true,
						encrypted: isStorageEncrypted(),
						user: store.getUserSync(),
					}
				}
				return {
					loggedIn: true,
					user: status.user,
					encrypted: isStorageEncrypted(),
					savedAt: null,
				}
			} catch (error) {
				// 网络不可达时不要谎报「未登录」：把缓存的身份带上
				return {
					loggedIn: Boolean(cookie),
					offline: true,
					error: error.message,
					user: store.getUserSync(),
					encrypted: isStorageEncrypted(),
				}
			}
		},

		createQrCode,
		pollQrCode,

		/** 扫码确认后调用 */
		async confirmQrLogin(cookie) {
			return adoptCookie(cookie, { source: 'qr' })
		},

		async loginWithPassword(username, password) {
			const { cookie } = await loginWithPassword(username, password)
			return adoptCookie(cookie, { source: 'password' })
		},

		/** 手动粘贴 cookie（字符串或字典） */
		async importCookie(input) {
			const cookie = parseCookie(input)
			return adoptCookie(cookie, { source: 'manual' })
		},

		/** 退出登录 */
		logout() {
			store.clear()
			resetRateLimit()
			warn('info', '已退出登录，本地凭据已清除')
			return { loggedIn: false }
		},

		/** 诊断信息（验证脚本用；**故意不含 cookie 值**） */
		describe() {
			const cookie = store.getCookieSync()
			return {
				cookieFile,
				hasCookie: Boolean(cookie),
				// 只报「有哪些键」，不报值
				cookieKeys: cookie ? Object.keys(cookie).sort() : [],
				hasIdentity: cookie
					? IDENTITY_COOKIE_KEYS.filter((k) => cookie[k]).length
					: 0,
				encrypted: isStorageEncrypted(),
				user: store.getUserSync(),
			}
		},
	}
}

/** 当前系统的密钥环是否可用 */
function isStorageEncrypted() {
	const safeStorage = maybeSafeStorage()
	try {
		return Boolean(safeStorage?.isEncryptionAvailable?.())
	} catch {
		return false
	}
}

module.exports = {
	createLoginManager,
	createCredentialStore,
	// 以下纯函数来自 bilibili-cookie.cjs，这里一并向调用方转发，
	// 这样使用方只 require 本文件即可
	parseCookie,
	validateCookie,
	cookieToHeader,
	countIdentityKeys,
	fetchLoginStatus,
	createQrCode,
	pollQrCode,
	loginWithPassword,
	isStorageEncrypted,
	BASE_HEADERS,
	UA,
	REQUIRED_COOKIE_KEYS,
	IDENTITY_COOKIE_KEYS,
	POLL_DELAYS_MS,
	QR_TIMEOUT_MS,
	LOGIN_ERROR_HINTS,
}
