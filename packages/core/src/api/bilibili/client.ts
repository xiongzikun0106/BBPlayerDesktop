/**
 * B 站 API 客户端（平台无关）。
 *
 * 与移动端 `apps/mobile/src/lib/api/bilibili/client.ts` 的关系：那份实现直接
 * `import { fetch } from 'react-native-nitro-fetch'`、并从 Zustand store 读 cookie，
 * 因此绑死在 RN 上。这里改为通过 `getCorePorts()` 取 HTTP 端口与凭据端口，
 * 从而桌面端（以及移动端）可以共用同一套请求与签名逻辑。
 */
import { errAsync, okAsync, ResultAsync } from 'neverthrow'

import { BilibiliApiError } from '../../errors/thirdparty/bilibili'
import { getCorePorts } from '../../ports/index'

/** B 站接口的统一响应外壳 */
export interface ReqResponse<T> {
	code: number
	message: string
	data: T
}

/** cookie 对象 -> `Cookie` 请求头 */
export function serializeCookieObject(
	cookieObj: Record<string, string>,
): string {
	return Object.entries(cookieObj)
		.map(([key, value]) => `${key}=${value}`)
		.join('; ')
}

const toRequestError = (error: unknown): BilibiliApiError => {
	if (error instanceof Error && error.name === 'AbortError') {
		return new BilibiliApiError({
			message: '请求被取消',
			type: 'RequestAborted',
			cause: error,
		})
	}
	return new BilibiliApiError({
		message: `请求失败: ${error instanceof Error ? error.message : String(error)}`,
		type: 'RequestFailed',
		cause: error,
	})
}

/**
 * B 站对 App / 浏览器 UA 的宽容度不同。统一用桌面浏览器 UA：
 * 实测主线 CDN 不带 UA/Referer 会 403（见 docs/DESKTOP_PLAN.md §2.3）。
 */
export const BILIBILI_USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export const BILIBILI_REFERER = 'https://www.bilibili.com/'

export interface BilibiliRequestOptions {
	method?: string
	headers?: Record<string, string>
	body?: string
	signal?: AbortSignal
}

export class BilibiliApiClient {
	private baseUrl = 'https://api.bilibili.com'

	/** 读取当前 cookie；未登录（或读取失败）返回空串 */
	private async cookieHeader(skipCookie?: boolean): Promise<string> {
		if (skipCookie) return ''
		try {
			const cookie = await getCorePorts().bilibili?.getCookie()
			return cookie ? serializeCookieObject(cookie) : ''
		} catch {
			// 凭据读取失败不应让请求整体失败，降级为匿名请求
			return ''
		}
	}

	/**
	 * 发请求并解析成 `ReqResponse<T>`。
	 *
	 * 这里刻意分成两步（拿响应 -> 解析外壳），而不是一条长 `andThen` 链：
	 * 长链会让 TS 推断退化成 `unknown`，可读性也差。
	 */
	private async requestRaw<T>(
		url: string,
		options: BilibiliRequestOptions,
		skipCookie?: boolean,
	): Promise<ReqResponse<T>> {
		const cookie = await this.cookieHeader(skipCookie)
		const { http } = getCorePorts()

		const response = await http(url, {
			method: options.method ?? 'GET',
			headers: {
				Cookie: cookie,
				'User-Agent': BILIBILI_USER_AGENT,
				Referer: BILIBILI_REFERER,
				Origin: 'https://www.bilibili.com',
				...options.headers,
			},
			body: options.body,
			signal: options.signal,
		})

		if (!response.ok) {
			throw new BilibiliApiError({
				message: `请求 bilibili API 失败: ${response.status} ${response.statusText}`,
				msgCode: response.status,
				type: 'RequestFailed',
			})
		}

		return (await response.json()) as ReqResponse<T>
	}

	/** 核心请求方法，统一剥掉响应外壳 */
	private request<T>({
		endpoint,
		options = {},
		fullUrl,
		skipCookie,
	}: {
		endpoint: string
		options?: BilibiliRequestOptions
		fullUrl?: string
		skipCookie?: boolean
	}): ResultAsync<T, BilibiliApiError> {
		const url = fullUrl ?? `${this.baseUrl}${endpoint}`

		return ResultAsync.fromPromise(
			this.requestRaw<T>(url, options, skipCookie),
			(error) =>
				error instanceof BilibiliApiError ? error : toRequestError(error),
		).andThen((data) => {
			// nav 接口在未登录时返回 code -101，但 wbi 密钥就在 data 里，
			// 必须放行，否则拿不到签名密钥
			if (endpoint === '/x/web-interface/nav') {
				return okAsync<T, BilibiliApiError>(data.data)
			}
			if (data.code !== 0) {
				return errAsync<T, BilibiliApiError>(
					new BilibiliApiError({
						message: data.message,
						msgCode: data.code,
						rawData: data.data,
						type: 'ResponseFailed',
					}),
				)
			}
			return okAsync<T, BilibiliApiError>(data.data)
		})
	}

