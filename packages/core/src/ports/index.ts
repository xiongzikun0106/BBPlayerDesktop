/**
 * 平台端口（ports）。
 *
 * `packages/core` 本身不认识 React Native、Expo 或 Node —— 它只依赖这里定义的
 * 接口。各端（`apps/mobile`、未来的 `apps/desktop`）在启动时注入自己的实现。
 *
 * 这套设计是「9.5k 行业务逻辑两端共用」的关键：core 里的 service / facade
 * 只 import 这些类型，不 import 任何平台库。
 */

// ============================================================
// Logger
// ============================================================

export interface LoggerPort {
	debug(message: string, meta?: unknown): void
	info(message: string, meta?: unknown): void
	warn(message: string, meta?: unknown): void
	error(message: string, meta?: unknown): void
	/** 派生子 logger，用于标注来源 */
	extend(scope: string): LoggerPort
}

// ============================================================
// Storage（key-value）
// ============================================================

export interface StoragePort {
	getString(key: string): string | undefined
	getBoolean(key: string): boolean | undefined
	set(key: string, value: string): void
	delete(key: string): void
	contains(key: string): boolean
	clearAll(): void
}

/**
 * 供状态库持久化使用的最小异步接口。
 *
 * 移动端由 MMKV 提供（同步语义包装成异步），桌面端可由文件或 SQLite 实现。
 */
export interface AsyncKeyValueStorage {
	getItem(name: string): Promise<string | null>
	setItem(name: string, value: string): Promise<void>
	removeItem(name: string): Promise<void>
}

/**
 * 敏感凭据存储（Cookie / Token）。
 *
 * 移动端用 `expo-secure-store`，桌面端可用系统钥匙串或本地加密文件。
 */
export interface SecureStoragePort {
	getItem(key: string): Promise<string | null>
	setItem(key: string, value: string): Promise<void>
	deleteItem(key: string): Promise<void>
}

// ============================================================
// B 站登录凭据
// ============================================================

/**
 * B 站登录态。
 *
 * core 里的 B 站 API 客户端通过这个端口拿 cookie，从而不需要知道
 * 「凭据存在哪里」（移动端是 MMKV 里的 store，桌面端可以是加密文件）。
 */
export interface BilibiliCredentialPort {
	/** 返回 cookie 键值对；未登录返回 null */
	getCookie(): Promise<Record<string, string> | null>
	/** 写入 cookie（扫码 / 手机号 / 手动粘贴登录后调用） */
	setCookie(cookie: Record<string, string> | null): Promise<void>
}

// ============================================================
// Database
// ============================================================

/**
 * 同步 SQLite 端口。
 *
 * 数据迁移是「建表 / 查列 / 改列」这类一次性同步操作，两端驱动都提供同步 API
 * （移动端 `expo-sqlite` 的 `runSync`/`getFirstSync`/...，桌面端 `better-sqlite3`
 * 本身即同步）。这里只固化**方法契约**，不固化驱动类型。
 *
 * 之所以不让迁移走 Drizzle：迁移要在 ORM 层还不存在时运行，直接发 SQL 更稳。
 */
export interface SqliteSyncPort {
	execSync(source: string): void
	runSync(source: string, params?: unknown[]): unknown
	// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T 只出现一次是**有意的**：调用方通过它标注查询结果的形状（`getFirstSync<{ name: string }>(...)`）。该规则针对的是「可用具体类型替代的冗余泛型」，不适用于这种由调用方决定类型的回调接口。
	getFirstSync<T>(source: string, params?: unknown[]): T | null
	getAllSync<T>(source: string, params?: unknown[]): T[]
	withTransactionSync(task: () => void): void
}

/**
 * 数据库连接端口。
 *
 * 刻意使用 `unknown` 作为底层类型：Drizzle 的 driver 类型（`expo-sqlite` 与
 * `better-sqlite3` / `node:sqlite`）在类型层面互不兼容，若在此处固化任一方的
 * 类型，core 就会被绑死在某个驱动上。
 *
 * core 内部的 service 通过 `DbPort['orm']` 拿到具体的 Drizzle 实例并自行断言；
 * 各端只需保证注入的实例是用**同一份** `@bbplayer/core/db/schema` 构建的。
 */
export interface DbPort {
	/** 底层驱动实例（`expo-sqlite` 或 `better-sqlite3` 等） */
	readonly client: unknown
	/** 同步 SQL 接口，供数据迁移使用 */
	readonly sqlite: SqliteSyncPort
	/** Drizzle ORM 实例 */
	readonly orm: unknown
}

