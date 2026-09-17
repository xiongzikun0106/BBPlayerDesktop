/* oxlint-disable no-console -- 验证脚本，以 stdout 输出 */
/**
 * 验证 `packages/core` 的 B 站 API 客户端 + WBI 签名在**真实 Node 环境**下可用。
 *
 * 为什么需要这个：core 里的客户端是端口注入的，类型检查通过不代表能真发请求。
 * 这里用 Node 原生 `fetch` 作为 `HttpPort`、内存 Map 作为 KV，直接打真实接口。
 *
 * 覆盖：
 *  1. `/x/web-interface/view` 走通（匿名，不需要签名）
 *  2. WBI 密钥能取到、签名串形态正确
 *  3. 带 WBI 签名的 `/x/player/wbi/playurl` 被服务端接受（未被 -403 拒）
 *  4. dash / durl 阶梯解析正确
 *
 * 用法：pnpm exec tsx scripts/verify-bilibili-api.mts
 */
import process from 'node:process'

import {
	bilibiliApiClient,
	encWbi,
	getWbiEncodedParams,
	md5Hex,
	registerCorePorts,
} from '../packages/core/src/index.ts'
import type {
	BilibiliAudioStreamResponse,
	CorePorts,
} from '../packages/core/src/index.ts'

const TEST_BVID = 'BV1GJ411x7h7'

// ---------------------------------------------------------------
// Node 侧端口（最小实现）
// ---------------------------------------------------------------

const kv = new Map<string, string>()

const noopLogger = {
	debug: () => {},
	info: () => {},
	warn: (message: string) => console.log(`  [warn] ${message}`),
	error: (message: string) => console.log(`  [error] ${message}`),
	extend(): typeof noopLogger {
		return noopLogger
	},
}

const ports: CorePorts = {
	logger: noopLogger,
	storage: {
		getString: (key) => kv.get(key),
		getBoolean: (key) => {
			const value = kv.get(key)
			return value === undefined ? undefined : value === 'true'
		},
		set: (key, value) => void kv.set(key, value),
		delete: (key) => void kv.delete(key),
		contains: (key) => kv.has(key),
		clearAll: () => kv.clear(),
	},
	secureStorage: {
		getItem: async () => null,
		setItem: async () => {},
		deleteItem: async () => {},
	},
	db: {
		client: null,
		sqlite: {
			execSync: () => {},
			runSync: () => {},
			getFirstSync: () => null,
			getAllSync: () => [],
			withTransactionSync: (task) => task(),
		},
		orm: null,
	},
	// Node 原生 fetch 就是 HttpPort 的形状
	http: (input, init) =>
		fetch(String(input), {
			method: init?.method,
			headers: init?.headers,
			body: init?.body,
			signal: init?.signal,
		}),
	// 匿名：没有 cookie
	bilibili: {
		getCookie: async () => null,
		setCookie: async () => {},
	},
}

registerCorePorts(ports)

// ---------------------------------------------------------------
// 断言工具
// ---------------------------------------------------------------

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

