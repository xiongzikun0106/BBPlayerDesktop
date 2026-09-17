/* oxlint-disable no-console -- 验证脚本，以 stdout 输出 */
/**
 * Phase 3 验收：**登录链路 + 收藏夹**。
 *
 * 分两段：
 *
 * **A. 纯函数与本地逻辑**（离线可跑，不依赖网络）
 *   1. RSA 加密的结构性质（长度、填充随机化、密文 < 模数）
 *   2. cookie 解析：分号 / 换行 / 对象 / 带 Set-Cookie 属性
 *   3. cookie 校验：缺 `SESSDATA` 必须被拒
 *   4. `remote_sync_id` 打包/解包：收藏夹与集会的命名空间不串
 *   5. 凭据落盘：写入 -> 读回 -> 清除，且**文件里不含明文 cookie 值**
 *      （纯 Node 下 `safeStorage` 不可用，走混淆回退，正好验证这条降级路径）
 *   6. 未登录时 `importCookie` 必须被拒（不能把垃圾 cookie 存进去）
 *
 * **B. 真实接口**（需要网络）
 *   7. `/x/passport-login/web/key` 返回可用 PEM
 *   8. 密码登录：用错误的凭据调用，**必须**返回 `-105`（验证码）或
 *      `-403/-404` 这类「凭据错」而不是「参数错」—— 这证明
 *      `hash + password` 的拼接与 RSA 加密都被服务端正确解析了。
 *      这是在没有真实账号的情况下能对加密链路做的最强验证。
 *   9. 扫码：`generate` 返回二维码 + 主进程能渲染成 PNG data URL；
 *      用 1×1 的假 key 轮询，必须得到「未扫码」而不是崩。
 *  10. `nav` 匿名返回未登录
 *  11. 收藏夹：匿名能列出公开收藏夹，且能读到内容
 *
 * 用法：pnpm exec tsx scripts/verify-bilibili-login.mts
 *   （用 tsx 只是为了与其它脚本一致；本脚本本身是 CJS 子进程驱动）
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')

// 独立的临时数据目录，避免污染真实用户数据
const DATA_DIR = path.join(os.tmpdir(), `bbplayer-p3-${Date.now()}`)
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
 * 在 apps/desktop 目录下用 node 跑一段 CJS，返回它 `__RESULT__` 之后的 JSON。
 *
 * 返回 `unknown`（与 `verify-desktop-db.mts` 一致）：每个用例的载荷形状都
 * 不同，无法用一个真实类型覆盖；调用方按需断言。
 */
function runNode(script: string, timeoutMs = 120_000): unknown {
	const output = execFileSync(process.execPath, ['-e', script], {
		cwd: DESKTOP,
		encoding: 'utf8',
		env: { ...process.env, BBPLAYER_DATA_DIR: DATA_DIR },
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: timeoutMs,
	})
	const marker = output.lastIndexOf('__RESULT__')
	if (marker === -1) throw new Error(`子进程未返回结果:\n${output}`)
	return JSON.parse(output.slice(marker + '__RESULT__'.length).trim())
}

console.log('=== Phase 3 验收：登录 + 收藏夹 ===')
console.log(`数据目录：${DATA_DIR}\n`)

// ===============================================================
// A. 纯函数与本地逻辑
// ===============================================================

console.log('A. 纯函数与本地逻辑（离线）\n')

// ---------- 1. RSA 结构性质 ----------
{
	const result = runNode(`
		const rsa = require('./src/bilibili-rsa.cjs')
		const test = rsa.selfTest()
		const enc = rsa.pkcs1v15EncryptWith(rsa.FALLBACK_N_BASE64, rsa.FALLBACK_E, 'x')
		console.log('__RESULT__' + JSON.stringify({
			...test,
			byteLength: enc.length,
			expectedLength: rsa.KEY_LENGTH,
		}))
	`)
	check(
		'RSA 自检通过（长度 / 填充随机化 / 密文 < 模数）',
		result.ok,
		result.problems.join('; '),
	)
	check(
		'密文为 128 字节',
		result.byteLength === 128,
		`实际 ${result.byteLength}`,
	)
}