// ============================================================
// HTTP
// ============================================================

export interface HttpRequestInit {
	method?: string
	headers?: Record<string, string>
	body?: string
	signal?: AbortSignal
}

export interface HttpResponseLike {
	ok: boolean
	status: number
	statusText: string
	headers: { get(name: string): string | null }
	text(): Promise<string>
	json(): Promise<unknown>
	arrayBuffer(): Promise<ArrayBuffer>
}

/**
 * HTTP 端口。
 *
 * 移动端是 `react-native-nitro-fetch`，桌面端是 Node 原生 `fetch`。
 */
export type HttpPort = (
	input: string | URL,
	init?: HttpRequestInit,
) => Promise<HttpResponseLike>

// ============================================================
// Audio（播放引擎）
// ============================================================

export interface AudioTrack {
	id: string
	url: string
	title?: string
	artist?: string
	artwork?: string
	duration?: number
}

export enum AudioRepeatMode {
	OFF = 0,
	TRACK = 1,
	QUEUE = 2,
}

/**
 * 播放引擎端口。
 *
 * 只包含「播放语义」上的最小方法集 —— 移动端由 `@bbplayer/orpheus`(Media3) 实现，
 * 桌面端由 Electron 渲染进程的 `<audio>` / WebAudio 实现。
 *
 * 桌面歌词、状态栏歌词、车机、下载、APK 自更新等**平台专属能力不在此接口内**，
 * 由各端自行处理。
 */
export interface AudioPort {
	play(): Promise<void>
	pause(): Promise<void>
	seekTo(seconds: number): Promise<void>
	setPlaybackSpeed(speed: number): Promise<void>
	setRepeatMode(mode: AudioRepeatMode): Promise<void>
	setShuffleMode(enabled: boolean): Promise<void>

	getPosition(): Promise<number>
	getDuration(): Promise<number>
	getBuffered(): Promise<number>
	getIsPlaying(): Promise<boolean>
	getRepeatMode(): Promise<AudioRepeatMode>
	getShuffleMode(): Promise<boolean>

	getCurrentTrack(): Promise<AudioTrack | null>
	getQueue(): Promise<AudioTrack[]>
	getCurrentIndex(): Promise<number>

	addToEnd(
		tracks: AudioTrack[],
		startFromId?: string | null,
		clearQueue?: boolean,
	): Promise<void>
	playNext(track: AudioTrack): Promise<void>
	removeTrack(index: number): Promise<void>
	clear(): Promise<void>
	reverseRemainingQueue(): Promise<void>

	setSleepTimer(durationMs: number): void
	getSleepTimerEndTime(): number | null
	cancelSleepTimer(): void
}

// ============================================================
// 聚合容器
// ============================================================

/**
 * core 运行所需的全部平台能力。
 *
 * 端点启动时构造一次，之后 core 内部的一切都通过它取用。
 */
export interface CorePorts {
	logger: LoggerPort
	storage: StoragePort
	secureStorage: SecureStoragePort
	db: DbPort
	http: HttpPort
	/** B 站登录凭据（可选：未登录也能用公开接口） */
	bilibili?: BilibiliCredentialPort
}

// ============================================================
// 运行时注册表（让 core 内部模块也能取到端口）
// ============================================================

let registeredPorts: CorePorts | null = null

/**
 * 由各端在启动时注入一次。
 *
 * 之所以需要它：core 里有一部分模块（如数据迁移、WBI 签名缓存）历史上直接
 * import 了平台相关的 `log` / `storage`。改为端口后，这些模块不再 import
 * 平台库，而是在**调用时**从注册表取端口 —— 这样既保持 API 不变（不需要给
 * 每个函数加参数），又让 core 与平台解耦。
 */
export function registerCorePorts(ports: CorePorts): void {
	registeredPorts = ports
}

/**
 * 取当前已注册的端口。未注册时抛错，避免「静默用了假实现」。
 */
export function getCorePorts(): CorePorts {
	if (!registeredPorts) {
		throw new Error(
			'[bbplayer/core] 端口尚未注册。请在应用启动时调用 registerCorePorts()。',
		)
	}
	return registeredPorts
}

/** 是否已注册（用于可选能力探测） */
export function hasCorePorts(): boolean {
	return registeredPorts !== null
}

/** 仅测试用：重置注册状态 */
export function resetCorePorts(): void {
	registeredPorts = null
}