async function main() {
	console.log('=== core B 站 API 客户端真实验证（匿名）===\n')

	// ---------------------------------------------------------------
	console.log('[1] /x/web-interface/view（无需签名）')
	const view = await bilibiliApiClient.get<{
		cid: number
		title: string
		duration: number
	}>({ endpoint: '/x/web-interface/view', params: { bvid: TEST_BVID } })

	check('view 请求成功', view.isOk(), view.isErr() ? view.error.message : '')
	const cid = view.isOk() ? view.value.cid : 0
	if (view.isOk()) {
		console.log(`      标题: ${view.value.title}`)
		console.log(`      cid: ${view.value.cid}  时长: ${view.value.duration}s`)
	}

	// ---------------------------------------------------------------
	console.log('\n[2] WBI 密钥与签名串形态')
	const wbiParams = await getWbiEncodedParams({ foo: '114', bar: '514' })
	check(
		'WBI 签名产出成功',
		wbiParams.isOk(),
		wbiParams.isErr() ? wbiParams.error.message : '',
	)
	if (wbiParams.isOk()) {
		const query = wbiParams.value
		console.log(`      签名串: ${query}`)
		check('签名串含 wts', query.includes('wts='))
		check('签名串含 w_rid（32 位 hex）', /w_rid=[0-9a-f]{32}/.test(query))
		check(
			'参数按 key 排序（bar 在 foo 之前）',
			query.indexOf('bar=') < query.indexOf('foo='),
		)
	}
	check(
		'WBI 密钥已写入 KV 缓存',
		kv.has('wbi_keys'),
		(kv.get('wbi_keys') ?? '').slice(0, 72),
	)

	// ---------------------------------------------------------------
	console.log('\n[3] 带 WBI 签名的 playurl（关键：服务端是否接受签名）')
	if (!cid) {
		check('拿到 cid 才能测 playurl', false, '上一步没拿到 cid')
	} else {
		const signed = await getWbiEncodedParams({
			bvid: TEST_BVID,
			cid,
			fnval: 4048,
			fnver: 0,
			fourk: 1,
			qlt: 30280,
		})
		check('playurl 参数签名成功', signed.isOk())

		if (signed.isOk()) {
			const stream = await bilibiliApiClient.get<BilibiliAudioStreamResponse>({
				endpoint: '/x/player/wbi/playurl',
				params: signed.value,
			})
			check(
				'带签名的 playurl 被接受（未被 -403 拒绝）',
				stream.isOk(),
				stream.isErr() ? stream.error.message : '',
			)

			if (stream.isOk()) {
				const { dash, durl } = stream.value
				const hasDashAudio = Boolean(dash?.audio?.length)
				check(
					'响应含 dash.audio',
					hasDashAudio,
					`dash.audio ${dash?.audio?.length ?? 0} 条 / durl ${durl?.length ?? 0} 条`,
				)
				if (dash?.audio?.length) {
					const track = dash.audio[0]
					console.log(`      音质 id: ${track.id}  带宽: ${track.bandwidth}`)
					console.log(`      宿主: ${new URL(track.baseUrl).host}`)
					check('baseUrl 是 http(s) 地址', /^https?:/.test(track.baseUrl))
				}
			}
		}
	}

	// ---------------------------------------------------------------
	console.log('\n[4] 签名实现一致性（用文档算法独立复算 w_rid）')
	// 用已知的 img_key/sub_key 走一遍「打乱 -> 取前 32 位 -> MD5(query+mixin)」
	// 与 encWbi 的输出比对。上一版这里用了硬编码的假 mixin key，是测试写错了。
	const imgKey = '7cd084941338484aae1ad9425b84077c'
	const subKey = '4932caff0ff746eab6f01bf08b70ac45'
	const tab = [
		46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
		33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
		61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
		36, 20, 34, 44, 52,
	]
	const independentMixinKey = tab
		.map((n) => (imgKey + subKey)[n])
		.join('')
		.slice(0, 32)

	const signed = encWbi({ a: '1', b: '2' }, imgKey, subKey)
	const queryPart = signed.slice(0, signed.indexOf('&w_rid='))
	const actualWrid = signed.match(/w_rid=([0-9a-f]{32})/)?.[1] ?? ''
	const expectedWrid = md5Hex(queryPart + independentMixinKey)

	check(
		'encWbi 含 wts 与 w_rid',
		/wts=\d+/.test(signed) && actualWrid.length === 32,
	)
	check(
		'w_rid 与独立复算一致',
		actualWrid === expectedWrid,
		`${actualWrid} vs ${expectedWrid}`,
	)
	check(
		'mixin key 长度 32',
		independentMixinKey.length === 32,
		independentMixinKey,
	)

	console.log(`\n${'='.repeat(52)}`)
	console.log(`通过 ${passed} 项，失败 ${failed} 项`)
	console.log('='.repeat(52))
	process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
	console.error('验证脚本异常:', error)
	process.exit(1)
})