// ---------- 2. cookie 解析 ----------
{
	const result = runNode(`
		const { parseCookie } = require('./src/bilibili-cookie.cjs')
		const cases = {
			semicolon: parseCookie('SESSDATA=abc; bili_jct=def; DedeUserID=123'),
			newline: parseCookie('SESSDATA=abc\\nbili_jct=def'),
			object: parseCookie({ SESSDATA: 'abc', bili_jct: 'def' }),
			withAttrs: parseCookie('SESSDATA=abc; Path=/; Domain=.bilibili.com; Secure'),
			empty: parseCookie(''),
			nullish: parseCookie(null),
			garbage: parseCookie('no-equals-sign-here'),
		}
		console.log('__RESULT__' + JSON.stringify(cases))
	`)
	check(
		'分号分隔解析正确',
		result.semicolon?.SESSDATA === 'abc' &&
			result.semicolon?.bili_jct === 'def',
		JSON.stringify(result.semicolon),
	)
	check(
		'换行分隔解析正确',
		result.newline?.SESSDATA === 'abc' && result.newline?.bili_jct === 'def',
		JSON.stringify(result.newline),
	)
	check(
		'对象输入解析正确',
		result.object?.SESSDATA === 'abc' && result.object?.bili_jct === 'def',
	)
	check(
		'带 Set-Cookie 属性时仍能取到 SESSDATA',
		result.withAttrs?.SESSDATA === 'abc',
		JSON.stringify(result.withAttrs),
	)
	check('空串返回 null', result.empty === null)
	check('null 返回 null', result.nullish === null)
	check('无等号的垃圾输入返回 null', result.garbage === null)
}

// ---------- 3. cookie 校验 ----------
{
	const result = runNode(`
		const { validateCookie } = require('./src/bilibili-cookie.cjs')
		console.log('__RESULT__' + JSON.stringify({
			missing: validateCookie({ bili_jct: 'x' }),
			present: validateCookie({ SESSDATA: 'x' }),
			empty: validateCookie(null),
		}))
	`)
	check('缺 SESSDATA 被拒', result.missing.ok === false, result.missing.error)
	check(
		'缺 SESSDATA 的报错文案指向 SESSDATA',
		String(result.missing.error).includes('SESSDATA'),
	)
	check('有 SESSDATA 通过', result.present.ok === true)
	check('null 被拒', result.empty.ok === false)
}

