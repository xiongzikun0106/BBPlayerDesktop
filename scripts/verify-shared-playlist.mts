/* oxlint-disable no-console -- 验证脚本，以 stdout 输出 */
/**
 * Phase 3.4 验收：共享歌单（账号 / 分享 / 订阅 / 增量同步 / 成员 / 角色）
 *
 * ## 为什么对着**本地**后端跑
 *
 * 上游的 `https://be.bbplayer.roitium.com` 是**别人正在服务的生产库**。
 * 这个脚本会注册账号、建歌单、上传曲目、改角色、删歌单 —— 拿这些动作去写
 * 生产库是**不可接受**的副作用（哪怕只是测试数据）。
 *
 * 因此本脚本只认 `BBPLAYER_API_URL`，默认 `http://127.0.0.1:8787`
 * （VPS 上的 `wrangler dev` + 本地 Postgres，通过 SSH 隧道映射到本机）。
 * 没有隧道时脚本**直接失败**，而不是悄悄回退到生产地址。
 *
 * ## 「两台设备」怎么模拟
 *
 * 桌面端一个数据目录 = 一台设备。两个用户在同一台设备上不是真实场景
 * （`share_id` 在本地是唯一的），所以脚本用**两个子进程 + 两个数据目录**
 * 分别扮演「设备 A（分享者 / owner）」和「设备 B（订阅者）」，
 * 每次调用重新加载模块 —— 与真实重启应用等价。
 *
 * 用法：
 *   pnpm exec tsx scripts/verify-shared-playlist.mts
 *   需要先建立隧道：ssh -N -L 8787:127.0.0.1:8787 root@<vps>
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')
const BASE_URL = process.env.BBPLAYER_API_URL ?? 'http://127.0.0.1:8787'

const RUN_ID = Date.now().toString(36)
const DIR_A = path.join(os.tmpdir(), `bbplayer-share-A-${RUN_ID}`)
const DIR_B = path.join(os.tmpdir(), `bbplayer-share-B-${RUN_ID}`)
fs.mkdirSync(DIR_A, { recursive: true })
fs.mkdirSync(DIR_B, { recursive: true })

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

/**
 * 在一台「设备」上跑一段 async 脚本。
 *
 * 脚本以 `const { ... } = require(...)` 取模块，最后
 * `console.log('__RESULT__' + JSON.stringify(...))`。
 *
 * ⚠️ 必须**包一层 async IIFE**：`node -e` 里同时出现 `require` 与顶层 `await`
 * 时 Node 无法判定模块格式，直接抛 `ERR_AMBIGUOUS_MODULE_SYNTAX`。
 */
