/**
 * 网易云歌词 API 客户端（平台无关）。
 *
 * 只用**公开**接口，不需要登录：
 *  - 搜索: `GET /api/search/get?s=<关键词>&type=1&limit=<n>`
 *  - 歌词: `GET /api/song/lyric?id=<songId>&lv=1&tv=1&kv=1&rv=1`
 *
 * 两个接口都必须带桌面 UA 与 `Referer: https://music.163.com/`，
 * 否则网易云会返回空壳响应（code 200 但 result / lrc 为空）。
 *
 * 与 `api/bilibili/client.ts` 一致：通过 `getCorePorts()` 取 HTTP 端口，
 * 因此移动端 / 桌面端（以及 Node 验证脚本）可以共用同一套请求逻辑。
 */
import { errAsync, okAsync, ResultAsync } from 'neverthrow'

import { NeteaseApiError } from '../../errors/thirdparty/netease'
import { getCorePorts } from '../../ports/index'
import type { LyricsCandidate } from '../../services/lyricMatcher'
import { normalizeTitle } from '../../services/lyricMatcher'

/** 桌面浏览器 UA（与 B 站客户端保持一致，便于排查） */
export const NETEASE_USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export const NETEASE_REFERER = 'https://music.163.com/'

/** 网易云接口的通用响应外壳（不同接口字段不同，只保证 code） */
export interface NeteaseResponseShell {
	code: number
	message?: string
}

/** `/api/search/get` 里的单首歌（只列用得到的字段） */
export interface NeteaseSearchSong {
	id: number
	name: string
	/** 演唱者 */
	artists?: { id?: number; name: string }[]
	/** 专辑 */
	album?: { id?: number; name: string } | null
	/** 时长（毫秒） */
	duration?: number
	/** 别名（原曲名 / 版本说明） */
	alias?: string[]
}

export interface NeteaseSearchApiResponse {
	code: number
	message?: string
	result?: {
		/** 命中数量（不是数组长度） */
		songCount?: number
		songs?: NeteaseSearchSong[]
	}
}

export interface NeteaseLyricBlock {
	version?: number
	/** LRC 文本；纯音乐 / 无歌词时可能是空串 */
	lyric: string
}

export interface NeteaseLyricApiResponse {
	code: number
	message?: string
	lrc?: NeteaseLyricBlock
	/** 翻译；可能整个字段缺失或 lyric 为空串 */
	tlyric?: NeteaseLyricBlock
	/** 罗马音；同上 */
	romalrc?: NeteaseLyricBlock
	/** 无歌词（纯音乐） */
	nolyric?: boolean
	/** 未收录 */
	uncollected?: boolean
}

/** 从网易云取到的一份歌词（SPL 解析前的原始 LRC） */
export interface NeteaseRawLyrics {
	/** 歌曲 id，便于回写缓存 */
	songId: number
	/** 原始歌词（LRC / SPL 文本） */
	lrc: string
	/** 翻译歌词，没有则为 null */
	tlyric: string | null
	/** 罗马音歌词，没有则为 null */
	romalrc: string | null
	/** 纯音乐 / 网易云明确返回无歌词 */
	isInstrumental: boolean
}

export interface NeteaseRequestOptions {
	method?: string
	headers?: Record<string, string>
	body?: string
	signal?: AbortSignal
}

/** 空串与全空白都视为「没有」 */
function orNull(value: string | undefined | null): string | null {
	if (typeof value !== 'string') return null
	return value.trim().length > 0 ? value : null
}

function toRequestError(error: unknown): NeteaseApiError {
	if (error instanceof NeteaseApiError) return error
	if (error instanceof Error && error.name === 'AbortError') {
		return new NeteaseApiError({
			message: '请求被取消',
			type: 'RequestFailed',
			cause: error,
		})
	}
	return new NeteaseApiError({
		message: `请求失败: ${error instanceof Error ? error.message : String(error)}`,
		type: 'RequestFailed',
		cause: error,
	})
}

export class NeteaseLyricsApiClient {
	private baseUrl = 'https://music.163.com'

	/**
	 * 发请求并解析 JSON。
	 *
	 * 与 B 站客户端一样刻意分成「拿响应」与「解析外壳」两步：
	 * 一条长 `andThen` 链会让 TS 的类型推断退化成 `unknown`。
	 */
	private async requestRaw(
		url: string,
		options: NeteaseRequestOptions,
	): Promise<NeteaseResponseShell> {
		const { http } = getCorePorts()

		const response = await http(url, {
			method: options.method ?? 'GET',
			headers: {
				'User-Agent': NETEASE_USER_AGENT,
				Referer: NETEASE_REFERER,
				Accept: 'application/json, text/plain, */*',
				...options.headers,
			},
			body: options.body,
			signal: options.signal,
		})

		if (!response.ok) {
			throw new NeteaseApiError({
				message: `请求网易云 API 失败: ${response.status} ${response.statusText}`,
				msgCode: response.status,
				type: 'RequestFailed',
			})
		}

		return (await response.json()) as NeteaseResponseShell
	}

