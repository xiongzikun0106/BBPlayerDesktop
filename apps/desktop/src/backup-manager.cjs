/**
 * 备份管理器：把「配置持久化 + WebDAV 客户端缓存 + 备份/恢复编排」收在一处。
 *
 * ## 凭据怎么存
 *
 * 与移动端一致的分工：
 *   * **地址 / 用户名 / 目录** 属于非敏感配置 -> 普通 KV（`kv.json`）
 *   * **密码** -> `safeStorage` 加密后单独落盘（`webdav-password.json`），
 *     绝不出现在普通 KV、日志、备份归档里
 *
 * 移动端用的是 SecureStore，桌面端用 `safeStorage`（Windows 走 DPAPI）。
 * 密钥环不可用时**如实告知**（`encrypted: false`），不静默降级。
 */
const fs = require('node:fs')
const path = require('node:path')

const backup = require('./backup.cjs')
const webdav = require('./backup-webdav.cjs')

const CONFIG_KEYS = {
	url: 'webdav_backup_url',
	username: 'webdav_backup_username',
	directory: 'webdav_backup_directory',
}

/**
 * 系统密钥环是否可用。
 *
 * 刻意放在模块作用域：它不捕获任何闭包变量（`unicorn/consistent-function-scoping`
 * 的提示正是用来指出这类函数），而且「有没有密钥环」是进程级事实，
 * 与哪个 manager 实例无关。
 *
 * 纯 Node（验证脚本）下 `require('electron')` 会抛，那属于**预期路径**：
 * 返回 false，调用方据此如实降级而不是静默假装已加密。
 */
function isSafeStorageAvailable() {
	try {
		const { safeStorage } = require('electron')
		// 直接返回库的判断结果（它本身就是 boolean），不做多余包装
		return safeStorage?.isEncryptionAvailable?.() ?? false
	} catch {
		return false
	}
}

/**
 * 创建备份管理器。
 *
 * @param {object} options
 * @param {string} options.dataDir 数据目录
 * @param {string} options.dbFile 数据库文件
 * @param {string} options.baselineName 基线迁移文件名
 * @param {object} options.storage core 的 StoragePort（KV 端口）
 * @param {(message: string, meta?: object) => void} [options.log]
 */