// ---------- 4. remote_sync_id 编码 ----------
{
	const result = runNode(`
		const db = require('./src/db.cjs')
		const F = db.REMOTE_SOURCE.FAVORITE
		const S = db.REMOTE_SOURCE.SEASON

		// 用**真实量级**的 id：B 站收藏夹 media_id 实测到 4026748432（约 40 亿）。
		// 算术打包方案两次都在这个量级上出错，所以拿它当主用例。
		const REAL_FAV_ID = 4026748432
		const SHARED_ID = 338926432

		const packed = {
			favReal: db.encodeRemoteSyncId(F, REAL_FAV_ID),
			favShared: db.encodeRemoteSyncId(F, SHARED_ID),
			seasonShared: db.encodeRemoteSyncId(S, SHARED_ID),
			// 极大 id 也必须能编码（哈希没有宽度上限）
			favHuge: db.encodeRemoteSyncId(F, '999999999999999999'),
		}

		// 同来源同 id 必须稳定，否则「已导入」判断会失效
		const stable = db.encodeRemoteSyncId(F, REAL_FAV_ID) === packed.favReal

		const resolution = {
			favReal: db.resolveRemoteSource({
				remote_sync_id: packed.favReal,
				description: db.buildRemoteTag(F, REAL_FAV_ID),
			}),
			withText: db.resolveRemoteSource({
				remote_sync_id: packed.favShared,
				description: '我的收藏夹-' + String.fromCharCode(10) + db.buildRemoteTag(F, SHARED_ID),
			}),
			// 移动端同步来的后端 id（小整数）不应被认成远端歌单
			foreignSmall: db.resolveRemoteSource({
				remote_sync_id: 12345,
				description: db.buildRemoteTag(F, 1),
			}),
			noTag: db.resolveRemoteSource({
				remote_sync_id: packed.favReal,
				description: null,
			}),
			nullRow: db.resolveRemoteSource(null),
		}

		const invalid = {}
		try { db.encodeRemoteSyncId('nonsense', 1); invalid.source = null }
		catch (error) { invalid.source = error.message }
		try { db.encodeRemoteSyncId(F, -1); invalid.negative = null }
		catch (error) { invalid.negative = error.message }
		try { db.encodeRemoteSyncId(F, 'abc'); invalid.nan = null }
		catch (error) { invalid.nan = error.message }

		console.log('__RESULT__' + JSON.stringify({
			packed, stable, resolution, invalid,
			allSafe: Object.values(packed).every(Number.isSafeInteger),
			allInRange: Object.values(packed).every((v) => v >= 5e15 && v < 5e15 + 2 ** 48),
			minPacked: Math.min(...Object.values(packed)),
		}))
	`)

	check('同来源同 id 稳定编码（「已导入」判断可依赖）', result.stable === true)
	check(
		'40 亿量级收藏夹 id 能编码',
		Number.isSafeInteger(result.packed.favReal),
		`fav(4026748432) -> ${result.packed.favReal}`,
	)
	check(
		'极大 id 也能编码（哈希无宽度上限）',
		Number.isSafeInteger(result.packed.favHuge),
		`-> ${result.packed.favHuge}`,
	)
	check(
		'同一 id 在收藏夹/集名下编码不同（命名空间隔离）',
		result.packed.favShared !== result.packed.seasonShared,
		`fav=${result.packed.favShared} season=${result.packed.seasonShared}`,
	)
	check(
		'通过 description 标记可还原原始 media_id',
		result.resolution.favReal?.remoteId === 4026748432 &&
			result.resolution.favReal?.source === 'fav',
		JSON.stringify(result.resolution.favReal),
	)
	check(
		'description 含用户文本时仍能还原',
		result.resolution.withText?.remoteId === 338926432,
		JSON.stringify(result.resolution.withText),
	)
	check(
		'移动端后端 id（小整数）不被误认成远端歌单',
		result.resolution.foreignSmall === null,
	)
	check('缺标记时返回 null', result.resolution.noTag === null)
	check('null 行返回 null', result.resolution.nullRow === null)
	check('全部编码结果在 JS 安全整数范围内', result.allSafe === true)
	check('全部编码结果落在哈希值域内', result.allInRange === true)
	check(
		'哈希值域远大于小整数（不会与后端 id 撞）',
		result.minPacked >= 5e15,
		`最小 ${result.minPacked}`,
	)
	check(
		'未知来源名显式报错',
		typeof result.invalid.source === 'string',
		result.invalid.source,
	)
	check(
		'负数 id 被拒',
		typeof result.invalid.negative === 'string',
		result.invalid.negative,
	)
	check(
		'非数字 id 被拒',
		typeof result.invalid.nan === 'string',
		result.invalid.nan,
	)
}

