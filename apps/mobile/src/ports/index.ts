/**
 * 平台端口的 React Native / Expo 实现。
 *
 * `packages/core` 只认识 `@bbplayer/core` 里的 port 接口；移动端在这里把
 * MMKV / expo-secure-store / expo-sqlite / nitro-fetch / 现有日志实例接上去。
 *
 * 桌面端会有对应的 `apps/desktop/src/ports/`（better-sqlite3 / fs / Node fetch），
 * 两端因此可以共用同一套业务逻辑。
 */
import type {
	CorePorts,
	DbPort,
	HttpPort,
	LoggerPort,
	SecureStoragePort,
	SqliteSyncPort,
	StoragePort,
} from '@bbplayer/core'
import { registerCorePorts } from '@bbplayer/core'

import drizzleDb, { expoDb } from '@/lib/db/db'
import log from '@/utils/log'
import { storage } from '@/utils/mmkv'

// ============================================================
// Logger
// ============================================================

/**
 * `@bbplayer/logs` 的 logger 已具备 extend / debug / info / warning / error，
 * 这里只做一层显式适配（并统一 warning -> warn 的命名）。
 */
const logger: LoggerPort = {
	debug: (message, meta) => log.debug(message, meta),
	info: (message, meta) => log.info(message, meta),
	warn: (message, meta) => log.warning(message, meta),
	error: (message, meta) => log.error(message, meta),
	extend: (scope) => {
		const scoped = log.extend(scope)
		return {
			debug: (message, meta) => scoped.debug(message, meta),
			info: (message, meta) => scoped.info(message, meta),
			warn: (message, meta) => scoped.warning(message, meta),
			error: (message, meta) => scoped.error(message, meta),
			extend: (nested) => logger.extend(nested),
		}
	},
}

export { logger as loggerPort }

// ============================================================
// Storage（MMKV）
// ============================================================

/**
 * MMKV 的读写是同步的，直接映射到 `StoragePort`。
 *
 * 注意 `remove` -> `delete` 的命名差异，以及返回值统一为 `string | undefined`。
 */
export const storagePort: StoragePort = {
	getString: (key) => storage.getString(key as never),
	getBoolean: (key) => storage.getBoolean(key as never),
	set: (key, value) => storage.set(key as never, value as never),
	delete: (key) => storage.remove(key as never),
	contains: (key) => storage.contains(key as never),
	clearAll: () => storage.clearAll(),
}

// ============================================================
// Secure storage（expo-secure-store）
// ============================================================

export const secureStoragePort: SecureStoragePort = {
	getItem: async (key) => {
		const { getItemAsync } = await import('expo-secure-store')
		return await getItemAsync(key)
	},
	setItem: async (key, value) => {
		const { setItemAsync } = await import('expo-secure-store')
		await setItemAsync(key, value)
	},
	deleteItem: async (key) => {
		const { deleteItemAsync } = await import('expo-secure-store')
		await deleteItemAsync(key)
	},
}

// ============================================================
// Database（expo-sqlite + drizzle）
// ============================================================

/**
 * expo-sqlite 的同步 API 与 `SqliteSyncPort` 语义一致，但 `runSync` 的形参
 * 声明（重载 + `SQLiteBindParams`）比 port 更宽，无法直接结构化赋值。
 * 这里逐方法收敛为 port 的窄签名 —— 只做类型收缩，无运行时行为变化。
 */
const sqlitePort: SqliteSyncPort = {
	execSync: (source) => expoDb.execSync(source),
	runSync: (source, params) => expoDb.runSync(source, params as never),
	// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T 由调用方指定查询结果形状，见 SqliteSyncPort 的说明
	getFirstSync: <T>(source: string, params?: unknown[]) =>
		expoDb.getFirstSync<T>(source, params as never),
	getAllSync: <T>(source: string, params?: unknown[]) =>
		expoDb.getAllSync<T>(source, params as never),
	withTransactionSync: (task) => expoDb.withTransactionSync(task),
}

/**
 * 注意 `client` / `orm` 的类型是 `unknown`：Drizzle 的 `ExpoSQLiteDatabase` 与
 * `BetterSQLite3Database` 在类型上互不兼容，port 刻意不固化任一方。
 * core 内部取用时按需断言，两端只要保证用**同一份** schema 构建即可。
 */
export const dbPort: DbPort = {
	client: expoDb,
	sqlite: sqlitePort,
	orm: drizzleDb,
}

/** 移动端特有的便利访问器：业务代码仍可直接拿到强类型的 drizzle 实例 */
export { drizzleDb }

// ============================================================
// HTTP（nitro-fetch）
// ============================================================

/**
 * `react-native-nitro-fetch` 的 `fetch` 返回标准 `Response`，
 * 与本 port 的最小契约结构兼容；差异只在 `init` 的宽松度上。
 */
export const httpPort: HttpPort = async (input, init) => {
	const { fetch: nitroFetch } = await import('react-native-nitro-fetch')
	return await nitroFetch(input, init)
}
// ============================================================
// 聚合
// ============================================================

export const corePorts: CorePorts = {
	logger,
	storage: storagePort,
	secureStorage: secureStoragePort,
	db: dbPort,
	http: httpPort,
}

/**
 * 在应用启动的最早时机调用一次，让 `packages/core` 内部的模块
 * （数据迁移、WBI 签名缓存等）能取到平台能力。
 */
export function registerMobileCorePorts(): void {
	registerCorePorts(corePorts)
}