function createBackupManager({
	dataDir,
	dbFile,
	baselineName,
	storage,
	log = () => {},
}) {
	const PASSWORD_FILE = path.join(dataDir, 'webdav-password.json')

	/** 缓存的 WebDAV 门面：配置变了就重建 */
	let clientCache = null
	let clientCacheKey = null

	// ---------------------------------------------------------------
	// 密码的加密落盘（复用登录模块那套 safeStorage 逻辑）
	// ---------------------------------------------------------------

	/** 与 `bilibili-login.cjs` 用的是同一个 magic，便于统一识别 */
	const PASSWORD_MAGIC = 'bbplayer-secure-v1'

	function readPassword() {
		let raw
		try {
			raw = fs.readFileSync(PASSWORD_FILE, 'utf8')
		} catch {
			return null
		}
		let parsed
		try {
			parsed = JSON.parse(raw)
		} catch {
			return null
		}
		if (parsed?.magic !== PASSWORD_MAGIC) return null

		if (parsed.encrypted) {
			try {
				const { safeStorage } = require('electron')
				if (!safeStorage?.isEncryptionAvailable?.()) {
					log('密钥环不可用，无法解密 WebDAV 密码')
					return null
				}
				return safeStorage.decryptString(Buffer.from(parsed.payload, 'base64'))
			} catch (error) {
				log(`解密 WebDAV 密码失败：${error.message}`)
				return null
			}
		}
		return typeof parsed.password === 'string' ? parsed.password : null
	}

	/** 写密码；返回是否真正加密（未加密时调用方要如实告知用户） */
	function writePassword(password) {
		const safeStorage = (() => {
			try {
				return require('electron').safeStorage ?? null
			} catch {
				return null
			}
		})()

		let encrypted = false
		let payload = null
		if (safeStorage?.isEncryptionAvailable?.()) {
			try {
				payload = safeStorage.encryptString(password).toString('base64')
				encrypted = true
			} catch (error) {
				log(`加密 WebDAV 密码失败，退回未加密：${error.message}`)
			}
		}

		const onDisk = encrypted
			? { magic: PASSWORD_MAGIC, encrypted: true, payload }
			: {
					magic: PASSWORD_MAGIC,
					encrypted: false,
					password,
					note: 'plaintext fallback: 系统无可用密钥环（safeStorage 不可用），此文件未加密',
				}

		fs.mkdirSync(path.dirname(PASSWORD_FILE), { recursive: true })
		fs.writeFileSync(PASSWORD_FILE, JSON.stringify(onDisk, null, 2), 'utf8')
		return encrypted
	}

	function clearPassword() {
		try {
			fs.unlinkSync(PASSWORD_FILE)
		} catch {
			// 文件不存在即可
		}
	}

	function isPasswordEncrypted() {
		return isSafeStorageAvailable()
	}

	// ---------------------------------------------------------------
	// 配置
	// ---------------------------------------------------------------

	async function readConfig() {
		const [url, username, directory] = await Promise.all([
			storage.getItem(CONFIG_KEYS.url),
			storage.getItem(CONFIG_KEYS.username),
			storage.getItem(CONFIG_KEYS.directory),
		])
		return {
			url: url ?? '',
			username: username ?? '',
			directory: webdav.normalizeDirectory(directory ?? ''),
			hasPassword: Boolean(readPassword()),
		}
	}

	/**
	 * 保存配置。
	 *
	 * `password` 省略时**保留原密码**（用户只改地址时不必重输密码）。
	 * 传空串则清除密码。
	 */
	async function saveConfig({ url, username, directory, password }) {
		await storage.setItem(CONFIG_KEYS.url, url ?? '')
		await storage.setItem(CONFIG_KEYS.username, username ?? '')
		await storage.setItem(
			CONFIG_KEYS.directory,
			webdav.normalizeDirectory(directory ?? ''),
		)

		let encrypted = null
		if (password !== undefined) {
			if (password === '') {
				clearPassword()
			} else {
				encrypted = writePassword(password)
			}
		}

		// 配置变了，丢掉缓存的客户端
		clientCache = null
		clientCacheKey = null

		return { ...(await readConfig()), passwordEncrypted: encrypted }
	}

	/** 取（并按需重建）WebDAV 门面 */
	async function requireClient() {
		const config = await readConfig()
		if (!config.url) throw new Error('尚未配置 WebDAV 地址')
		if (!config.username) throw new Error('尚未配置 WebDAV 用户名')
		const password = readPassword()
		if (!password) {
			throw new Error('尚未配置 WebDAV 密码（或密钥环不可用导致无法解密）')
		}

		const key = `${config.url}\u0000${config.username}\u0000${password}\u0000${config.directory}`
		if (clientCache && clientCacheKey === key) return clientCache

		clientCache = webdav.createWebDavTransport({
			baseUrl: config.url,
			username: config.username,
			password,
			directory: config.directory,
			log,
		})
		clientCacheKey = key
		return clientCache
	}

	// ---------------------------------------------------------------
	// 编排
	// ---------------------------------------------------------------

	/**
	 * 生成一份备份（纯本地，不涉及网络）。
	 *
	 * MMKV 的取值：桌面端没有 MMKV。移动端的三个键里 `app-storage` 存的是
	 * 它自己的设置，桌面端**没有对应物**，所以按移动端的语义发空串
	 * —— 空串在移动端意味着「恢复时保留目标已有的值」，不会覆盖掉
	 * 移动用户的设置。
	 */
	function createBackupToBuffer() {
		const result = backup.createBackup({ dbFile, baselineName, mmkv: {}, log })
		return {
			filename: result.filename,
			manifest: result.manifest,
			stats: result.stats,
			archiveBytes: result.buffer.length,
			buffer: result.buffer,
		}
	}

	return {
		readConfig,
		saveConfig,
		isPasswordEncrypted,
		/** 清掉缓存的客户端（改了配置或要重新连接时用） */
		invalidateClient() {
			clientCache = null
			clientCacheKey = null
		},

		createBackupToBuffer,

		/** 把备份写到本地文件（用户选目录的场景；WebDAV 走 upload） */
		createBackupToFile(targetDir) {
			const made = createBackupToBuffer()
			fs.mkdirSync(targetDir, { recursive: true })

			// 避免覆盖已有文件：加 (2) / (3) 后缀。
			// 移动端依赖 SAF/MediaStore 自己去重，桌面端没有那层保障，
			// 所以这里显式处理，免得用户连点两次把上一份覆盖掉。
			const ext = path.extname(made.filename)
			const stem = made.filename.slice(0, -ext.length)
			let target = path.join(targetDir, made.filename)
			let index = 2
			while (fs.existsSync(target)) {
				target = path.join(targetDir, `${stem} (${index})${ext}`)
				index += 1
				if (index > 9999) break
			}

			fs.writeFileSync(target, made.buffer)
			log(`备份已写入 ${target}`)
			return {
				path: target,
				filename: path.basename(target),
				bytes: made.buffer.length,
				stats: made.stats,
			}
		},

		/** 只校验一份备份（不上传、不恢复），用于「选择文件后先看信息」 */
		inspect(buffer) {
			const parsed = backup.parseBackup(buffer)
			return {
				manifest: parsed.manifest,
				dbBytes: parsed.dbBytes.length,
				warnings: parsed.warnings,
			}
		},

		/**
		 * 从本地文件恢复。
		 *
		 * ⚠️ 恢复后数据库连接会被关闭（Windows 上替换文件的前提），
		 * **必须重启应用**才能继续使用 —— 与移动端的要求一致。
		 */
		restoreFromBuffer(buffer) {
			return backup.restoreBackup({ buffer, dbFile, baselineName, log })
		},

		// ---------- 远端 ----------

		async testConnection() {
			const client = await requireClient()
			return await client.testConnection()
		},

		async listRemote() {
			const client = await requireClient()
			return await client.listBackups()
		},

		async uploadLatest() {
			const client = await requireClient()
			const made = createBackupToBuffer()
			const uploaded = await client.upload(made.buffer, made.filename)
			return { ...uploaded, stats: made.stats, manifest: made.manifest }
		},

		async downloadRemote(remotePath) {
			const client = await requireClient()
			return await client.download(remotePath)
		},

		/** 详情：供 UI 展示「已配置什么、密码是否加密」 */
		async describe() {
			const config = await readConfig()
			return {
				...config,
				passwordEncrypted: isPasswordEncrypted(),
				dbFile,
				// 明确告知「本地导出」的落点，避免用户找不到文件
				defaultExportDir: path.join(dataDir, 'backups'),
			}
		},
	}
}

module.exports = { createBackupManager, CONFIG_KEYS }