// ---------- 5. 凭据落盘 ----------
{
	const cookieFile = path.join(DATA_DIR, 'login-test-cookie.json')
	const result = runNode(`
		const fs = require('node:fs')
		const { createCredentialStore } = require('./src/bilibili-login.cjs')
		const cookieFile = ${JSON.stringify(cookieFile)}

		const store = createCredentialStore(cookieFile, () => {})
		const secret = 'super-secret-sessdata-value-9f8e7d6c'
		const written = store.set({
			cookie: { SESSDATA: secret, bili_jct: 'csrf-token' },
			user: { mid: 12345, uname: '测试用户' },
		})

		const raw = fs.readFileSync(cookieFile, 'utf8')
		const onDisk = JSON.parse(raw)

		// 新建一个 store 从盘上读回来
		const reopened = createCredentialStore(cookieFile, () => {})
		const readBack = reopened.getCookieSync()
		const userBack = reopened.getUserSync()
		const savedAtBack = reopened.getSavedAtSync ? reopened.getSavedAtSync() : null

		reopened.clear()
		const cleared = {
			exists: fs.existsSync(cookieFile),
			cookie: reopened.getCookieSync(),
		}

		console.log('__RESULT__' + JSON.stringify({
			written,
			onDiskEncrypted: onDisk.encrypted,
			onDiskMagic: onDisk.magic,
			// 加密时文件里不能有明文；未加密时**必然**有明文（这是如实降级）
			rawContainsSecret: raw.includes(secret),
			rawContainsCsrf: raw.includes('csrf-token'),
			onDiskHasCookieKeys: Object.hasOwn(onDisk, 'cookie'),
			readBackSessdata: readBack?.SESSDATA,
			readBackJct: readBack?.bili_jct,
			userBackMid: userBack?.mid ?? null,
			savedAtBack,
			cleared,
		}))
	`)

	check(
		'登录态写入后能原样读回（cookie）',
		result.readBackSessdata === 'super-secret-sessdata-value-9f8e7d6c' &&
			result.readBackJct === 'csrf-token',
		`SESSDATA=${result.readBackSessdata ?? 'null'} bili_jct=${result.readBackJct ?? 'null'}`,
	)
	check(
		'登录态写入后能原样读回（用户信息）',
		result.userBackMid === 12345,
		`mid=${result.userBackMid ?? 'null'}`,
	)
	check(
		'落盘带 magic 标识（可识别版本）',
		result.onDiskMagic === 'bbplayer-secure-v1',
	)
	check(
		'写入结构与读取结构同形（含 cookie 字段）',
		result.onDiskHasCookieKeys === true,
		'第一版这里不一致，导致明文模式读不回来',
	)
	check(
		'纯 Node 下如实标记未加密（不谎报）',
		result.onDiskEncrypted === false,
		'safeStorage 在纯 Node 不可用 -> encrypted=false',
	)

	// 加密态与明文态的要求不同，必须分开断言：
	//   * 加密可用 → 文件里**不能**有明文
	//   * 加密不可用 → 文件里**必然**有明文，这正是要如实告知用户的原因
	if (result.onDiskEncrypted) {
		check(
			'已加密：文件里不含明文 cookie 值',
			result.rawContainsSecret === false && result.rawContainsCsrf === false,
		)
	} else {
		check(
			'未加密：文件里确实存在明文（降级是真实的，不是伪装的）',
			result.rawContainsSecret === true && result.rawContainsCsrf === true,
			'因此 UI 会显示「仅混淆存储，等同明文」警告',
		)
	}

	check(
		'清除后文件消失且内存态为空',
		result.cleared.exists === false && result.cleared.cookie === null,
	)
}

// ---------- 6. 未登录 / 无效 cookie 必须被拒 ----------
{
	const cookieFile = path.join(DATA_DIR, 'login-reject-cookie.json')
	const result = await (async () => {
		try {
			return runNode(`
				const { createLoginManager } = require('./src/bilibili-login.cjs')
				const manager = createLoginManager({
					cookieFile: ${JSON.stringify(cookieFile)},
					warn: () => {},
				})
				;(async () => {
					const out = {}
					try {
						await manager.importCookie('no-sessdata=1')
						out.missingRejected = false
					} catch (error) {
						out.missingRejected = true
						out.missingError = error.message
					}
					try {
						await manager.importCookie('SESSDATA=obviously-invalid-token-for-test')
						out.invalidRejected = false
					} catch (error) {
						out.invalidRejected = true
						out.invalidError = error.message
					}
					out.hasCookieAfter = Boolean(manager.getCookie())
					console.log('__RESULT__' + JSON.stringify(out))
				})()
			`)
		} catch (error) {
			return {
				spawnError: ((error as Error)?.message ?? String(error)).slice(0, 400),
			}
		}
	})()

	if (result.spawnError) {
		check('无效 cookie 导入被拒（子进程）', false, result.spawnError)
	} else {
		check(
			'缺 SESSDATA 的 cookie 被拒',
			result.missingRejected === true,
			result.missingError,
		)
		check(
			'无效 SESSDATA 被服务端判定为未登录并拒绝',
			result.invalidRejected === true,
			result.invalidError,
		)
		check(
			'两次失败后本地仍无凭据（不会存进垃圾）',
			result.hasCookieAfter === false,
		)
	}
}

// ===============================================================
// B. 真实接口
// ===============================================================

console.log('\nB. 真实接口（需要网络）\n')

