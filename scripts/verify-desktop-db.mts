/* oxlint-disable no-console -- 验证脚本，以 stdout 输出 */
/**
 * Phase 1 验收：**桌面端跑通「拉一次 B 站歌单并落库」**。
 *
 * 为什么用 UP 公开合集而不是收藏夹：收藏夹需要登录态，而合集是公开的，
 * 因此能在无凭据的情况下端到端验证「拉取 -> 落库 -> 读回」全链路。
 *
 * 覆盖：
 *  1. 迁移能在桌面端数据库上跑通（schema 与移动端同源）
 *  2. 拉取一个真实合集的视频列表
 *  3. 逐个解析音频流（走 core 的 WBI 签名），并优先主线 CDN
 *  4. 落库（playlists / tracks / bilibili_metadata / playlist_tracks）
 *  5. 读回并校验，且**重复落库是幂等的**
 *
 * 用法：pnpm exec tsx scripts/verify-desktop-db.mts
 *   （用 tsx 只是为了能 import core 的类型；脚本本身跑在 Node 里）
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')

// 用独立的临时数据目录，避免污染真实用户数据
const DATA_DIR = path.join(os.tmpdir(), `bbplayer-p1-${Date.now()}`)
fs.mkdirSync(DATA_DIR, { recursive: true })

// 让 desktop 的 ports.cjs 用这个目录
process.env.BBPLAYER_DATA_DIR = DATA_DIR

const TEST_MID = 8047632 // B 站官方 UP，有多个公开合集

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

/** 在 apps/desktop 目录下用 node 跑一段脚本（CJS），返回 JSON */
function runNode(script: string): unknown {
	const output = execFileSync(process.execPath, ['-e', script], {
		cwd: DESKTOP,
		encoding: 'utf8',
		env: { ...process.env, BBPLAYER_DATA_DIR: DATA_DIR },
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	const marker = output.lastIndexOf('__RESULT__')
	if (marker === -1) throw new Error(`子进程未返回结果:\n${output}`)
	return JSON.parse(output.slice(marker + '__RESULT__'.length).trim())
}

async function main() {
	console.log('=== Phase 1 验收：拉 B 站歌单并落库 ===\n')
	console.log(`数据目录: ${DATA_DIR}\n`)

	// ---------------------------------------------------------------
	// 1. 迁移
	// ---------------------------------------------------------------
	console.log('[1] 应用数据库迁移（schema 与移动端同源）')
	const migration = runNode(`
		const db = require('./src/db.cjs')
		const result = db.runMigrations()
		const tables = db.listTables()
		console.log('__RESULT__' + JSON.stringify({ executed: result.executed, tables }))
	`) as { executed: string[]; tables: string[] }

	check(
		'迁移首次执行成功',
		migration.tables.length > 0,
		`执行 ${migration.executed.length} 个迁移：${migration.executed.join(', ')}`,
	)
	const expectedTables = [
		'artists',
		'playlists',
		'tracks',
		'playlist_tracks',
		'bilibili_metadata',
	]
	for (const table of expectedTables) {
		check(`表 ${table} 已存在`, migration.tables.includes(table))
	}

	// 幂等：再跑一次不应重复执行
	const migration2 = runNode(`
		const db = require('./src/db.cjs')
		const result = db.runMigrations()
		console.log('__RESULT__' + JSON.stringify({ executed: result.executed }))
	`) as { executed: string[] }
	check(
		'重复迁移是幂等的',
		migration2.executed.length === 0,
		`第二次执行 ${migration2.executed.length} 个`,
	)

	// ---------------------------------------------------------------
	// 2. 拉取合集
	// ---------------------------------------------------------------
	console.log('\n[2] 拉取 UP 公开合集')
	const seasons = (await runNodeAsync(`
		const api = require('./src/bilibili-api.cjs')
		api.listUserSeasons(${TEST_MID}).then((list) => {
			console.log('__RESULT__' + JSON.stringify(list))
		}).catch((e) => {
			console.log('__RESULT__' + JSON.stringify({ error: e.message }))
		})
	`)) as
		| Array<{ seasonId: number; title: string; total: number }>
		| { error: string }

	check(
		'拉到公开合集列表',
		Array.isArray(seasons) && seasons.length > 0,
		Array.isArray(seasons)
			? `${seasons.length} 个合集`
			: JSON.stringify(seasons),
	)
	if (!Array.isArray(seasons) || seasons.length === 0) {
		return finish()
	}

	// 选一个条目较多的合集
	const target = [...seasons].sort((a, b) => b.total - a.total)[0]
	console.log(`      选中: ${target.title}（${target.total} 个视频）`)

	const archives = (await runNodeAsync(`
		const api = require('./src/bilibili-api.cjs')
		api.listSeasonArchives(${TEST_MID}, ${target.seasonId}, { maxItems: 5 }).then((list) => {
			console.log('__RESULT__' + JSON.stringify(list))
		}).catch((e) => {
			console.log('__RESULT__' + JSON.stringify({ error: e.message }))
		})
	`)) as Array<{ bvid: string; title: string }> | { error: string }

	check(
		'拉到合集内的视频',
		Array.isArray(archives) && archives.length > 0,
		Array.isArray(archives)
			? `${archives.length} 个视频`
			: JSON.stringify(archives),
	)
	if (!Array.isArray(archives) || archives.length === 0) {
		return finish()
	}
	for (const item of archives.slice(0, 3)) {
		console.log(`      ${item.bvid}  ${item.title}`)
	}

	// ---------------------------------------------------------------
	// 3+4. 解析音频流并落库
	// ---------------------------------------------------------------
	console.log('\n[3] 逐个解析音频流（core 的 WBI 签名）并落库')
	const ingest = (await runNodeAsync(
		`
		const api = require('./src/bilibili-api.cjs')
		const db = require('./src/db.cjs')
		const bvids = ${JSON.stringify(archives.map((a) => a.bvid))}

		;(async () => {
			const playlist = db.createPlaylist({
				title: ${JSON.stringify(target.title)},
				type: 'local',
			})

			let inserted = 0
			const streams = []
			for (const bvid of bvids) {
				try {
					const info = await api.getVideoInfo(bvid)
					const stream = await api.getAudioStream(bvid, info.cid)
					const uniqueKey = 'bilibili::' + bvid
					const track = db.upsertTrack({
						uniqueKey,
						title: info.title,
						artistName: info.owner,
						artistRemoteId: info.ownerMid,
						coverUrl: info.cover,
						duration: info.duration,
						bvid,
						cid: info.cid,
						isMultiPage: info.pages > 1,
					})
					const added = db.addTrackToPlaylist(playlist.id, track.id, inserted)
					if (added) inserted++
					streams.push({
						bvid,
						host: new URL(stream.url).host,
						tier: stream.tier,
						qualityId: stream.qualityId,
						isMainline: !new URL(stream.url).host.includes('mcdn.bilivideo'),
					})
				} catch (e) {
					streams.push({ bvid, error: e.message })
				}
			}

			const tracks = db.getPlaylistTracks(playlist.id)
			const saved = db.getPlaylist(playlist.id)
			console.log('__RESULT__' + JSON.stringify({
				playlistId: playlist.id,
				inserted,
				streams,
				trackCount: tracks.length,
				itemCount: saved.item_count,
				titles: tracks.map((t) => t.title),
			}))
		})().catch((e) => {
			console.log('__RESULT__' + JSON.stringify({ error: e.message }))
		})
	`,
	)) as {
		playlistId?: number
		inserted?: number
		streams?: Array<{
			bvid: string
			host?: string
			tier?: string
			qualityId?: number
			isMainline?: boolean
			error?: string
		}>
		trackCount?: number
		itemCount?: number
		titles?: string[]
		error?: string
	}

	if (ingest.error) {
		check('解析 + 落库流程无异常', false, ingest.error)
		return finish()
	}

	check(
		'创建了播放列表',
		typeof ingest.playlistId === 'number',
		`id=${ingest.playlistId}`,
	)
	check(
		'曲目已落库',
		(ingest.trackCount ?? 0) > 0,
		`${ingest.trackCount} 首（inserted ${ingest.inserted}）`,
	)
	check(
		'playlists.item_count 与实际一致',
		ingest.itemCount === ingest.trackCount,
		`item_count=${ingest.itemCount} / tracks=${ingest.trackCount}`,
	)

	const okStreams = (ingest.streams ?? []).filter((s) => !s.error)
	check(
		'音频流解析成功',
		okStreams.length > 0,
		`${okStreams.length}/${ingest.streams?.length ?? 0} 成功`,
	)
	for (const stream of ingest.streams ?? []) {
		if (stream.error) {
			console.log(`      ⚠ ${stream.bvid}: ${stream.error}`)
		} else {
			console.log(
				`      ${stream.bvid}  音质 ${stream.qualityId}  阶梯 ${stream.tier}  主线=${stream.isMainline}  ${stream.host}`,
			)
		}
	}
	check(
		'至少一个音频流落在主线 CDN（避免用宽松的 PCDN 自欺）',
		okStreams.some((s) => s.isMainline),
		'',
	)

	// ---------------------------------------------------------------
	// 5. 幂等性
	// ---------------------------------------------------------------
	console.log('\n[4] 重复落库的幂等性')
	const ingest2 = (await runNodeAsync(
		`
		const api = require('./src/bilibili-api.cjs')
		const db = require('./src/db.cjs')
		const bvids = ${JSON.stringify(archives.map((a) => a.bvid))}
		const playlistId = ${ingest.playlistId}

		;(async () => {
			let added = 0
			for (const [i, bvid] of bvids.entries()) {
				const info = await api.getVideoInfo(bvid)
				const track = db.upsertTrack({
					uniqueKey: 'bilibili::' + bvid,
					title: info.title,
					artistName: info.owner,
						artistRemoteId: info.ownerMid,
					coverUrl: info.cover,
					duration: info.duration,
					bvid, cid: info.cid, isMultiPage: info.pages > 1,
				})
				if (db.addTrackToPlaylist(playlistId, track.id, i)) added++
			}
			const tracks = db.getPlaylistTracks(playlistId)
			const saved = db.getPlaylist(playlistId)
			console.log('__RESULT__' + JSON.stringify({
				added, trackCount: tracks.length, itemCount: saved.item_count,
			}))
		})().catch((e) => console.log('__RESULT__' + JSON.stringify({ error: e.message })))
	`,
	)) as {
		added?: number
		trackCount?: number
		itemCount?: number
		error?: string
	}

	check('重复落库没有新增曲目', ingest2.added === 0, `新增 ${ingest2.added} 条`)
	check(
		'曲目数保持不变',
		ingest2.trackCount === ingest.trackCount,
		`${ingest2.trackCount} vs ${ingest.trackCount}`,
	)
	check(
		'item_count 未被重复累加',
		ingest2.itemCount === ingest.itemCount,
		`${ingest2.itemCount} vs ${ingest.itemCount}`,
	)

	// ---------------------------------------------------------------
	// 6. 数据库文件确实落盘
	// ---------------------------------------------------------------
	console.log('\n[5] 数据库文件落盘')
	const dbFile = path.join(DATA_DIR, 'bbplayer.db')
	check('db 文件存在', fs.existsSync(dbFile), dbFile)
	if (fs.existsSync(dbFile)) {
		const size = fs.statSync(dbFile).size
		check('db 文件非空', size > 0, `${size} 字节`)
	}

	return finish()
}

/** 跑一段带异步的 node 脚本并取回 JSON */
function runNodeAsync(script: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['-e', script], {
			cwd: DESKTOP,
			env: { ...process.env, BBPLAYER_DATA_DIR: DATA_DIR },
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		let out = ''
		let err = ''
		child.stdout.on('data', (c) => {
			out += c.toString()
		})
		child.stderr.on('data', (c) => {
			err += c.toString()
		})
		child.on('exit', (code) => {
			const marker = out.lastIndexOf('__RESULT__')
			if (marker === -1) {
				reject(new Error(`子进程无结果 (exit ${code}):\n${out}\n${err}`))
				return
			}
			try {
				resolve(JSON.parse(out.slice(marker + '__RESULT__'.length).trim()))
			} catch (error) {
				reject(new Error(`结果解析失败: ${String(error)}\n${out}`))
			}
		})
	})
}

function finish() {
	console.log(`\n${'='.repeat(54)}`)
	console.log(`通过 ${passed} 项，失败 ${failed} 项`)
	console.log('='.repeat(54))
	if (failed === 0) {
		console.log(`\n数据目录保留供检查: ${DATA_DIR}`)
	}
	process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
	console.error('验收脚本异常:', error)
	process.exit(1)
})
