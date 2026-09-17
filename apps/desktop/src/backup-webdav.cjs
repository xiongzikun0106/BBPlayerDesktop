/**
 * WebDAV 备份传输（Phase 4.5）。
 *
 * ## 复用 core，而不是重写一个 WebDAV 客户端
 *
 * `packages/core/src/backup/webdav-client.ts` 已经是**平台无关**的：
 * 它把 fetch 实现作为依赖注入（`configureWebDavTransport`），
 * 自己处理 Basic → Digest 的 401 回退、XML 实体扩展上限、路径规范化
 * 与错误分类。移动端注入了 RN 的 `globalThis.fetch`；桌面端注入 Node 的
 * `globalThis.fetch` 即可 —— **两端走同一份代码，行为不可能漂移**。
 *
 * ⚠️ 这个注入是**进程级全局副作用**（它 patch 了 `webdav` 库内部的
 * fetch patcher），所以只需配置一次，重复配置是幂等的。
 *
 * ## 远端约定（决定移动端能否看到桌面传的备份）
 *
 * * 目录默认 `/BBPlayer`；
 * * 文件名必须匹配 `/^backup-.+\.bbplayer$/` —— 移动端用这个正则过滤，
 *   **不匹配就列不出来**；
 * * 移动端**没有删除/保留策略**（它的 WebDAV 适配器压根没有 `deleteFile`），
 *   所以桌面端也不做清理，不引入移动端没有的行为。
 *
 * ## 密码不进备份、不进日志
 *
 * 与移动端一致：密码只作为**传输凭据**（Basic/Digest），
 * 绝不写进归档。桌面端把它交给 `safeStorage` 加密落盘（见 credentials）。
 */
const { core } = require('./ports.cjs')

/** 默认远端目录（与移动端 `webdav.ts` 的默认值一致） */
const DEFAULT_DIRECTORY = '/BBPlayer'

/** 移动端的备份文件匹配规则 —— 桌面端上传的名字必须命中 */
const BACKUP_FILE_PATTERN = /^backup-.+\.bbplayer$/

/** 各类错误的可执行提示 */
const WEBDAV_ERROR_HINTS = {
	authentication: '用户名或密码不正确（或该服务需要应用专用密码）',
	permission: '账号没有该目录的写入权限',
	'not-found': '远端路径不存在（目录会在上传前自动创建）',
	protocol: '服务端协议错误：请确认填的是 WebDAV 地址，而不是网页地址',
	network: '无法连接：检查地址、端口与网络（自签证书也会导致失败）',
	unknown: '未知错误',
}

/**
 * 判定错误的种类。
 *
 * ⚠️ 不能只看 `error.kind`。实测：**认证失败（401）时**，`webdav` 库会
 * 拿 401 的响应体去解析 XML，失败后抛出
 * `Invalid response: No root multistatus found` —— 这时 `kind` 是
 * `undefined`，而请求日志清清楚楚是 401。只看 `kind` 会把「密码错了」
 * 报成「未知错误」，用户完全不知道该改什么。
 *
 * 所以按三级回退判定：`status` -> `kind` -> 错误文案里的线索。
 */
function classifyWebDavError(error) {
	const byStatus = {
		401: 'authentication',
		403: 'permission',
		404: 'not-found',
	}
	if (error?.status && byStatus[error.status]) return byStatus[error.status]
	if (error?.kind && error.kind !== 'unknown') return error.kind

	// 库丢了 status 的情况：从文案里认出来
	const message = String(error?.message ?? '')
	if (/401|unauthorized|Invalid response/i.test(message))
		return 'authentication'
	if (/403|forbidden/i.test(message)) return 'permission'
	if (/404|not found/i.test(message)) return 'not-found'
	if (/digest|multistatus|response/i.test(message)) return 'protocol'
	return 'unknown'
}

let transportConfigured = false

/**
 * 把 Node 的 fetch 注入 core 的 WebDAV 客户端。
 *
 * 必须在 `createWebDavClient` **之前**调用一次，否则它抛
 * 「WebDAV transport is not configured」。
 */
function ensureTransport() {
	if (transportConfigured) return true
	if (typeof core.configureWebDavTransport !== 'function') {
		throw new Error(
			'core 未导出 configureWebDavTransport，无法配置 WebDAV 传输层',
		)
	}
	core.configureWebDavTransport(globalThis.fetch)
	transportConfigured = true
	return true
}

/** 规范化远端目录：去掉多余斜杠，空值落回默认 */
function normalizeDirectory(input) {
	const raw = String(input ?? '').trim()
	if (!raw) return DEFAULT_DIRECTORY
	// 折掉重复斜杠，再去掉尾部斜杠（core 的 normalizePath 会补上前导斜杠）
	const collapsed = raw.replaceAll(/\/{2,}/g, '/')
	const withoutTrailing = collapsed.replace(/\/+$/, '')
	if (!withoutTrailing) return DEFAULT_DIRECTORY
	return withoutTrailing.startsWith('/')
		? withoutTrailing
		: `/${withoutTrailing}`
}

/** 拼接远端路径（与移动端 `joinWebDavPath` 同语义） */
function joinRemotePath(directory, name) {
	return `${directory.replace(/\/+$/, '')}/${name}`
}