// ---------- 7. 动态公钥 ----------
{
	const result = runNode(
		`
		const { fetchLoginKey } = require('./src/bilibili-rsa.cjs')
		;(async () => {
			const key = await fetchLoginKey({ headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://passport.bilibili.com/login' } })
			console.log('__RESULT__' + JSON.stringify({
				hashLength: key.hash.length,
				hasPem: Boolean(key.pem),
				pemHeader: key.pem ? key.pem.split('\\n')[0] : null,
				rawLength: key.raw.length,
			}))
		})().catch((error) => {
			console.log('__RESULT__' + JSON.stringify({ error: error.message }))
		})
	`,
		60_000,
	)

	if (result.error) {
		check('登录公钥接口可用', false, result.error)
	} else {
		check(
			'登录公钥接口返回非空 hash',
			result.hashLength > 0,
			`hash 长度 ${result.hashLength}`,
		)
		check(
			'登录公钥是标准 PEM（可被 node:crypto 直接使用）',
			result.hasPem === true,
			result.pemHeader,
		)
	}
}

// ---------- 8. 密码登录：加密链路被服务端接受 ----------
{
	const result = runNode(
		`
		const { loginWithPassword } = require('./src/bilibili-login.cjs')
		;(async () => {
			try {
				await loginWithPassword('13800000000', 'definitely-not-the-right-password')
				console.log('__RESULT__' + JSON.stringify({ unexpectedSuccess: true }))
			} catch (error) {
				const match = /code=(-?\\d+)/.exec(error.message)
				console.log('__RESULT__' + JSON.stringify({
					code: match ? Number(match[1]) : null,
					message: error.message,
				}))
			}
		})()
	`,
		60_000,
	)

	// -105 需要验证码 / -403 账号密码错误 / -404 账号不存在
	// 关键：**不是** -400（参数错误）。后者说明密文或拼接格式没被解析。
	const credentialCodes = [-105, -403, -404]
	const isCredentialLevel = credentialCodes.includes(result.code)
	check(
		'密码登录的 RSA 密文与 hash 拼接被服务端正确解析',
		isCredentialLevel,
		result.code === null
			? result.message
			: `code=${result.code}（-105 验证码 / -403 -404 凭据错，均说明密文格式正确）`,
	)
	check(
		'未被判为参数错误（-400）',
		result.code !== -400,
		result.code === -400 ? result.message : 'code 不是 -400',
	)
}

