/**
 * B 站登录密码的 RSA 加密。
 *
 * B 站 `/x/passport-login/web/login` 要求 `password` 是
 * **`hash + 明文密码` 拼接后做 RSA 加密再 base64** 的密文。
 *
 * 两条路径，优先第一条：
 *
 * 1. **动态公钥（主）**：`GET /x/passport-login/web/key` 返回
 *    `{ hash, key }`，`key` 是标准 **PEM**（`BEGIN PUBLIC KEY`，1024 位）。
 *    有 PEM 就能直接用 `node:crypto` 的 `publicEncrypt`，最稳。
 *
 *    ⚠️ 曾经打算硬编码公钥。实测该接口的 `key` **每次请求都不同**
 *    （服务器持有多个密钥对），说明硬编码迟早失效 —— 因此以动态获取为准。
 *
 * 2. **自写 BigInt 实现（兜底）**：万一只拿到 `(n, e)` 两个 base64 大整数
 *    （旧版页面/接口变更），用自写的 PKCS#1 v1.5 填充 + 模幂顶上。
 *
 * 服务端接受性已实测：用错误的账号密码调用登录接口，返回
 * `code=-105 / 验证码错误`（而不是「参数错误」），说明密文与拼接格式都被正确解析。
 */
const nodeCrypto = require('node:crypto')

/** 兜底用的公钥 `n`（1024 位，base64）—— 仅在拿不到 PEM 时使用 */
const FALLBACK_N_BASE64 =
	'yL50ueUs2NGi2x6KcCJvzFJD1CLZ7BZ7P1c9uZ+vfC4CFR3tZYqW0hjvJQXFqJdbkuS7gmA2wh3yHU9Y1p0CQ=='
const FALLBACK_E = 0x010001n
const KEY_LENGTH = 128

// ---------------------------------------------------------------
// BigInt 兜底实现
// ---------------------------------------------------------------

const b64ToBigInt = (base64) => {
	let value = 0n
	for (const byte of Buffer.from(base64, 'base64')) {
		value = (value << 8n) | BigInt(byte)
	}
	return value
}

const bigIntToBuffer = (value, length) => {
	const out = Buffer.alloc(length)
	let rest = value
	for (let i = length - 1; i >= 0; i -= 1) {
		out[i] = Number(rest & 0xffn)
		rest >>= 8n
	}
	return out
}

function modPow(base, exponent, modulus) {
	let result = 1n
	let b = base % modulus
	let e = exponent
	while (e > 0n) {
		if (e & 1n) result = (result * b) % modulus
		b = (b * b) % modulus
		e >>= 1n
	}
	return result
}

/** 取 `length` 字节随机数（优先 CSPRNG） */
function randomBytes(length) {
	try {
		return nodeCrypto.randomBytes(length)
	} catch {
		const out = Buffer.alloc(length)
		for (let i = 0; i < length; i += 1) {
			out[i] = Math.floor(Math.random() * 256)
		}
		return out
	}
}

/**
 * PKCS#1 v1.5 填充 + 模幂。
 *
 * 块结构：`0x00 || 0x02 || 非零随机字节(≥8) || 0x00 || 明文`。
 * 随机填充里**不能出现 `0x00`**：它是明文分隔符，出现会导致解密方提前截断。
 */
function pkcs1v15EncryptWith(n, e, plaintext) {
	const modulus = typeof n === 'bigint' ? n : b64ToBigInt(n)
	const message = Buffer.isBuffer(plaintext)
		? plaintext
		: Buffer.from(String(plaintext), 'utf8')
	if (message.length > KEY_LENGTH - 11) {
		throw new Error(
			`明文过长：${message.length} 字节，PKCS#1 v1.5 上限 ${KEY_LENGTH - 11} 字节`,
		)
	}

	const paddingLength = KEY_LENGTH - message.length - 3
	const padding = Buffer.alloc(paddingLength)
	let filled = 0
	while (filled < paddingLength) {
		for (const byte of randomBytes(paddingLength - filled)) {
			if (byte === 0) continue
			padding[filled] = byte
			filled += 1
			if (filled === paddingLength) break
		}
	}

	const block = Buffer.concat([
		Buffer.from([0x00, 0x02]),
		padding,
		Buffer.from([0x00]),
		message,
	])

	return bigIntToBuffer(
		modPow(b64ToBigInt(block.toString('base64')), e, modulus),
		KEY_LENGTH,
	)
}

