/**
 * Cookie 解析与校验（纯函数，零依赖）。
 *
 * 单独成文件的原因：`bilibili-login.cjs` 会 `require('electron')` 取
 * `safeStorage`，而 `require('electron')` 在**纯 Node 下会抛**。虽然那边
 * 已经用 try/catch 兜住，但验证脚本更希望有一个**能确定性地在 Node 里跑**的
 * 入口 —— 因此把不依赖 Electron 的纯逻辑拆到这里。
 */

/** B 站登录态的四个关键 cookie；缺 `SESSDATA` 就等于没登录 */
const REQUIRED_COOKIE_KEYS = ['SESSDATA']

/** 完整登录态应当具备的键（用于诊断「拿到了几个」） */
const IDENTITY_COOKIE_KEYS = [
	'DedeUserID',
	'DedeUserID__ckMd5',
	'bili_jct',
	'SESSDATA',
]

/**
 * 解析 cookie 字符串或对象为字典。
 *
 * 接受的输入：
 *   * `"a=1; b=2"`
 *   * 换行分隔（有些人从 DevTools 表格里复制，是每行一条）
 *   * `{ a: '1' }`
 *   * 从浏览器控制台 `document.cookie` 整段复制的文本
 *   * 带 `Set-Cookie` 属性（`SESSDATA=x; Path=/; Domain=.bilibili.com`）——
 *     多余的属性会被当成本字典里的键，但**不影响必需键**，因此不视为错误
 *
 * @returns {Record<string, string>|null}
 */
function parseCookie(input) {
	if (!input) return null

	if (typeof input === 'object') {
		const out = {}
		for (const [key, value] of Object.entries(input)) {
			if (key && value !== undefined && value !== null) {
				// `key` 已由 Object.entries 保证是 string，无需再 String()
				out[key.trim()] = String(value).trim()
			}
		}
		return Object.keys(out).length > 0 ? out : null
	}

	const text = String(input)
	const out = {}
	for (const segment of text.split(/[;\n\r]+/)) {
		const trimmed = segment.trim()
		if (!trimmed) continue
		const eq = trimmed.indexOf('=')
		if (eq <= 0) continue
		const key = trimmed.slice(0, eq).trim()
		const value = trimmed.slice(eq + 1).trim()
		if (key) out[key] = value
	}
	return Object.keys(out).length > 0 ? out : null
}

/** 校验 cookie 是否含登录态关键字段 */
function validateCookie(cookie) {
	if (!cookie) return { ok: false, error: 'cookie 为空' }
	const missing = REQUIRED_COOKIE_KEYS.filter((key) => !cookie[key])
	if (missing.length > 0) {
		return {
			ok: false,
			error: `缺少必要字段 ${missing.join(', ')}；请确认复制的是登录后的完整 cookie（至少包含 SESSDATA）`,
		}
	}
	return { ok: true }
}

/** cookie 字典 -> 请求头值 */
function cookieToHeader(cookie) {
	if (!cookie) return ''
	return Object.entries(cookie)
		.map(([key, value]) => `${key}=${value}`)
		.join('; ')
}

/** 统计一个 cookie 字典里覆盖了几个「身份键」 */
function countIdentityKeys(cookie) {
	if (!cookie) return 0
	return IDENTITY_COOKIE_KEYS.filter((key) => cookie[key]).length
}

module.exports = {
	parseCookie,
	validateCookie,
	cookieToHeader,
	countIdentityKeys,
	REQUIRED_COOKIE_KEYS,
	IDENTITY_COOKIE_KEYS,
}