/**
 * 创建 WebDAV 门面。
 *
 * @param {object} options
 * @param {string} options.baseUrl 形如 `https://dav.example.com/dav`
 * @param {string} options.username
 * @param {string} options.password
 * @param {string} [options.directory] 远端目录，默认 `/BBPlayer`
 * @param {(message: string, meta?: object) => void} [options.log]
 */
function createWebDavTransport({
	baseUrl,
	username,
	password,
	directory,
	log = () => {},
}) {
	ensureTransport()

	if (!baseUrl) throw new Error('WebDAV 地址不能为空')
	if (!username || !password) {
		throw new Error('WebDAV 用户名和密码不能为空')
	}

	const remoteDirectory = normalizeDirectory(directory)

	// core 的客户端在构造时就校验 URL 协议并剥掉尾部斜杠
	const client = core.createWebDavClient({
		baseUrl,
		username,
		password,
	})

	/**
	 * 把 core / `webdav` 库的错误翻成用户能照着做的提示。
	 *
	 * ⚠️ 不能只看 `error.kind`。实测：**认证失败（401）时**，`webdav` 库会
	 * 拿 401 的响应体去解析 XML，失败后抛出
	 * `Invalid response: No root multistatus found` —— 这时 `kind` 是
	 * `undefined`，请求日志却清清楚楚是 401。只看 `kind` 会把「密码错了」
	 * 报成「未知错误」，用户完全不知道该改什么。
	 *
	 * 所以按三级回退判定：`status` -> `kind` -> 错误文案里的线索。
	 */
	function classify(error) {
		return classifyWebDavError(error)
	}

	/** 把 core 的 WebDavError 翻成用户能照着做的提示 */
	function describeError(error, what) {
		const kind = classify(error)
		return `${what}失败：${error?.message ?? String(error)} —— ${WEBDAV_ERROR_HINTS[kind] ?? WEBDAV_ERROR_HINTS.unknown}`
	}

	/** 统一的调用包装：把 core 的错误类型转成可读消息 */
	async function call(what, fn) {
		try {
			return await fn()
		} catch (error) {
			// 保留原始错误（含 kind/status），便于上层与日志排查
			throw new Error(describeError(error, what), { cause: error })
		}
	}

	return {
		baseUrl,
		directory: remoteDirectory,

		/**
		 * 测试连通性。
		 *
		 * `checkConnection` 会要求路径是**目录**（stat 后断言 type=directory），
		 * 所以这里先确保目录存在再检查 —— 否则一个还没建过目录的新账号
		 * 会得到「测试失败」，而其实只是目录没建。
		 */
		async testConnection() {
			return await call('连接测试', async () => {
				await client.ensureDirectory(remoteDirectory)
				await client.checkConnection(remoteDirectory)
				return { directory: remoteDirectory }
			})
		},

		/** 列出远端备份（按移动端的规则过滤 + 按修改时间倒序） */
		async listBackups() {
			return await call('列出远端备份', async () => {
				let entries
				try {
					entries = await client.listDirectory(remoteDirectory)
				} catch (error) {
					// 目录还不存在 -> 视为「没有备份」，而不是报错
					if (error?.kind === 'not-found') return []
					throw error
				}
				return entries
					.filter(
						(entry) =>
							entry.type === 'file' && BACKUP_FILE_PATTERN.test(entry.name),
					)
					.map((entry) => ({
						name: entry.name,
						path: joinRemotePath(remoteDirectory, entry.name),
						bytes: entry.size ?? null,
						lastModified: entry.lastModified
							? new Date(entry.lastModified).getTime()
							: null,
					}))
					.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))
			})
		},

		/**
		 * 上传一份备份。
		 *
		 * 文件名由 `backup.cjs` 生成（形如
		 * `backup-2026-09-17T15-55-42-666Z.bbplayer`），**必须**匹配
		 * 移动端的列表正则，否则传上去也看不见。
		 */
		async upload(buffer, filename) {
			if (!BACKUP_FILE_PATTERN.test(filename)) {
				throw new Error(
					`备份文件名「${filename}」不匹配移动端的列表规则 ` +
						`${BACKUP_FILE_PATTERN}，移动端将看不到这份备份`,
				)
			}
			return await call('上传备份', async () => {
				await client.ensureDirectory(remoteDirectory)
				const target = joinRemotePath(remoteDirectory, filename)
				// core 的 uploadFile 要 ArrayBuffer，且会自己带上 contentLength
				const arrayBuffer = buffer.buffer.slice(
					buffer.byteOffset,
					buffer.byteOffset + buffer.byteLength,
				)
				await client.uploadFile(target, arrayBuffer)
				log(`已上传 ${filename}（${buffer.length} 字节）到 ${target}`)
				return {
					path: target,
					name: filename,
					bytes: buffer.length,
				}
			})
		},

		/** 下载一份备份（按远端完整路径，移动端也是用服务端给的 path） */
		async download(remotePath) {
			return await call('下载备份', async () => {
				const data = await client.downloadFile(remotePath)
				return Buffer.from(data)
			})
		},
	}
}

module.exports = {
	createWebDavTransport,
	ensureTransport,
	normalizeDirectory,
	joinRemotePath,
	DEFAULT_DIRECTORY,
	BACKUP_FILE_PATTERN,
}
