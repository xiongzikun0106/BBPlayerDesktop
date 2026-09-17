/**
 * B 站 WBI 签名。
 *
 * 部分接口（`/x/player/wbi/playurl`、`/x/web-interface/wbi/search/*` 等）要求
 * 带 `w_rid` + `wts` 签名参数，否则会返回 `-403`。
 *
 * 与移动端 `apps/mobile/src/lib/api/bilibili/wbi.ts` 的关系：逻辑相同，但
 * 缓存读写改走 core 的 `StoragePort`、日志走 `LoggerPort`，因此两端共用。
 */
import { okAsync, type ResultAsync } from 'neverthrow'

import type { BilibiliApiError } from '../../errors/thirdparty/bilibili'
import { getCorePorts } from '../../ports/index'
import { md5Hex } from '../../utils/md5'

import { bilibiliApiClient } from './client'

/** 打乱 img_key + sub_key 的字符顺序，取前 32 位作为 mixin key */
const mixinKeyEncTab = [
	46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
	33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
	26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
	20, 34, 44, 52,
]

const getMixinKey = (orig: string) =>
	mixinKeyEncTab
		.map((n) => orig[n])
		.join('')
		.slice(0, 32)

const CHR_FILTER = /[!'()*]/g

/** 给参数加上 `wts` 并按 key 排序后签名 */
export function encWbi(
	params: Record<string, string | number>,
	imgKey: string,
	subKey: string,
): string {
	const mixinKey = getMixinKey(imgKey + subKey)
	const wts = Math.round(Date.now() / 1000)

	const withWts: Record<string, string | number> = { ...params, wts }

	const query = Object.keys(withWts)
		.sort()
		.map((key) => {
			const value = String(withWts[key]).replace(CHR_FILTER, '')
			return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
		})
		.join('&')

	return `${query}&w_rid=${md5Hex(query + mixinKey)}`
}

const WBI_KEYS_STORAGE_KEY = 'wbi_keys'

interface WbiKeys {
	img_key: string
	sub_key: string
	timestamp: number
}

const isSameDayAsToday = (timestamp: number) => {
	const date = new Date(timestamp)
	if (Number.isNaN(date.getTime())) return false
	const now = new Date()
	return (
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate()
	)
}

function readCachedKeys(): WbiKeys | null {
	try {
		const { storage } = getCorePorts()
		const raw = storage.getString(WBI_KEYS_STORAGE_KEY)
		if (!raw) return null
		return JSON.parse(raw) as WbiKeys
	} catch {
		return null
	}
}

function writeCachedKeys(keys: WbiKeys) {
	try {
		const { storage } = getCorePorts()
		storage.set(WBI_KEYS_STORAGE_KEY, JSON.stringify(keys))
	} catch {
		// 缓存失败不影响本次签名（只是下次要重新拉 keys）
	}
}

/** 取 img_key / sub_key（当天内复用缓存） */
function getWbiKeys(): ResultAsync<
	{ img_key: string; sub_key: string },
	BilibiliApiError
> {
	const cached = readCachedKeys()
	if (cached && isSameDayAsToday(cached.timestamp)) {
		return okAsync({ img_key: cached.img_key, sub_key: cached.sub_key })
	}

	return bilibiliApiClient
		.get<{ wbi_img: { img_url: string; sub_url: string } }>({
			endpoint: '/x/web-interface/nav',
		})
		.map(({ wbi_img: { img_url, sub_url } }) => {
			const img_key = img_url.slice(
				img_url.lastIndexOf('/') + 1,
				img_url.lastIndexOf('.'),
			)
			const sub_key = sub_url.slice(sub_url.lastIndexOf('/') + 1)
			writeCachedKeys({ img_key, sub_key, timestamp: Date.now() })
			return { img_key, sub_key }
		})
}

/**
 * 对参数做 WBI 签名，返回可直接拼到 URL 后的查询串。
 *
 * 用法：`client.get({ endpoint, params: await getWbiEncodedParams({...}) })`
 */
export function getWbiEncodedParams(
	params: Record<string, string | number>,
): ResultAsync<string, BilibiliApiError> {
	return getWbiKeys().map(({ img_key, sub_key }) =>
		encWbi(params, img_key, sub_key),
	)
}