function runOn(dataDir: string, script: string): any {
	const wrapped = `(async () => {\n${script}\n})().catch((error) => {\n\tconsole.error(error)\n\tprocess.exit(1)\n})`
	const output = execFileSync(process.execPath, ['-e', wrapped], {
		cwd: DESKTOP,
		encoding: 'utf8',
		env: {
			...process.env,
			BBPLAYER_DATA_DIR: dataDir,
			BBPLAYER_API_URL: BASE_URL,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 120_000,
	})
	const marker = output.lastIndexOf('__RESULT__')
	if (marker === -1) throw new Error(`子进程未返回结果:\n${output}`)
	return JSON.parse(output.slice(marker + '__RESULT__'.length).trim())
}

const onA = (script: string) => runOn(DIR_A, script)
const onB = (script: string) => runOn(DIR_B, script)

/** 每台设备上重复出现的前置：建库 + 构造门面 */
const PRELUDE = `
	const path = require('node:path')
	const db = require('./src/db.cjs')
	const { createAccountModule } = require('./src/bbplayer-account.cjs')
	const { createSharedPlaylistModule } = require('./src/shared-playlist.cjs')
	db.runMigrations()
	const account = createAccountModule({
		file: path.join(process.env.BBPLAYER_DATA_DIR, 'bbplayer-account.json'),
	})
	const shared = createSharedPlaylistModule({ account })
`

console.log('=== Phase 3.4 验收：共享歌单 ===\n')
console.log(`后端：${BASE_URL}`)
console.log(`设备 A：${DIR_A}`)
console.log(`设备 B：${DIR_B}\n`)

// ===============================================================
// 0. 后端可达性 —— 明确失败，绝不静默回退到生产
// ===============================================================

console.log('0. 后端可达性\n')

let reachable = true
try {
	const response = await fetch(`${BASE_URL}/health`)
	reachable = response.ok
	check(
		'本机后端可访问（隧道已建立）',
		response.ok,
		`${BASE_URL}/health → ${response.status}`,
	)
} catch (error) {
	reachable = false
	check('本机后端可访问（隧道已建立）', false, String(error))
}

if (!reachable) {
	console.log(
		'\n后端不可达，终止。请先建立隧道：\n  ssh -i <key> -N -L 8787:127.0.0.1:8787 root@<vps>\n',
	)
	process.exit(1)
}

// ===============================================================
// 1. 纯函数（离线）
// ===============================================================

console.log('\n1. 纯函数（离线）\n')

const pure = onA(`
	const { parseShareInput, buildShareLink, bvidFromUniqueKey } = require('./src/shared-playlist.cjs')
	const UUID = '2f1c9a44-1b2e-4f3a-9c5d-6e7f8a9b0c1d'
	console.log('__RESULT__' + JSON.stringify({
		bare: parseShareInput(UUID),
		upper: parseShareInput(UUID.toUpperCase()),
		query: parseShareInput('https://bbplayer.roitium.com/share/playlist?shareId=' + UUID),
		withInvite: parseShareInput('https://bbplayer.roitium.com/share/playlist?shareId=' + UUID + '&inviteCode=BBP-ABCDEFGHJKLM'),
		pathForm: parseShareInput('https://bbplayer.roitium.com/share/playlist/' + UUID),
		inText: parseShareInput('分享歌单 https://bbplayer.roitium.com/share/playlist?shareId=' + UUID + ' 快来听'),
		empty: parseShareInput(''),
		garbage: parseShareInput('not-a-link'),
		nullish: parseShareInput(null),
		link: buildShareLink(UUID, null),
		linkWithCode: buildShareLink(UUID, 'BBP-ABCDEFGHJKLM'),
		bvid: [
			bvidFromUniqueKey('bilibili::BV1xx411c7mD'),
			bvidFromUniqueKey('bilibili::BV1xx411c7mD::12345'),
			bvidFromUniqueKey('nope'),
		],
	}))
`)

check(
	'裸 uuid 直接作为 shareId',
	pure.bare.shareId === '2f1c9a44-1b2e-4f3a-9c5d-6e7f8a9b0c1d',
	pure.bare.shareId,
)
check(
	'大写 uuid 被规范化成小写',
	pure.upper.shareId === '2f1c9a44-1b2e-4f3a-9c5d-6e7f8a9b0c1d',
)
check(
	'官方链接的 query 解析出 shareId',
	pure.query.shareId === '2f1c9a44-1b2e-4f3a-9c5d-6e7f8a9b0c1d',
)
check(
	'链接里的邀请码被带出',
	pure.withInvite.inviteCode === 'BBP-ABCDEFGHJKLM',
	String(pure.withInvite.inviteCode),
)
check(
	'路径形式的 uuid 也能解析',
	pure.pathForm.shareId === '2f1c9a44-1b2e-4f3a-9c5d-6e7f8a9b0c1d',
)
check(
	'分享文案里夹着的链接能解析',
	pure.inText.shareId === '2f1c9a44-1b2e-4f3a-9c5d-6e7f8a9b0c1d',
)
check(
	'空串返回可读的错误',
	pure.empty.shareId === null && Boolean(pure.empty.error),
	pure.empty.error,
)
check(
	'认不出的文本返回可读的错误',
	pure.garbage.shareId === null && Boolean(pure.garbage.error),
	pure.garbage.error,
)
check('null 不抛异常', pure.nullish.shareId === null)
check(
	'生成的链接与移动端同站点同参数名',
	pure.link ===
		`https://bbplayer.roitium.com/share/playlist?shareId=2f1c9a44-1b2e-4f3a-9c5d-6e7f8a9b0c1d`,
	pure.link,
)
check(
	'带邀请码的链接能再被自己解析回来（往返一致）',
	pure.linkWithCode.includes('inviteCode=BBP-ABCDEFGHJKLM'),
	pure.linkWithCode,
)
check(
	'多 P 的 unique_key 取出的 bvid 正确（cid 不影响）',
	pure.bvid[0] === 'BV1xx411c7mD' &&
		pure.bvid[1] === 'BV1xx411c7mD' &&
		pure.bvid[2] === null,
	JSON.stringify(pure.bvid),
)

// ===============================================================
// 2. 账号
// ===============================================================

console.log('\n2. BBPlayer 账号（注册 / 登录 / me / 拒绝路径）\n')

const userA = `sharea${RUN_ID}`
const userB = `shareb${RUN_ID}`
const PASS = 'bbplayer-test-pass-2024'

const regA = onA(`
	${PRELUDE}
	const r = await account.register({ username: '${userA}', password: '${PASS}', name: '设备A用户' })
	console.log('__RESULT__' + JSON.stringify({ account: r.account, encrypted: r.encrypted, status: shared.accountStatus() }))
`)

check(
	'注册成功并返回账号',
	regA.account?.username === userA,
	JSON.stringify(regA.account),
)
check('注册后即处于登录态', regA.status.loggedIn === true)
check(
	'无密钥环时如实标记未加密（不静默降级）',
	regA.encrypted === false,
	String(regA.encrypted),
)

const meA = onA(`
	${PRELUDE}
	const me = await shared.me()
	console.log('__RESULT__' + JSON.stringify({ me, status: shared.accountStatus() }))
`)
check('重启进程后登录态从磁盘恢复（令牌持久化）', meA.status.loggedIn === true)
check(
	'`/auth/me` 返回同一个账号',
	meA.me?.username === userA,
	JSON.stringify(meA.me),
)

const wrongPassword = onA(`
	${PRELUDE}
	let code = null, message = null
	try { await account.login({ username: '${userA}', password: 'wrong-password-123' }) }
	catch (e) { code = e.code; message = e.message }
	console.log('__RESULT__' + JSON.stringify({ code, message }))
`)
check(
	'错误密码被拒绝且给出可读提示',
	wrongPassword.code === 'invalid_credentials',
	String(wrongPassword.message),
)

const duplicate = onA(`
	${PRELUDE}
	let code = null
	try { await account.register({ username: '${userA}', password: '${PASS}' }) }
	catch (e) { code = e.code }
	console.log('__RESULT__' + JSON.stringify({ code }))
`)
check(
	'重复用户名被拒绝',
	duplicate.code === 'username_already_exists',
	String(duplicate.code),
)

const localValidation = onA(`
	${PRELUDE}
	const results = {}
	for (const [name, payload] of Object.entries({
		shortUser: { username: 'ab', password: 'longenough123' },
		shortPass: { username: 'longenoughname', password: 'short' },
	})) {
		try { await account.register(payload); results[name] = 'NO_ERROR' }
		catch (e) { results[name] = e.code + '|' + e.message }
	}
	console.log('__RESULT__' + JSON.stringify(results))
`)
check(
	'用户名 <3 位在**发请求前**就被本地挡下（省一次往返）',
	localValidation.shortUser.startsWith('invalid_body'),
	localValidation.shortUser,
)
check(
	'密码 <8 位在**发请求前**就被本地挡下',
	localValidation.shortPass.startsWith('invalid_body'),
	localValidation.shortPass,
)

const regB = onB(`
	${PRELUDE}
	const r = await account.register({ username: '${userB}', password: '${PASS}', name: '设备B用户' })
	console.log('__RESULT__' + JSON.stringify({ accountId: r.account.id, username: r.account.username }))
`)
check('设备 B 注册了另一个账号', regB.username === userB, regB.accountId)

// ===============================================================
// 3. 分享（本地 → 远端）
// ===============================================================

console.log('\n3. 分享本地歌单\n')

/** 设备 A 建一个 3 首曲目的本地歌单 */
const setupA = onA(`
	${PRELUDE}
	const playlist = db.createPlaylist({ title: '共享测试歌单', type: 'local' })
	const trackIds = []
	for (const [bvid, title] of [['BV1shareA', '第一首'], ['BV1shareB', '第二首'], ['BV1shareC', '第三首']]) {
		const t = db.upsertTrack({
			uniqueKey: 'bilibili::' + bvid,
			title,
			artistName: '共享测试 UP',
			artistRemoteId: '8047632',
			coverUrl: null,
			duration: 200,
			bvid,
			cid: 111,
		})
		db.addTrackToPlaylist(playlist.id, t.id)
		trackIds.push(t.id)
	}
	// 一首没有 bvid 的曲目：分享时应当被跳过并**报出条数**，而不是静默消失
	// （直接 INSERT：db.upsertTrack 只处理 B 站曲目，它要求有 bvid）
	const { sqlite } = require('./src/ports.cjs')
	sqlite.runSync(
		"INSERT INTO tracks (unique_key, title, source, created_at, updated_at) VALUES (?, ?, 'local', ?, ?)",
		['local::orphan', '没有 bvid 的曲目', Date.now(), Date.now()],
	)
	const orphanId = sqlite.getFirstSync("SELECT id FROM tracks WHERE unique_key = 'local::orphan'").id
	db.addTrackToPlaylist(playlist.id, orphanId)
	console.log('__RESULT__' + JSON.stringify({ playlistId: playlist.id, trackIds }))
`)

const sharedInfo = onA(`
	${PRELUDE}
	const r = await shared.sharePlaylist(${setupA.playlistId})
	console.log('__RESULT__' + JSON.stringify({ r, list: shared.listSharedPlaylists() }))
`)

check(
	'分享返回远端 shareId（uuid 形状）',
	/^[0-9a-f-]{36}$/.test(sharedInfo.r.shareId),
	sharedInfo.r.shareId,
)
check(
	'上传了 3 首带 bvid 的曲目',
	sharedInfo.r.uploaded === 3,
	String(sharedInfo.r.uploaded),
)
check(
	'没有 bvid 的曲目被跳过，并**如实报出条数**（不静默）',
	sharedInfo.r.skipped === 1,
	String(sharedInfo.r.skipped),
)
check(
	'本地记下角色 owner',
	sharedInfo.list[0]?.shareRole === 'owner',
	String(sharedInfo.list[0]?.shareRole),
)
check(
	'同步游标被设为远端 updatedAt（不是 0）',
	Number(sharedInfo.list[0]?.lastShareSyncAt) > 0,
	String(sharedInfo.list[0]?.lastShareSyncAt),
)
check('owner 可写', sharedInfo.list[0]?.canWrite === true)

const reshare = onA(`
	${PRELUDE}
	const r = await shared.sharePlaylist(${setupA.playlistId})
	const count = require('./src/ports.cjs').sqlite.getFirstSync('SELECT COUNT(*) AS n FROM playlists').n
	console.log('__RESULT__' + JSON.stringify({ r, count }))
`)
check(
	'重复分享是幂等的（不新建远端歌单）',
	reshare.r.alreadyShared === true && reshare.count === 1,
	`本地歌单数=${reshare.count}`,
)

// ===============================================================
// 4. 公开预览（**不需要登录**）
// ===============================================================

console.log('\n4. 公开预览（无需登录）\n')

const shareId = sharedInfo.r.shareId

// 设备 B 先退出登录，证明预览确实不依赖登录态
const previewAnon = onB(`
	${PRELUDE}
	await shared.logout()
	const p = await shared.preview('${shareId}')
	console.log('__RESULT__' + JSON.stringify({ p, loggedIn: shared.accountStatus().loggedIn }))
`)

check('预览时确实处于未登录状态', previewAnon.loggedIn === false)
check(
	'未登录也能预览共享歌单',
	previewAnon.p.title === '共享测试歌单',
	String(previewAnon.p.title),
)
check(
	'`track_count` 被转成**数字**（Postgres 的 count(*) 回来是字符串）',
	previewAnon.p.trackCount === 3 &&
		typeof previewAnon.p.trackCount === 'number',
	`${JSON.stringify(previewAnon.p.trackCount)} (${typeof previewAnon.p.trackCount})`,
)
check(
	'预览带出 owner 信息',
	previewAnon.p.owner?.name === '设备A用户',
	JSON.stringify(previewAnon.p.owner),
)
check(
	'预览的曲目按「越大越靠前」的顺序返回',
	previewAnon.p.tracks.length === 3,
	`${previewAnon.p.tracks.length} 首`,
)
check(
	'预览曲目带 sort_key（两端顺序约定的载体）',
	typeof previewAnon.p.tracks[0]?.sortKey === 'string' &&
		previewAnon.p.tracks[0].sortKey.length > 0,
	String(previewAnon.p.tracks[0]?.sortKey),
)

const previewFromLink = onB(`
	${PRELUDE}
	const p = await shared.preview('https://bbplayer.roitium.com/share/playlist?shareId=${shareId}')
	console.log('__RESULT__' + JSON.stringify({ title: p.title, shareId: p.shareId }))
`)
check(
	'从分享链接也能预览',
	previewFromLink.shareId === shareId,
	previewFromLink.title,
)

const previewMissing = onB(`
	${PRELUDE}
	let code = null, status = null
	try { await shared.preview('00000000-0000-4000-8000-000000000000') }
	catch (e) { code = e.code; status = e.status }
	console.log('__RESULT__' + JSON.stringify({ code, status }))
`)
check(
	'不存在的歌单给出 404 而不是静默成功',
	previewMissing.status === 404,
	`status=${previewMissing.status} code=${previewMissing.code}`,
)

// ===============================================================
// 5. 订阅（远端 → 本地）
// ===============================================================

console.log('\n5. 订阅与全量落库\n')

const subscribeB = onB(`
	${PRELUDE}
	await account.login({ username: '${userB}', password: '${PASS}' })
	const r = await shared.subscribe('${shareId}')
	const tracks = db.getPlaylistTracks(r.localPlaylistId)
	const playlist = db.getPlaylist(r.localPlaylistId)
	console.log('__RESULT__' + JSON.stringify({
		r,
		titles: tracks.map((t) => t.title),
		itemCount: playlist.item_count,
		playlistTitle: playlist.title,
		shareRole: playlist.share_role,
		cursor: playlist.last_share_sync_at,
	}))
`)

check(
	'订阅成功并落到本地歌单',
	subscribeB.r.localPlaylistId > 0,
	String(subscribeB.r.localPlaylistId),
)
check(
	'订阅者角色是 subscriber',
	subscribeB.r.role === 'subscriber',
	String(subscribeB.r.role),
)
check(
	'全量拉取把 3 首曲目都落了库，且保持顺序',
	JSON.stringify(subscribeB.titles) ===
		JSON.stringify(['第一首', '第二首', '第三首']),
	JSON.stringify(subscribeB.titles),
)
check(
	'元数据（标题）从 `GET /changes` 补全，覆盖了占位标题',
	subscribeB.playlistTitle === '共享测试歌单',
	String(subscribeB.playlistTitle),
)
check(
	'`item_count` 被重算成真实条数（不是 0）',
	subscribeB.itemCount === 3,
	String(subscribeB.itemCount),
)
check(
	'同步游标写的是服务端时间（> 0）',
	Number(subscribeB.cursor) > 0,
	String(subscribeB.cursor),
)

const duplicateSubscribe = onB(`
	${PRELUDE}
	const r = await shared.subscribe('${shareId}')
	const count = require('./src/ports.cjs').sqlite.getFirstSync(
		'SELECT COUNT(*) AS n FROM playlists WHERE share_id IS NOT NULL'
	).n
	console.log('__RESULT__' + JSON.stringify({ r, count }))
`)
check(
	'重复订阅不会建出第二个本地歌单',
	duplicateSubscribe.count === 1 &&
		duplicateSubscribe.r.alreadySubscribed === true,
	`本地共享歌单数=${duplicateSubscribe.count}`,
)

const readonlyQueue = onB(`
	${PRELUDE}
	const result = shared.queueLocalChange(${subscribeB.r.localPlaylistId}, 'add_tracks', { trackIds: [1] })
	const pending = shared.pendingCount(${subscribeB.r.localPlaylistId})
	console.log('__RESULT__' + JSON.stringify({ result, pending }))
`)
check(
	'subscriber 的本地改动**不入队**（只读角色）',
	readonlyQueue.result.queued === false &&
		readonlyQueue.result.reason === 'readonly',
	JSON.stringify(readonlyQueue.result),
)

// ===============================================================
// 6. owner 侧改动 → outbox → 推送 → 订阅者拉到
// ===============================================================

console.log('\n6. 增量同步（owner 改动 → 订阅者拉到）\n')

const ownerAdd = onA(`
	${PRELUDE}
	const t = db.upsertTrack({
		uniqueKey: 'bilibili::BV1shareD',
		title: '第四首',
		artistName: '共享测试 UP',
		artistRemoteId: '8047632',
		coverUrl: null,
		duration: 200,
		bvid: 'BV1shareD',
		cid: 111,
	})
	db.addTrackToPlaylist(${setupA.playlistId}, t.id)
	const queued = shared.queueLocalChange(${setupA.playlistId}, 'add_tracks', { trackIds: [t.id] })
	// 删掉「第二首」，验证删除也走同一条链路
	const second = db.getPlaylistTracks(${setupA.playlistId}).find((x) => x.title === '第二首')
	db.removeTrackFromPlaylist(${setupA.playlistId}, second.id)
	shared.queueLocalChange(${setupA.playlistId}, 'remove_tracks', { removedTrackIds: [second.id] })
	const sync = await shared.syncPlaylist(${setupA.playlistId})
	console.log('__RESULT__' + JSON.stringify({ queued, sync, pending: shared.pendingCount(${setupA.playlistId}) }))
`)

check(
	'owner 的改动被入队',
	ownerAdd.queued.queued === true,
	JSON.stringify(ownerAdd.queued),
)
check(
	'推送把 upsert 与 remove 都发出去了',
	ownerAdd.sync.pushed >= 2 && ownerAdd.sync.failed === 0,
	JSON.stringify(ownerAdd.sync),
)
check(
	'推送成功后 outbox 清空',
	ownerAdd.pending === 0,
	String(ownerAdd.pending),
)

const pullB = onB(`
	${PRELUDE}
	const r = await shared.syncPlaylist(${subscribeB.r.localPlaylistId})
	const tracks = db.getPlaylistTracks(${subscribeB.r.localPlaylistId})
	const playlist = db.getPlaylist(${subscribeB.r.localPlaylistId})
	console.log('__RESULT__' + JSON.stringify({
		r,
		titles: tracks.map((t) => t.title),
		itemCount: playlist.item_count,
	}))
`)

check(
	'订阅者拉到新增与删除（第二首没了、第四首在）',
	JSON.stringify(pullB.titles) ===
		JSON.stringify(['第一首', '第三首', '第四首']),
	JSON.stringify(pullB.titles),
)
check(
	'订阅者的 `item_count` 跟着重算',
	pullB.itemCount === 3,
	String(pullB.itemCount),
)

const noopSync = onB(`
	${PRELUDE}
	const r = await shared.syncPlaylist(${subscribeB.r.localPlaylistId})
	const tracks = db.getPlaylistTracks(${subscribeB.r.localPlaylistId})
	const playlist = db.getPlaylist(${subscribeB.r.localPlaylistId})
	console.log('__RESULT__' + JSON.stringify({
		r,
		titles: tracks.map((t) => t.title),
		count: tracks.length,
		itemCount: playlist.item_count,
	}))
`)

// ⚠️ 这里**刻意不断言 `applied === 0`**。
//
// 服务的 LWW 用**客户端**时间戳（`operation_at` 直接写成行的 `updated_at`），
// 而增量游标是**服务端**时间。两个时钟一旦有偏差，刚推上去的行会在
// 「偏差时长」内持续满足 `updated_at > since`，于是被重复拉回。
// 本机实测这台 Windows 比 VPS 快约 10 秒，所以重复是**必然发生**的。
//
// 这是协议的固有性质（移动端同样如此），客户端不该用一个更激进的游标去
// 掩盖它 —— 那会把「时钟偏差窗口内别的设备提交的改动」永久漏掉。
// 因此这里断言的是协议真正承诺的东西：**重放是幂等的**。
check(
	'重复同步不产生重复行、不改变顺序（重放幂等 —— 协议的真正承诺）',
	noopSync.count === 3 &&
		JSON.stringify(noopSync.titles) ===
			JSON.stringify(['第一首', '第三首', '第四首']),
	`${noopSync.count} 行：${JSON.stringify(noopSync.titles)}`,
)
check(
	'重复同步后 `item_count` 仍然一致（重算而不是累加）',
	noopSync.itemCount === noopSync.count,
	`item_count=${noopSync.itemCount}, 实际=${noopSync.count}`,
)

// ===============================================================
// 7. 邀请码与角色
// ===============================================================

console.log('\n7. 邀请码与角色升级\n')

const invite = onA(`
	${PRELUDE}
	const info = await shared.getInviteCode(${setupA.playlistId})
	const rotated = await shared.rotateInviteCode(${setupA.playlistId})
	const after = await shared.getInviteCode(${setupA.playlistId})
	console.log('__RESULT__' + JSON.stringify({ info, rotated, after }))
`)

// `GET /:id/invite` 返回 `null` 是**合法**的：后端只在 `rotate` 时生成邀请码，
// 建共享歌单时不会自动生成。UI 必须能显示「还没有邀请码，点这里生成」，
// 而不是把 null 当错误。
check(
	'新共享的歌单还没有邀请码，接口返回 null 而不是报错',
	invite.info.inviteCode === null,
	String(invite.info.inviteCode),
)
check(
	'轮换后生成了邀请码（`BBP-` + 12 位）',
	/^BBP-[A-Z2-9]{12}$/.test(invite.rotated.inviteCode ?? ''),
	String(invite.rotated.inviteCode),
)
check(
	'再取一次能读回同一个邀请码（已持久化）',
	invite.after.inviteCode === invite.rotated.inviteCode,
	`${invite.rotated.inviteCode} → ${invite.after.inviteCode}`,
)
check(
	'邀请码链接里带上了邀请码',
	(invite.after.shareLink ?? '').includes(
		`inviteCode=${invite.after.inviteCode}`,
	),
	invite.after.shareLink,
)

const upgradeB = onB(`
	${PRELUDE}
	// 用**新**邀请码补一次 subscribe：本地已有副本，但角色应当被升成 editor
	const r = await shared.subscribe('${shareId}', { inviteCode: '${invite.rotated.inviteCode}' })
	const playlist = db.getPlaylist(${subscribeB.r.localPlaylistId})
	console.log('__RESULT__' + JSON.stringify({ r, shareRole: playlist.share_role }))
`)

check(
	'带着邀请码重新订阅把 subscriber 升成 editor',
	upgradeB.r.role === 'editor' && upgradeB.r.upgraded === true,
	JSON.stringify(upgradeB.r),
)
check(
	'本地角色同步更新为 editor（移动端在这条路径上会提前 return，桌面端不）',
	upgradeB.shareRole === 'editor',
	String(upgradeB.shareRole),
)

const editorWrite = onB(`
	${PRELUDE}
	const t = db.upsertTrack({
		uniqueKey: 'bilibili::BV1shareE',
		title: '第五首（编辑者加的）',
		artistName: '共享测试 UP',
		artistRemoteId: '8047632',
		coverUrl: null,
		duration: 200,
		bvid: 'BV1shareE',
		cid: 111,
	})
	db.addTrackToPlaylist(${subscribeB.r.localPlaylistId}, t.id)
	const queued = shared.queueLocalChange(${subscribeB.r.localPlaylistId}, 'add_tracks', { trackIds: [t.id] })
	const sync = await shared.syncPlaylist(${subscribeB.r.localPlaylistId})
	console.log('__RESULT__' + JSON.stringify({ queued, sync }))
`)

check(
	'升级成 editor 后本地改动会入队',
	editorWrite.queued.queued === true,
	JSON.stringify(editorWrite.queued),
)
check(
	'editor 的改动被服务端接受（不是 403）',
	editorWrite.sync.pushed >= 1 && editorWrite.sync.failed === 0,
	JSON.stringify(editorWrite.sync),
)

const ownerSeesEditor = onA(`
	${PRELUDE}
	const sync = await shared.syncPlaylist(${setupA.playlistId})
	const tracks = db.getPlaylistTracks(${setupA.playlistId})
	console.log('__RESULT__' + JSON.stringify({ sync, titles: tracks.map((t) => t.title) }))
`)
check(
	'owner 拉到 editor 加的曲目',
	ownerSeesEditor.titles.includes('第五首（编辑者加的）'),
	JSON.stringify(ownerSeesEditor.titles),
)

// ===============================================================
// 8. 成员列表与权限
// ===============================================================

console.log('\n8. 成员列表\n')

const membersOwner = onA(`
	${PRELUDE}
	const r = await shared.listMembers(${setupA.playlistId})
	console.log('__RESULT__' + JSON.stringify({ r }))
`)
check(
	'owner 能看到全部成员（含 subscriber）',
	membersOwner.r.from === 'api' && membersOwner.r.canSeeSubscribers === true,
	JSON.stringify(membersOwner.r.members.map((m: any) => `${m.name}:${m.role}`)),
)
check(
	'成员里有 owner 自己',
	membersOwner.r.members.some((m: any) => m.role === 'owner'),
)

const membersEditor = onB(`
	${PRELUDE}
	const r = await shared.listMembers(${subscribeB.r.localPlaylistId})
	console.log('__RESULT__' + JSON.stringify({ r }))
`)
check(
	'editor 也能看到成员列表',
	membersEditor.r.from === 'api',
	JSON.stringify(membersEditor.r),
)

const membersSubscriber = (() => {
	// subscriber 的 403 回落分支需要一个**真正是订阅者**的账号：
	// 权限由服务端按 JWT 里的 `sub` 判定，改本地的 `share_role` 骗不过它。
	const DIR_E = path.join(os.tmpdir(), `bbplayer-share-E-${RUN_ID}`)
	fs.mkdirSync(DIR_E, { recursive: true })
	const userC = `sharec${RUN_ID}`

	runOn(
		DIR_E,
		`
	${PRELUDE}
	await account.register({ username: '${userC}', password: '${PASS}', name: '设备C用户' })
	console.log('__RESULT__' + JSON.stringify({ ok: true }))
`,
	)

	return runOn(
		DIR_E,
		`
	${PRELUDE}
	await account.login({ username: '${userC}', password: '${PASS}' })
	// 不带邀请码订阅 → subscriber
	const sub = await shared.subscribe('${shareId}')
	const api = await shared.listMembers(sub.localPlaylistId)
	console.log('__RESULT__' + JSON.stringify({ sub, r: api }))
`,
	)
})()

check(
	'没有邀请码的用户订阅后是 subscriber（不是 editor）',
	membersSubscriber.sub.role === 'subscriber',
	String(membersSubscriber.sub.role),
)
check(
	'subscriber 拿不到成员接口，回落到缓存且**如实标记**来自缓存',
	membersSubscriber.r.from === 'cache' &&
		membersSubscriber.r.canSeeSubscribers === false,
	`from=${membersSubscriber.r.from}, canSeeSubscribers=${membersSubscriber.r.canSeeSubscribers}`,
)
check(
	'回落分支不抛异常，且缓存里有 owner + editor（拉取时带回来的那份）',
	Array.isArray(membersSubscriber.r.members) &&
		membersSubscriber.r.members.length === 2,
	JSON.stringify(
		membersSubscriber.r.members.map((m: any) => `${m.name}:${m.role}`),
	),
)

// ===============================================================
// 9. 云端恢复
// ===============================================================

console.log('\n9. 换设备恢复（/me/playlists）\n')

const DIR_C = path.join(os.tmpdir(), `bbplayer-share-C-${RUN_ID}`)
fs.mkdirSync(DIR_C, { recursive: true })

const restoreC = runOn(
	DIR_C,
	`
	${PRELUDE}
	await account.login({ username: '${userA}', password: '${PASS}' })
	const r = await shared.restoreFromCloud()
	const tracks = r.restored[0] ? db.getPlaylistTracks(r.restored[0].id) : []
	console.log('__RESULT__' + JSON.stringify({
		r,
		remoteCount: r.remoteCount,
		titles: tracks.map((t) => t.title),
		role: r.restored[0] ? db.getPlaylist(r.restored[0].id).share_role : null,
	}))
`,
)

check(
	'在全新设备上登录同一账号能恢复云端歌单',
	restoreC.r.restored.length === 1,
	JSON.stringify(restoreC.r),
)
check('恢复后角色是 owner', restoreC.role === 'owner', String(restoreC.role))
check(
	'恢复的内容与云端一致',
	restoreC.titles.includes('第五首（编辑者加的）') &&
		restoreC.titles.length === 4,
	JSON.stringify(restoreC.titles),
)

const restoreAgain = runOn(
	DIR_C,
	`
	${PRELUDE}
	const r = await shared.restoreFromCloud()
	console.log('__RESULT__' + JSON.stringify({ restoredCount: r.restored.length }))
`,
)
check(
	'再次恢复不会重复创建',
	restoreAgain.restoredCount === 0,
	String(restoreAgain.restoredCount),
)

// ===============================================================
// 10. 取消共享 / 离开 / 删除
// ===============================================================

console.log('\n10. 取消共享\n')

const leaveB = onB(`
	${PRELUDE}
	const r = await shared.unsharePlaylist(${subscribeB.r.localPlaylistId})
	const playlist = db.getPlaylist(${subscribeB.r.localPlaylistId})
	console.log('__RESULT__' + JSON.stringify({ r, shareId: playlist.share_id, role: playlist.share_role }))
`)
check(
	'editor 离开共享成功',
	leaveB.r.unshared === true,
	JSON.stringify(leaveB.r),
)
check(
	'本地共享标记被清掉（歌单本身保留）',
	leaveB.shareId === null && leaveB.role === null,
	`shareId=${leaveB.shareId}`,
)

const stillAlive = onA(`
	${PRELUDE}
	const p = await shared.preview('${shareId}')
	console.log('__RESULT__' + JSON.stringify({ title: p.title, trackCount: p.trackCount }))
`)
check(
	'协作者离开后远端歌单仍然存在（不是把整单删掉）',
	stillAlive.trackCount === 4,
	String(stillAlive.trackCount),
)

const deleteA = onA(`
	${PRELUDE}
	const r = await shared.unsharePlaylist(${setupA.playlistId})
	console.log('__RESULT__' + JSON.stringify({ r }))
`)
check(
	'owner 取消共享成功',
	deleteA.r.unshared === true,
	JSON.stringify(deleteA.r),
)

const afterDelete = onA(`
	${PRELUDE}
	let status = null
	try { await shared.preview('${shareId}') } catch (e) { status = e.status }
	console.log('__RESULT__' + JSON.stringify({ status }))
`)
check(
	'owner 删除后远端歌单返回 404（软删生效）',
	afterDelete.status === 404,
	String(afterDelete.status),
)

// ===============================================================
// 11. 未登录时的行为
// ===============================================================

console.log('\n11. 未登录时的行为\n')

const DIR_D = path.join(os.tmpdir(), `bbplayer-share-D-${RUN_ID}`)
fs.mkdirSync(DIR_D, { recursive: true })

const anonymous = runOn(
	DIR_D,
	`
	${PRELUDE}
	// 分享要先有一个本地歌单，否则会在「歌单不存在」处就抛错，
	// 测不到「未登录时后端返回 401」这件事
	const playlist = db.createPlaylist({ title: '未登录测试', type: 'local' })
	const results = {}
	for (const [name, fn] of Object.entries({
		share: () => shared.sharePlaylist(playlist.id),
		subscribe: () => shared.subscribe('${shareId}'),
		restore: () => shared.restoreFromCloud(),
	})) {
		try { await fn(); results[name] = 'NO_ERROR' }
		catch (e) { results[name] = e.status + '|' + e.code }
	}
	results.status = shared.accountStatus()
	console.log('__RESULT__' + JSON.stringify(results))
`,
)

check(
	'未登录时分享/订阅/恢复都给出 401 且**不发请求**',
	anonymous.share.startsWith('401') &&
		anonymous.subscribe.startsWith('401') &&
		anonymous.restore.startsWith('401'),
	JSON.stringify({
		share: anonymous.share,
		subscribe: anonymous.subscribe,
		restore: anonymous.restore,
	}),
)
check(
	'未登录时 `accountStatus().loggedIn` 为 false',
	anonymous.status.loggedIn === false,
)

// 未登录仍然能预览（`/preview` 是公开接口）。
// 这里**新建**一个共享歌单来测：前面那个在「取消共享」一节里已经被软删了，
// 拿它来预览只会得到 404，测不出「公开接口不需要令牌」这件事。
const anonTarget = onA(`
	${PRELUDE}
	const playlist = db.createPlaylist({ title: '匿名预览用歌单', type: 'local' })
	const t = db.upsertTrack({
		uniqueKey: 'bilibili::BV1anon', title: '匿名预览曲目',
		artistName: '匿名 UP', artistRemoteId: '8047632',
		coverUrl: null, duration: 100, bvid: 'BV1anon', cid: 1,
	})
	db.addTrackToPlaylist(playlist.id, t.id)
	const r = await shared.sharePlaylist(playlist.id)
	console.log('__RESULT__' + JSON.stringify({ shareId: r.shareId, playlistId: playlist.id }))
`)

const anonymousPreview = runOn(
	DIR_D,
	`
	${PRELUDE}
	const p = await shared.preview('${anonTarget.shareId}')
	console.log('__RESULT__' + JSON.stringify({ title: p.title, count: p.trackCount, loggedIn: shared.accountStatus().loggedIn }))
`,
)
check(
	'但未登录仍可预览（公开接口，不需要任何令牌）',
	anonymousPreview.loggedIn === false &&
		anonymousPreview.title === '匿名预览用歌单',
	`loggedIn=${anonymousPreview.loggedIn} title=${anonymousPreview.title} count=${anonymousPreview.count}`,
)

// ===============================================================
// 12. LWW：旧时间戳的改动不能覆盖新时间戳
// ===============================================================
//
// ⚠️ LWW **只对 `POST /changes` 里的曲目操作生效**。
// `PATCH /playlists/:id`（歌单元数据）**没有任何时间戳比较** ——
// 它就是「谁最后调用谁赢」，一个迟到的改名请求会无条件覆盖。
// 第一版断言拿 `update_metadata` 去测 LWW，于是必然失败；错的是断言。
// 这里改用曲目操作（`remove` / `upsert`）来测，那才是 LWW 真正管的东西。

console.log('\n12. LWW（服务端按 operation_at 裁决曲目操作）\n')

const lww = onA(`
	${PRELUDE}
	const playlist = db.createPlaylist({ title: 'LWW 测试', type: 'local' })
	const t = db.upsertTrack({
		uniqueKey: 'bilibili::BV1lww', title: 'LWW 曲目',
		artistName: 'LWW UP', artistRemoteId: '8047632',
		coverUrl: null, duration: 100, bvid: 'BV1lww', cid: 1,
	})
	db.addTrackToPlaylist(playlist.id, t.id)
	const share = await shared.sharePlaylist(playlist.id)
	await shared.syncPlaylist(playlist.id)

	const now = Date.now()
	// ① 用「现在」的时间戳删掉它
	shared.queueLocalChange(playlist.id, 'remove_tracks', { removedTrackIds: [t.id] }, now)
	await shared.syncPlaylist(playlist.id)
	// ② 再用「一分钟前」的时间戳把它加回来 —— 服务端应当拒绝这条过期的 upsert
	shared.queueLocalChange(playlist.id, 'add_tracks', { trackIds: [t.id] }, now - 60_000)
	await shared.syncPlaylist(playlist.id)

	const preview = await shared.preview(share.shareId)
	console.log('__RESULT__' + JSON.stringify({ shareId: share.shareId, title: preview.title, trackCount: preview.trackCount }))
`)

check(
	'过期的 upsert 无法复活一条更晚被删除的曲目（LWW 拒绝旧时间戳）',
	lww.trackCount === 0,
	`服务端还剩 ${lww.trackCount} 首`,
)

const lwwReverse = onA(`
	${PRELUDE}
	const playlist = db.createPlaylist({ title: 'LWW 反向', type: 'local' })
	const t = db.upsertTrack({
		uniqueKey: 'bilibili::BV1lww2', title: 'LWW 曲目 2',
		artistName: 'LWW UP', artistRemoteId: '8047632',
		coverUrl: null, duration: 100, bvid: 'BV1lww2', cid: 1,
	})
	db.addTrackToPlaylist(playlist.id, t.id)
	const share = await shared.sharePlaylist(playlist.id)
	await shared.syncPlaylist(playlist.id)

	const now = Date.now()
	// ① 用「现在」的时间戳 upsert（重新加一遍，刷新 updated_at）
	shared.queueLocalChange(playlist.id, 'add_tracks', { trackIds: [t.id] }, now)
	await shared.syncPlaylist(playlist.id)
	// ② 再用「一分钟前」的时间戳删除 —— 服务端应当拒绝
	shared.queueLocalChange(playlist.id, 'remove_tracks', { removedTrackIds: [t.id] }, now - 60_000)
	await shared.syncPlaylist(playlist.id)

	const preview = await shared.preview(share.shareId)
	console.log('__RESULT__' + JSON.stringify({ trackCount: preview.trackCount }))
`)

check(
	'过期的 remove 无法删掉一条更晚被写入的曲目（LWW 双向生效）',
	lwwReverse.trackCount === 1,
	`服务端还剩 ${lwwReverse.trackCount} 首`,
)

// PATCH 没有服务端 LWW 这件事也断言一下。
//
// 后端 `PATCH /playlists/:id` **从不比较时间戳**（只有 `POST /changes` 里的
// 曲目操作走 LWW），所以谁最后调用谁赢。桌面端能做的是**在客户端把顺序摆对**：
// `flushOutbox` 按 `operation_at` **升序**推送，于是同一批里「用户最后做的那个
// 改动」最后落库 —— 结果符合直觉，但这是**客户端顺序**给的保证，
// 不是服务端给的。跨越两次 flush 的迟到改动会无条件覆盖，这一点得如实记下来。
const patchNoLww = onA(`
	${PRELUDE}
	const playlist = db.createPlaylist({ title: 'PATCH 语义', type: 'local' })
	const t = db.upsertTrack({
		uniqueKey: 'bilibili::BV1patch', title: 'PATCH 曲目',
		artistName: 'LWW UP', artistRemoteId: '8047632',
		coverUrl: null, duration: 100, bvid: 'BV1patch', cid: 1,
	})
	db.addTrackToPlaylist(playlist.id, t.id)
	const share = await shared.sharePlaylist(playlist.id)

	// 刻意**乱序入队**：先入队「现在」的新名字，再入队 operation_at 更早的旧名字。
	// flushOutbox 会按 operation_at 升序推送，所以最终应当是「新名字」。
	shared.queueLocalChange(playlist.id, 'update_metadata', { title: '新名字' }, Date.now())
	shared.queueLocalChange(playlist.id, 'update_metadata', { title: '旧名字' }, 1000)
	const sync = await shared.syncPlaylist(playlist.id)
	const preview = await shared.preview(share.shareId)
	console.log('__RESULT__' + JSON.stringify({ sync, title: preview.title }))
`)

check(
	'同一批元数据改动按 operation_at 升序推送，最终是**用户最后做的那次**',
	patchNoLww.title === '新名字',
	`服务端标题=${patchNoLww.title}（入队顺序是「新名字 → 旧名字」，推送时被排成「旧名字 → 新名字」）`,
)
check(
	'元数据改动确实被推上去了（`update_metadata` 走 PATCH 而不是 changes）',
	patchNoLww.sync.pushed === 0 && patchNoLww.sync.failed === 0,
	`pushed=${patchNoLww.sync.pushed}（PATCH 不计入 changes 条数）`,
)

// ===============================================================
// 13. 作者身份：同一个 mid 换名字不能炸
// ===============================================================
//
// `artists` 上有 `source_remote_id_unq (source, remote_id) WHERE source != 'local'`
// 唯一索引。早先 `upsertArtist` 只按 `name` 查、查不到就无条件 INSERT —— 一旦
// **同一个 UP 改过名**，或者同一首曲目先以名字 A 落库、后又以名字 B 带着同一个
// mid 出现，就会撞唯一索引**抛异常**，把整批拉取/导入打断。
//
// 这个缺陷是在写共享歌单的探针时被撞出来的：服务端的 `artist_id` 是 B 站 mid，
// 而曲目里带的作者名常常与 UP 主名不同。带 mid 时 mid 才是身份，名字只是显示属性。
//
// 两条路径都要覆盖：
//   (a) `db.upsertArtist`（本地导入路径，直接调用）
//   (b) `upsertSharedArtist`（共享拉取路径）—— 通过**真实的订阅拉取**来验，
//       不是直接调内部函数：设备 B 早就以「共享测试 UP」这个名字存过 mid
//       `8047632`，现在去订阅一个**同 mid 不同名**（「匿名 UP」）的歌单。

console.log('\n13. 作者身份（同一 mid 换名字）\n')

const artistRename = onB(`
	${PRELUDE}
	const { sqlite } = require('./src/ports.cjs')
	const results = {}

	// (a) 直接路径：同一个 mid 先以「原名」落库，再换一个名字
	db.upsertTrack({
		uniqueKey: 'bilibili::BV1rename1', title: '改名测试 1',
		artistName: 'UP 原名', artistRemoteId: '900001',
		coverUrl: null, duration: 100, bvid: 'BV1rename1', cid: 1,
	})
	try {
		db.upsertTrack({
			uniqueKey: 'bilibili::BV1rename2', title: '改名测试 2',
			artistName: 'UP 新名', artistRemoteId: '900001',
			coverUrl: null, duration: 100, bvid: 'BV1rename2', cid: 2,
		})
		results.directRename = 'ok'
	} catch (error) {
		results.directRename = 'THREW: ' + error.message
	}
	results.rowsFor900001 = sqlite.getAllSync(
		"SELECT name FROM artists WHERE remote_id = '900001'"
	).map((r) => r.name)

	// (b) 共享拉取路径：先记录当前 mid 8047632 叫什么
	results.beforeShared = sqlite.getAllSync(
		"SELECT name FROM artists WHERE remote_id = '8047632'"
	).map((r) => r.name)

	try {
		const sub = await shared.subscribe('${anonTarget.shareId}')
		results.sharedRename = 'ok'
		results.subscribedId = sub.localPlaylistId
	} catch (error) {
		results.sharedRename = 'THREW: ' + error.message
	}
	results.rowsFor8047632 = sqlite.getAllSync(
		"SELECT name FROM artists WHERE remote_id = '8047632'"
	).map((r) => r.name)

	console.log('__RESULT__' + JSON.stringify(results))
`)

check(
	'(a) 本地路径：同一个 mid 换名字不再抛异常',
	artistRename.directRename === 'ok',
	String(artistRename.directRename),
)
check(
	'(a) 同一个 mid 只留一行作者（mid 才是身份，不是名字）',
	artistRename.rowsFor900001.length === 1,
	JSON.stringify(artistRename.rowsFor900001),
)
check(
	'(b) 共享路径的前置条件成立：设备 B 已经用另一个名字存过 mid 8047632',
	Array.isArray(artistRename.beforeShared) &&
		artistRename.beforeShared.length === 1,
	JSON.stringify(artistRename.beforeShared),
)
check(
	'(b) 共享拉取路径：同 mid 不同名不再抛异常',
	artistRename.sharedRename === 'ok',
	String(artistRename.sharedRename),
)
check(
	'(b) 拉取后 mid 8047632 仍然只有一行（没有因改名而插出第二行）',
	artistRename.rowsFor8047632.length === 1,
	JSON.stringify(artistRename.rowsFor8047632),
)

// ===============================================================
// 14. 远端歌单消失：如实告知，**不**静默删本地副本
// ===============================================================
//
// owner 删掉歌单后，其他成员再拉会拿到 404（`deleted_at` 已置位）。
// 移动端在这种情况下会**直接删掉本地歌单**；桌面端刻意不这么做 ——
// 那会静默丢掉用户本地的一整个歌单（里面可能还有本地曲目、播放次数、
// 自定义顺序），而用户根本没点过删除。这里断言「如实告知 + 不删数据」。

console.log('\n14. 远端歌单被删除时的行为\n')

const orphanedB = onB(`
	${PRELUDE}
	const localId = ${artistRename.subscribedId}
	const before = db.getPlaylist(localId)
	console.log('__RESULT__' + JSON.stringify({
		localId,
		existsBefore: Boolean(before),
		shareIdBefore: before ? before.share_id : null,
	}))
`)

check(
	'前置：设备 B 订阅的那个歌单还在本地（share_id 有值）',
	orphanedB.existsBefore === true && Boolean(orphanedB.shareIdBefore),
	JSON.stringify(orphanedB),
)

const deleteAnon = onA(`
	${PRELUDE}
	const r = await shared.unsharePlaylist(${anonTarget.playlistId})
	console.log('__RESULT__' + JSON.stringify({ r }))
`)
check(
	'设备 A 把那个歌单取消共享（远端软删）',
	deleteAnon.r.unshared === true,
	JSON.stringify(deleteAnon.r),
)

const syncGone = onB(`
	${PRELUDE}
	const localId = ${artistRename.subscribedId}
	let sync = null
	let thrown = null
	try { sync = await shared.syncPlaylist(localId) }
	catch (error) { thrown = error.status + '|' + error.message }

	const after = db.getPlaylist(localId)
	const tracks = after ? db.getPlaylistTracks(localId) : []
	console.log('__RESULT__' + JSON.stringify({
		sync,
		thrown,
		existsAfter: Boolean(after),
		trackCount: tracks.length,
	}))
`)

check(
	'远端歌单消失时同步**不抛异常**，而是返回 `gone`（UI 能据此提示）',
	syncGone.thrown === null && syncGone.sync?.gone === true,
	`thrown=${syncGone.thrown} sync=${JSON.stringify(syncGone.sync)}`,
)
check(
	'`goneReason` 如实区分「被删了」与「被移出成员」',
	syncGone.sync?.goneReason === 'deleted',
	String(syncGone.sync?.goneReason),
)
check(
	'**本地歌单没有被静默删掉**（这是与移动端的有意差异）',
	syncGone.existsAfter === true && syncGone.trackCount > 0,
	`存在=${syncGone.existsAfter}，曲目=${syncGone.trackCount}`,
)

const detach = onB(`
	${PRELUDE}
	const localId = ${artistRename.subscribedId}
	const r = shared.detachSharedPlaylist(localId)
	const after = db.getPlaylist(localId)
	console.log('__RESULT__' + JSON.stringify({
		r,
		shareId: after ? after.share_id : 'ROW_GONE',
		role: after ? after.share_role : null,
		trackCount: after ? db.getPlaylistTracks(localId).length : 0,
	}))
`)
check(
	'用户确认后可以只清掉共享标记（歌单与曲目留在本地）',
	detach.r.detached === true &&
		detach.shareId === null &&
		detach.role === null &&
		detach.trackCount > 0,
	JSON.stringify(detach),
)

// ===============================================================

console.log(
	`\n========================================================\n通过 ${passed} 项，失败 ${failed} 项\n设备目录：${DIR_A}\n         ${DIR_B}\n========================================================`,
)
process.exit(failed === 0 ? 0 : 1)