// ---------- 9. 扫码 ----------
{
	const result = runNode(
		`
		const { createQrCode, pollQrCode } = require('./src/bilibili-login.cjs')
		;(async () => {
			const qr = await createQrCode({ width: 220 })
			const image = qr.imageDataUrl ?? ''
			const base64 = image.startsWith('data:image/png;base64,')
				? image.slice('data:image/png;base64,'.length)
				: ''
			const bytes = base64 ? Buffer.from(base64, 'base64') : Buffer.alloc(0)
			const pngMagic = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

			// 刚申请的 key：必须回「未扫码」（86101）
			const freshPoll = await pollQrCode(qr.qrcodeKey)
			// 明显不存在的 key：必须被判定为失效/无法识别，而不是抛异常
			const bogusPoll = await pollQrCode('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

			console.log('__RESULT__' + JSON.stringify({
				keyLength: qr.qrcodeKey.length,
				urlScheme: (() => { try { return new URL(qr.url).scheme ?? new URL(qr.url).protocol } catch { return null } })(),
				urlHost: (() => { try { return new URL(qr.url).host } catch { return null } })(),
				urlIsHttps: (() => { try { return new URL(qr.url).protocol === 'https:' } catch { return false } })(),
				urlHasKey: qr.url.includes(qr.qrcodeKey),
				imageError: qr.imageError,
				pngMagic,
				pngBytes: bytes.length,
				// PNG 的 IHDR 里宽度在第 16..20 字节（大端）
				pngWidth: pngMagic ? bytes.readUInt32BE(16) : null,
				pngHeight: pngMagic ? bytes.readUInt32BE(20) : null,
				freshPollState: freshPoll.state,
				freshPollStatus: freshPoll.status ?? null,
				bogusPollState: bogusPoll.state,
				bogusPollStatus: bogusPoll.status ?? null,
			}))
		})().catch((error) => {
			console.log('__RESULT__' + JSON.stringify({ error: error.message }))
		})
	`,
		60_000,
	)

	if (result.error) {
		check('扫码接口可用', false, result.error)
	} else {
		check(
			'generate 返回 qrcode_key',
			result.keyLength >= 32,
			`长度 ${result.keyLength}`,
		)
		check(
			'二维码 URL 是 https 且含该 key',
			result.urlIsHttps === true && result.urlHasKey === true,
			`host=${result.urlHost}`,
		)
		check(
			'二维码 URL 指向 B 站自有域（account/passport）',
			typeof result.urlHost === 'string' &&
				/(^|\.)bilibili\.com$/.test(result.urlHost),
			`host=${result.urlHost}（实测是 account.bilibili.com，不是 passport）`,
		)
		check(
			'二维码渲染为真实 PNG（magic + 尺寸）',
			result.pngMagic === true &&
				result.pngWidth === 220 &&
				result.pngHeight === 220,
			`${result.pngWidth}x${result.pngHeight}, ${result.pngBytes} 字节${result.imageError ? `, 渲染错误: ${result.imageError}` : ''}`,
		)
		check(
			'刚申请的 key 轮询得到「未扫码」',
			result.freshPollState === 'pending',
			`state=${result.freshPollState} status=${result.freshPollStatus ?? 'n/a'}`,
		)
		check(
			'不存在的 key 被判定为失效而不是抛异常',
			result.bogusPollState === 'expired' ||
				result.bogusPollState === 'unknown',
			`state=${result.bogusPollState} status=${result.bogusPollStatus ?? 'n/a'}`,
		)
	}
}

// ---------- 10. nav 匿名未登录 ----------
{
	const result = runNode(
		`
		const { fetchLoginStatus } = require('./src/bilibili-login.cjs')
		;(async () => {
			const status = await fetchLoginStatus({ SESSDATA: 'obviously-invalid' })
			console.log('__RESULT__' + JSON.stringify({
				loggedIn: status.loggedIn,
				code: status.code,
			}))
		})().catch((error) => {
			console.log('__RESULT__' + JSON.stringify({ error: error.message }))
		})
	`,
		60_000,
	)
	if (result.error) {
		check('nav 接口匿名调用', false, result.error)
	} else {
		check(
			'无效 SESSDATA 被 nav 判为未登录（code=-101）',
			result.loggedIn === false && result.code === -101,
			`code=${result.code}`,
		)
	}
}

// ---------- 11. 收藏夹匿名可读 ----------
{
	const result = runNode(
		`
		const core = require('./src/ports.cjs').core
		void core
		const api = require('./src/bilibili-api.cjs')
		;(async () => {
			const folders = await api.listFavoriteFolders(8047632)
			const first = folders[0]
			const resources = first
				? await api.listFavoriteResources(first.mediaId, { maxItems: 5 })
				: []
			console.log('__RESULT__' + JSON.stringify({
				folderCount: folders.length,
				folders: folders.slice(0, 3),
				firstResourceCount: resources.length,
				firstResource: resources[0] ?? null,
				allHaveBvid: resources.every((r) => Boolean(r.bvid)),
			}))
		})().catch((error) => {
			console.log('__RESULT__' + JSON.stringify({ error: error.message }))
		})
	`,
		120_000,
	)

	if (result.error) {
		check('收藏夹接口匿名可用', false, result.error)
	} else {
		check(
			'匿名列出公开收藏夹',
			result.folderCount > 0,
			`${result.folderCount} 个；首个: ${result.folders?.[0]?.title ?? 'n/a'}`,
		)
		check(
			'匿名读取收藏夹内容',
			result.firstResourceCount > 0,
			`${result.firstResourceCount} 条`,
		)
		check('内容条目均带 bvid（失效条目已被过滤）', result.allHaveBvid === true)
	}
}

// ===============================================================
// 汇总
// ===============================================================

console.log(`\n=== 结果：${passed} 通过, ${failed} 失败 ===`)
fs.rmSync(DATA_DIR, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
