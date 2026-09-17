/* oxlint-disable no-console -- 探测脚本，以 stdout 为输出 */
/**
 * 更严格地探测 B 站音频 CDN 的防盗链与 CORS 行为。
 *
 * 上一版只测了 1 个视频、1 个 baseUrl（落在 PCDN 节点 mcdn.bilivideo.cn）。
 * 这里扩大样本：
 *  - 多个视频（含大会员/普通、长短不同）
 *  - 同一视频的所有 backupUrl（可能落在不同 CDN 主线）
 *  - 分别测 baseUrl 与 backupUrl 的裸请求 / 带头请求
 *
 * 判定重点：
 *  1. 裸请求（无 Referer/UA）是否真的能 200 —— 若是，桌面端不需要代理
 *  2. 是否稳定返回 `Access-Control-Allow-Origin` —— 若是，渲染进程可直接 <audio src>
 *  3. Range 是否稳定 206
 *
 * 用法：node scripts/probe-bilibili-audio.mjs
 */
import process from 'node:process'

const DESKTOP_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'

const TEST_BVIDS = [
	'BV1GJ411x7h7', // 官方 MV，较长
	'BV1xx411c7mD', // 经典测试视频
	'BV1Q541167Qg', // 另一常见公开视频
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function getAudioUrls(bvid) {
	const viewResponse = await fetch(
		`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
		{ headers: { 'User-Agent': DESKTOP_UA, Referer: REFERER } },
	)
	const view = await viewResponse.json()
	if (view.code !== 0)
		throw new Error(`view 失败: ${view.code} ${view.message}`)

	const { cid, title } = view.data
	const playResponse = await fetch(
		`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&fnver=0&fourk=1`,
		{ headers: { 'User-Agent': DESKTOP_UA, Referer: REFERER } },
	)
	const play = await playResponse.json()
	if (play.code !== 0)
		throw new Error(`playurl 失败: ${play.code} ${play.message}`)

	const tracks = play.data?.dash?.audio ?? []
	if (tracks.length === 0) throw new Error('没有 dash.audio')

	// 取带 backupUrl 的那个（通常是最完整的）
	const track = tracks[0]
	const urls = [track.baseUrl, ...(track.backupUrl ?? [])]
	return { title, cid, quality: track.id, urls }
}

async function probe(url, headers) {
	try {
		const response = await fetch(url, { headers })
		const info = {
			status: response.status,
			acceptRanges: response.headers.get('accept-ranges'),
			contentRange: response.headers.get('content-range'),
			acao: response.headers.get('access-control-allow-origin'),
			server: response.headers.get('server'),
		}
		await response.body?.cancel()
		return info
	} catch (error) {
		return { status: 'ERR', error: String(error).slice(0, 60) }
	}
}

/** 判断 CDN 节点类型：PCDN 节点行为可能与主线不同 */
function nodeKind(host) {
	if (host.includes('mcdn.bilivideo')) return 'PCDN'
	if (host.includes('upos')) return 'upos'
	if (host.includes('akamaized')) return 'akamai'
	return 'other'
}

async function main() {
	console.log('=== B 站音频 CDN 防盗链 & CORS 严格探测 ===\n')

	const observations = []

	for (const bvid of TEST_BVIDS) {
		console.log(`\n${'─'.repeat(78)}`)
		console.log(`视频 ${bvid}`)
		try {
			const { title, urls, quality } = await getAudioUrls(bvid)
			console.log(`  标题: ${title}`)
			console.log(`  音质 id: ${quality}   可用地址 ${urls.length} 个`)

			for (const [index, url] of urls.entries()) {
				const parsed = new URL(url)
				const kind = nodeKind(parsed.host)
				const role = index === 0 ? 'baseUrl' : `backup${index}`

				console.log(`\n  [${role}] ${parsed.host}  (${kind})`)

				const bare = await probe(url, {})
				await sleep(500)
				const withHeaders = await probe(url, {
					Referer: REFERER,
					'User-Agent': DESKTOP_UA,
				})
				await sleep(500)
				const range = await probe(url, {
					Referer: REFERER,
					'User-Agent': DESKTOP_UA,
					Range: 'bytes=0-1023',
				})

				console.log(
					`      裸请求      : ${bare.status}  ACAO=${bare.acao ?? 'none'}  ranges=${bare.acceptRanges ?? '-'}`,
				)
				console.log(
					`      带头请求    : ${withHeaders.status}  ACAO=${withHeaders.acao ?? 'none'}  ranges=${withHeaders.acceptRanges ?? '-'}`,
				)
				console.log(
					`      Range 请求  : ${range.status}  content-range=${range.contentRange ?? '-'}`,
				)

				observations.push({
					bvid,
					role,
					kind,
					host: parsed.host,
					bareStatus: bare.status,
					headeredStatus: withHeaders.status,
					rangeStatus: range.status,
					acao: withHeaders.acao,
				})
				await sleep(500)
			}
		} catch (error) {
			console.log(`  ⚠ 跳过：${error.message}`)
		}
	}

	// ---------------------------------------------------------------
	console.log(`\n${'='.repeat(78)}`)
	console.log('汇总')
	console.log('='.repeat(78))

	console.log(
		`\n共探测 ${observations.length} 个音频地址（${new Set(observations.map((o) => o.kind)).size} 种节点类型）\n`,
	)
	console.log(
		`  ${'节点类型'.padEnd(10)} ${'个数'.padEnd(6)} ${'裸请求 200'.padEnd(12)} ${'带头 200'.padEnd(12)} ${'Range 206'.padEnd(12)} 带 ACAO`,
	)

	const kinds = [...new Set(observations.map((o) => o.kind))]
	for (const kind of kinds) {
		const group = observations.filter((o) => o.kind === kind)
		const bare200 = group.filter((o) => o.bareStatus === 200).length
		const headered200 = group.filter((o) => o.headeredStatus === 200).length
		const range206 = group.filter((o) => o.rangeStatus === 206).length
		const acao = group.filter((o) => Boolean(o.acao)).length
		console.log(
			`  ${kind.padEnd(10)} ${String(group.length).padEnd(6)} ${`${bare200}/${group.length}`.padEnd(12)} ${`${headered200}/${group.length}`.padEnd(12)} ${`${range206}/${group.length}`.padEnd(12)} ${acao}/${group.length}`,
		)
	}

	const allBare200 = observations.every((o) => o.bareStatus === 200)
	const allAcao = observations.every((o) => Boolean(o.acao))
	const allRange206 = observations.every((o) => o.rangeStatus === 206)
	const anyBare403 = observations.some((o) => o.bareStatus === 403)
	const anyOther = observations.filter(
		(o) => o.bareStatus !== 200 && o.bareStatus !== 403,
	)

	console.log(`\n判定：`)
	console.log(`  全部裸请求都 200        : ${allBare200 ? '是' : '否'}`)
	console.log(
		`  出现过 403              : ${anyBare403 ? '是 → 确实有防盗链' : '没有'}`,
	)
	console.log(`  全部返回 ACAO           : ${allAcao ? '是' : '否'}`)
	console.log(`  全部支持 Range 206      : ${allRange206 ? '是' : '否'}`)
	if (anyOther.length > 0) {
		console.log(
			`  其他状态: ${anyOther.map((o) => `${o.role}@${o.host}=${o.bareStatus}`).join(', ')}`,
		)
	}

	console.log(`\n对桌面端的含义：`)
	const mainlineBlocked = observations.some(
		(o) => o.kind !== 'PCDN' && o.bareStatus === 403,
	)
	const mainlineNoCors = observations.some((o) => o.kind !== 'PCDN' && !o.acao)

	if (mainlineBlocked) {
		console.log('  → 主线 CDN 检查 Referer：裸请求 403，必须注入 Referer/UA。')
		console.log('    渲染进程无法自行加这两个头，必须由主进程代发请求。')
	}
	if (mainlineNoCors) {
		console.log(
			'  → 主线 CDN 不返回 ACAO：渲染进程直接 <audio src="CDN"> 会被 CORS 拦。',
		)
	}
	if (mainlineBlocked || mainlineNoCors) {
		console.log(
			'  → 结论：必须走主进程代理（自定义协议），并把 Range 请求透传（已确认支持 206）。',
		)
		console.log('    PCDN 节点虽然放行，但节点分配不可控，不能作为依赖。')
	} else {
		console.log(
			'  → 本次样本内可直接 <audio src>，但样本有限，建议仍以代理为主路径。',
		)
	}

	return 0
}

main().then(
	(code) => process.exit(code),
	(error) => {
		console.error(`\n探测失败: ${error.message}`)
		process.exit(1)
	},
)
