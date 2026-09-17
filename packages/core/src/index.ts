// @bbplayer/core — 平台无关的业务核心。
//
// 约束：本包不得依赖 react / react-native / expo-* / @bbplayer/{native,orpheus}。
// 该约束由 `tsconfig.json` 的 `"types": []` + `"lib": ["ES2022"]` 强制：
// 一旦引入上述依赖，`pnpm type-check` 会立刻失败。

// ---------- errors ----------
export {
	CustomError,
	DatabaseError,
	DataParsingError,
	FacadeError,
	FileSystemError,
	LrcParseError,
	LyricNotFoundError,
	ServiceError,
	ThirdPartyError,
	UIError,
} from './errors/index'
export { BilibiliApiError } from './errors/thirdparty/bilibili'
export { NeteaseApiError } from './errors/thirdparty/netease'
// 注意：errors/facade.ts 也导出一个 `FacadeError`（继承自 errors/index.ts 的同名基类），
// 为避免扁平 re-export 冲突，这里只取它的工厂函数。
export {
	createFacadeError,
	createSyncTaskAlreadyRunningError,
	type FacadeErrorType,
} from './errors/facade'
export {
	createPlayerError,
	PlayerError,
	type PlayerErrorType,
} from './errors/player'
export {
	createArtistNotFound,
	createNotImplementedError,
	createPlaylistAlreadyExists,
	createPlaylistNotFound,
	createServiceError,
	createSkinDownloadFailed,
	createSkinFetchFailed,
	createSkinInstallFailed,
	createSkinNotFound,
	createSkinTransformFailed,
	createSkinUninstallFailed,
	createSkinValidationFailed,
	createTrackNotFound,
	createTrackNotInPlaylist,
	createValidationError,
	type ServiceErrorType,
} from './errors/service'

// ---------- api ----------
export * from './api/bilibili/client'
export * from './api/bilibili/convert'
export * from './api/bilibili/garb'
export * from './api/bilibili/wbi'
export * from './api/netease/crypto'
export * from './api/netease/utils'

// ---------- utils ----------
export * from './utils/md5'

// ---------- backup ----------
export * from './backup/types'
export * from './backup/webdav-client'

// ---------- db ----------
export * from './db/schema'
export * from './db/migrations/index'

// ---------- ports（平台端口接口）----------
export * from './ports/index'

// ---------- services ----------
export * from './services/genKey'

// ---------- theme ----------
export * from './theme/schema'
export * from './theme/types'

// ---------- utils ----------
export * from './utils/playlistUrlParser'

// ---------- types（领域契约）----------
export * from './types/apis/baidu'
export * from './types/apis/bilibili'
export * from './types/apis/garb'
export * from './types/apis/kugou'
export * from './types/apis/kuwo'
export * from './types/apis/netease'
export * from './types/apis/qqmusic'
export * from './types/core/media'
export * from './types/core/playback'
export * from './types/core/scope'
export * from './types/external_playlist'
export * from './types/player/lyrics'
export * from './types/services/artist'
export * from './types/services/playlist'
export * from './types/services/track'
export * from './types/storage'