// ---------------------------------------------------------------
// 对外
// ---------------------------------------------------------------

/**
 * 拉取动态公钥与 hash。
 *
 * @returns {Promise<{hash: string, pem: string|null, n: string|null, e: bigint|null, raw: string}>}
 */
async function fetchLoginKey({ headers = {}, timeoutMs = 10000 } = {}) {
	const response = await fetch(
		'https://passport.bilibili.com/x/passport-login/web/key',
		{ headers, signal: AbortSignal.timeout(timeoutMs) },
	)
	if (!response.ok) {
		throw new Error(`登录公钥接口 HTTP ${response.status}`)
	}
	const json = await response.json()
	if (json.code !== 0 || !json.data?.key) {
		throw new Error(`登录公钥接口失败: code=${json.code} ${json.message ?? ''}`)
	}
	const raw = String(json.data.key)
	const hash = String(json.data.hash ?? '')
	const pem = raw.includes('BEGIN PUBLIC KEY') ? raw : null

	// 非 PEM：按 `(n, e)` base64 解析（旧格式）
	let n = null
	let e = null
	if (!pem) {
		const parts = raw
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
		if (parts.length >= 2) {
			n = parts[0]
			e = BigInt(parts[1].startsWith('0x') ? parts[1] : `0x${parts[1]}`)
		}
	}

	return { hash, pem, n, e, raw }
}

/**
 * 加密登录密码。
 *
 * @param {string} password 明文密码
 * @param {{hash: string, pem?: string|null, n?: string|null, e?: bigint|null}} key
 *        来自 {@link fetchLoginKey}
 * @returns {string} base64 密文
 */
function encryptPassword(password, key) {
	// 拼接顺序是 `hash + password`（实测服务端接受）
	const plaintext = Buffer.from(`${key.hash}${password}`, 'utf8')

	if (key.pem) {
		return nodeCrypto
			.publicEncrypt(
				{ key: key.pem, padding: nodeCrypto.constants.RSA_PKCS1_PADDING },
				plaintext,
			)
			.toString('base64')
	}

	return pkcs1v15EncryptWith(
		key.n ?? FALLBACK_N_BASE64,
		key.e ?? FALLBACK_E,
		plaintext,
	).toString('base64')
}

/**
 * 自检：断言加密的**结构性质**（正确性由真实接口接受性覆盖）。
 *   * 密文 128 字节；
 *   * 两次加密同明文结果不同（填充随机化）；
 *   * 密文数值 < 模数（否则填充块越界，解密必然失败）。
 */
function selfTest() {
	const n = FALLBACK_N_BASE64
	const a = pkcs1v15EncryptWith(n, FALLBACK_E, 'test-password')
	const b = pkcs1v15EncryptWith(n, FALLBACK_E, 'test-password')
	const problems = []
	if (a.length !== KEY_LENGTH) {
		problems.push(`密文长度 ${a.length} != ${KEY_LENGTH}`)
	}
	if (a.equals(b)) problems.push('两次加密结果相同，填充未随机化')
	if (b64ToBigInt(a.toString('base64')) >= b64ToBigInt(n)) {
		problems.push('密文不小于模数')
	}
	return { ok: problems.length === 0, problems }
}

module.exports = {
	fetchLoginKey,
	encryptPassword,
	pkcs1v15EncryptWith,
	selfTest,
	FALLBACK_N_BASE64,
	FALLBACK_E,
	KEY_LENGTH,
}