	/** GET，`params` 既可以是对象也可以是已拼好的查询串 */
	get<T>({
		endpoint,
		params,
		fullUrl,
		skipCookie,
		signal,
	}: {
		endpoint: string
		params?: Record<string, string | number | undefined> | string
		fullUrl?: string
		skipCookie?: boolean
		signal?: AbortSignal
	}): ResultAsync<T, BilibiliApiError> {
		return this.request<T>({
			endpoint: withQuery(endpoint, params),
			options: { method: 'GET', signal },
			fullUrl,
			skipCookie,
		})
	}

	/** GET 并返回原始字节（封面等二进制资源） */
	getBuffer({
		endpoint,
		params,
		headers,
		fullUrl,
		skipCookie,
		signal,
	}: {
		endpoint: string
		params?: Record<string, string | number | undefined> | string
		headers?: Record<string, string>
		fullUrl?: string
		skipCookie?: boolean
		signal?: AbortSignal
	}): ResultAsync<ArrayBuffer, BilibiliApiError> {
		const requestUrl =
			fullUrl ?? `${this.baseUrl}${withQuery(endpoint, params)}`

		return ResultAsync.fromPromise(
			(async () => {
				const cookie = await this.cookieHeader(skipCookie)
				const { http } = getCorePorts()
				const response = await http(requestUrl, {
					method: 'GET',
					headers: {
						Cookie: cookie,
						'User-Agent': BILIBILI_USER_AGENT,
						Referer: BILIBILI_REFERER,
						Origin: 'https://www.bilibili.com',
						...headers,
					},
					signal,
				})
				if (!response.ok) {
					throw new BilibiliApiError({
						message: `请求 bilibili API 失败: ${response.status} ${response.statusText}`,
						msgCode: response.status,
						type: 'RequestFailed',
					})
				}
				return await response.arrayBuffer()
			})(),
			(error) =>
				error instanceof BilibiliApiError ? error : toRequestError(error),
		)
	}

	/** 取 CSRF token（bili_jct），未登录返回 null */
	async getCsrfToken(): Promise<string | null> {
		try {
			const cookie = await getCorePorts().bilibili?.getCookie()
			return cookie?.bili_jct ?? null
		} catch {
			return null
		}
	}

	post<T>({
		endpoint,
		data,
		headers,
		fullUrl,
		skipCookie,
	}: {
		endpoint: string
		data?: string
		headers?: Record<string, string>
		fullUrl?: string
		skipCookie?: boolean
	}): ResultAsync<T, BilibiliApiError> {
		return this.request<T>({
			endpoint,
			options: {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					...headers,
				},
				body: data,
			},
			fullUrl,
			skipCookie,
		})
	}

	/** 自动带上 csrf 的 POST（写操作必需） */
	postWithCsrf<T>({
		endpoint,
		payload = {},
	}: {
		endpoint: string
		payload?: Record<string, string | number>
	}): ResultAsync<T, BilibiliApiError> {
		return ResultAsync.fromPromise(this.getCsrfToken(), toRequestError).andThen(
			(csrfToken) => {
				if (!csrfToken) {
					return errAsync<T, BilibiliApiError>(
						new BilibiliApiError({
							message: '未找到 CSRF Token（未登录？）',
							type: 'CsrfError',
						}),
					)
				}
				const body = new URLSearchParams({
					...Object.fromEntries(
						Object.entries(payload).map(([key, value]) => [key, String(value)]),
					),
					csrf: csrfToken,
				}).toString()
				return this.post<T>({ endpoint, data: body })
			},
		)
	}
}

/** 把参数对象拼成查询串 */
export function withQuery(
	endpoint: string,
	params?: Record<string, string | number | undefined> | string,
): string {
	if (!params) return endpoint
	if (typeof params === 'string') return `${endpoint}?${params}`

	const searchParams = new URLSearchParams()
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) searchParams.append(key, String(value))
	}
	return `${endpoint}?${searchParams.toString()}`
}

export const bilibiliApiClient = new BilibiliApiClient()