	/** 统一处理「网络错误 -> 业务 code 非 200」的收口 */
	private request<T extends NeteaseResponseShell>(
		url: string,
		options: NeteaseRequestOptions = {},
	): ResultAsync<T, NeteaseApiError> {
		return ResultAsync.fromPromise(
			this.requestRaw(url, options),
			toRequestError,
		)
			.map((data) => data as T)
			.andThen((data) => {
				if (data.code !== 200) {
					return errAsync<T, NeteaseApiError>(
						new NeteaseApiError({
							message: data.message ?? `网易云接口返回 code=${data.code}`,
							msgCode: data.code,
							rawData: data,
							type: 'ResponseFailed',
						}),
					)
				}
				return okAsync<T, NeteaseApiError>(data)
			})
	}

	/**
	 * 搜索歌曲。
	 *
	 * 返回的是归一化后的候选，`title` 已经过标题清洗（去括号内容 / feat. 等），
	 * 便于直接喂给 `lyricMatcher` 打分。
	 */
	searchLyrics(
		keyword: string,
		limit = 10,
		signal?: AbortSignal,
	): ResultAsync<NeteaseSearchSong[], NeteaseApiError> {
		const trimmed = keyword.trim()
		if (!trimmed) {
			return errAsync<NeteaseSearchSong[], NeteaseApiError>(
				new NeteaseApiError({
					message: '搜索关键词为空',
					type: 'SearchResultNoMatch',
				}),
			)
		}

		const params = new URLSearchParams({
			s: trimmed,
			type: '1',
			limit: String(limit),
		})
		const url = `${this.baseUrl}/api/search/get?${params.toString()}`

		return this.request<NeteaseSearchApiResponse>(url, { signal }).map(
			(data) => data.result?.songs ?? [],
		)
	}

	/** 按歌曲 id 取歌词（含翻译 / 罗马音） */
	fetchLyricsById(
		songId: number,
		signal?: AbortSignal,
	): ResultAsync<NeteaseRawLyrics, NeteaseApiError> {
		if (!Number.isFinite(songId) || songId <= 0) {
			return errAsync<NeteaseRawLyrics, NeteaseApiError>(
				new NeteaseApiError({
					message: `非法的网易云歌曲 id: ${String(songId)}`,
					type: 'ResponseFailed',
				}),
			)
		}

		const url = `${this.baseUrl}/api/song/lyric?id=${songId}&lv=1&tv=1&kv=1&rv=1`

		return this.request<NeteaseLyricApiResponse>(url, { signal }).andThen(
			(data) => {
				const lrc = orNull(data.lrc?.lyric)

				// 主歌词为空不是「请求失败」：实测部分歌曲（版权受限 / 未被抓取）
				// 会返回 `code: 200` + `lrc: { lyric: '' }`，既不设 `nolyric`
				// 也不设 `uncollected`。当成错误会让上层直接放弃这首歌，
				// 正确做法是标记 `isInstrumental`，让上层继续试下一个候选。
				if (lrc === null) {
					return okAsync<NeteaseRawLyrics, NeteaseApiError>({
						songId,
						lrc: '',
						tlyric: null,
						romalrc: null,
						isInstrumental: true,
					})
				}

				return okAsync<NeteaseRawLyrics, NeteaseApiError>({
					songId,
					lrc,
					tlyric: orNull(data.tlyric?.lyric),
					romalrc: orNull(data.romalrc?.lyric),
					isInstrumental: false,
				})
			},
		)
	}
}

export const neteaseLyricsApiClient = new NeteaseLyricsApiClient()

/**
 * 把网易云的搜索结果转成 `lyricMatcher` 能打分的候选。
 *
 * 两个坑：网易云 `duration` 是**毫秒**，而 `LyricsCandidate.duration` 是秒；
 * 另外原曲名经常只出现在 `alias` 里（如中日双语标题），这里一并拼进标题，
 * 让归一化后的比对不至于因为语种不同而全灭。
 */
export function toLyricsCandidates(
	songs: readonly NeteaseSearchSong[],
): LyricsCandidate[] {
	return songs.map((song) => {
		const alias = (song.alias ?? []).filter((item) => item.trim().length > 0)
		return {
			remoteId: song.id,
			source: 'netease',
			title: [song.name, ...alias].join(' '),
			artist: (song.artists ?? []).map((item) => item.name).join(' / '),
			duration: song.duration ? Math.round(song.duration / 1000) : undefined,
			album: song.album?.name,
		}
	})
}

/**
 * 判断一份歌词是否等于「纯音乐」。
 *
 * 有些歌曲网易云返回 `lrc` 非空但只有 `[00:00.000]纯音乐，请欣赏` 这类占位，
 * 是否要把它当纯音乐由上层决定；这里只负责「主歌词为空」这一确定情况。
 */
export function lyricCandidatesLookLikeInstrumental(input: {
	lrc: string | null | undefined
	tlyric?: string | null | undefined
	romalrc?: string | null | undefined
}): boolean {
	const hasMain = orNull(input.lrc) !== null
	const hasAny =
		hasMain || orNull(input.tlyric) !== null || orNull(input.romalrc) !== null
	return !hasAny
}

/**
 * 由「标题 + 歌手」拼一个网易云搜索关键词。
 *
 * 网易云对「标题 空格 歌手」的召回率明显好于只搜标题，而清洗过的标题
 * （去掉 `(Live)`、`feat.` 之类）能避免把括号里的噪声带进检索。
 */
export function buildLyricsSearchKeyword(
	title: string,
	artist?: string,
): string {
	const cleanTitle = normalizeTitle(title)
	const cleanArtist = (artist ?? '').trim()
	return cleanArtist ? `${cleanTitle} ${cleanArtist}` : cleanTitle
}
