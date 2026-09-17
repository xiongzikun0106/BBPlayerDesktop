/* oxlint-disable no-console -- 验证脚本，以 stdout 输出 */
/**
 * Phase 3.4 验收：**共享歌单的界面**（点击级）。
 *
 * 后端契约层在 `scripts/verify-shared-playlist.mts`（84 项）里验过了，
 * 这里只验「用户点得到、看得见、状态对」：
 * 账号面板、订阅、分享、成员、邀请码、只读角色、取消共享。
 *
 * 断言序列在 `apps/desktop/src/share-probe-driver.cjs`，跑在本机后端上。
 *
 * ## 需要先建立隧道
 *
 * 后端跑在 VPS 的 `127.0.0.1:8787`（`wrangler dev` + 本地 Postgres），
 * **不对外开放**。Windows 这边要先：
 *
 *   ssh -i <key> -N -L 8787:127.0.0.1:8787 root@<vps>
 *
 * 隧道不在时脚本**直接失败**，而不是悄悄去打上游的生产后端
 * （`be.bbplayer.roitium.com` 是别人正在服务的库，不该被自动化脚本写）。
 *
 * 用法：node scripts/verify-desktop-shared.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')
const SHOT_DIR = path.join(DESKTOP, 'probe-output', 'share-shots')
const REPORT_PATH = path.join(DESKTOP, 'probe-output', 'share-report.json')
const API_URL = process.env.BBPLAYER_API_URL ?? 'http://127.0.0.1:8787'

const RUN_ID = Date.now().toString(36)
const DATA_DIR = path.join(os.tmpdir(), `bbplayer-share-ui-${RUN_ID}`)
const SEED_DIR = path.join(os.tmpdir(), `bbplayer-share-seed-${RUN_ID}`)
fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(SEED_DIR, { recursive: true })
fs.mkdirSync(SHOT_DIR, { recursive: true })

/** 在某个数据目录里跑一段 async 脚本（前置数据准备用） */
function runOn(dataDir, script) {
	const wrapped = `(async () => {\n${script}\n})().catch((error) => {\n\tconsole.error(error)\n\tprocess.exit(1)\n})`
	const output = execFileSync(process.execPath, ['-e', wrapped], {
		cwd: DESKTOP,
		encoding: 'utf8',
		env: {
			...process.env,
			BBPLAYER_DATA_DIR: dataDir,
			BBPLAYER_API_URL: API_URL,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 120_000,
	})
	const marker = output.lastIndexOf('__RESULT__')
	if (marker === -1) throw new Error(`前置脚本未返回结果:\n${output}`)
	return JSON.parse(output.slice(marker + '__RESULT__'.length).trim())
}

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

	/** 造一个带 n 首 B 站曲目的歌单 */
	function makePlaylist(title, count) {
		const playlist = db.createPlaylist({ title, type: 'local' })
		const trackIds = []
		for (let i = 0; i < count; i++) {
			const bvid = 'BV' + Math.random().toString(36).slice(2, 10).toUpperCase()
			const t = db.upsertTrack({
				uniqueKey: 'bilibili::' + bvid,
				title: title + ' 第 ' + (i + 1) + ' 首',
				artistName: '验收用 UP',
				artistRemoteId: '8047632',
				coverUrl: null,
				duration: 180,
				bvid,
				cid: 100 + i,
			})
			db.addTrackToPlaylist(playlist.id, t.id)
			trackIds.push(t.id)
		}
		return { playlistId: playlist.id, trackIds }
	}
`

/**
 * 前置数据。
 *
 * 界面上要验「订阅**别人**的共享歌单」，就得真的存在一个别人建的共享歌单 ——
 * 所以用一个独立的数据目录 + 独立账号先在本地后端上把它造出来。
 * 这样探针里的失败一定是**界面**问题，而不是「造数据失败」。
 */
function prepare() {
	const remoteTitle = `远端歌单 ${RUN_ID}`
	const localTitle = `待分享歌单 ${RUN_ID}`
	const seederName = '远端主人'

	const seeded = runOn(
		SEED_DIR,
		`
	${PRELUDE}
	await account.register({
		username: 'seeder${RUN_ID}',
		password: 'seeder-password-2024',
		name: '${seederName}',
	})
	const { playlistId } = makePlaylist('${remoteTitle}', 3)
	const sharedInfo = await shared.sharePlaylist(playlistId)
	const invite = await shared.rotateInviteCode(playlistId)
	// 契约层的角色升级已经在 verify-shared-playlist.mts 里验过；
	// 这里只要一个「别人建的、带邀请码的共享歌单」
	console.log('__RESULT__' + JSON.stringify({
		shareId: sharedInfo.shareId,
		shareLink: sharedInfo.shareLink,
		inviteCode: invite.inviteCode,
		uploaded: sharedInfo.uploaded,
	}))
`,
	)

	// 本机数据目录里放一个纯本地歌单，用来验音乐库里的「分享」按钮
	const local = runOn(
		DATA_DIR,
		`
	${PRELUDE}
	const { playlistId } = makePlaylist('${localTitle}', 2)
	console.log('__RESULT__' + JSON.stringify({ playlistId }))
`,
	)

	return {
		shareLink: seeded.shareLink,
		inviteCode: seeded.inviteCode,
		shareId: seeded.shareId,
		remoteTitle,
		localTitle,
		localPlaylistId: local.playlistId,
		seederName,
	}
}

function electronBinary() {
	const pnpmDir = path.join(ROOT, 'node_modules', '.pnpm')
	const match = fs
		.readdirSync(pnpmDir)
		.find((name) => name.startsWith('electron@'))
	if (!match) throw new Error('找不到 electron 包')
	return path.join(
		pnpmDir,
		match,
		'node_modules',
		'electron',
		'dist',
		process.platform === 'win32' ? 'electron.exe' : 'electron',
	)
}

async function assertBackendReachable() {
	let ok = false
	let detail = ''
	try {
		const response = await fetch(`${API_URL}/health`)
		ok = response.ok
		detail = `HTTP ${response.status}`
	} catch (error) {
		detail = String(error)
	}
	if (!ok) {
		console.error(`\n✗ 本机后端不可达：${API_URL}（${detail}）`)
		console.error('  共享歌单的界面验收需要一个**本机**后端，请先建立隧道：')
		console.error('    ssh -i <key> -N -L 8787:127.0.0.1:8787 root@<vps>')
		console.error('  刻意不去回退到上游生产后端（那是别人正在服务的库）。\n')
		process.exit(1)
	}
	return detail
}

function main() {
	const binary = electronBinary()
	console.log('=== Phase 3.4 验收：共享歌单界面 ===\n')
	console.log(`后端: ${API_URL}`)
	console.log(`数据目录: ${DATA_DIR}`)
	console.log(`截图目录: ${SHOT_DIR}\n`)

	// 清掉可能残留的报告，避免读到上一次的结果
	fs.rmSync(REPORT_PATH, { force: true })

	const prep = prepare()
	console.log('--- 前置数据 ---')
	console.log(`  远端歌单: ${prep.remoteTitle}（${prep.shareId}）`)
	console.log(`  分享链接: ${prep.shareLink}`)
	console.log(`  邀请码:   ${prep.inviteCode}`)
	console.log(`  本机歌单: ${prep.localTitle}（id=${prep.localPlaylistId}）\n`)

	const child = spawn(binary, ['.', '--share-probe'], {
		cwd: DESKTOP,
		env: {
			...process.env,
			BBPLAYER_DATA_DIR: DATA_DIR,
			BBPLAYER_UI_SHOTS: SHOT_DIR,
			BBPLAYER_API_URL: API_URL,
			BBPLAYER_SHARE_PREP: JSON.stringify(prep),
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	})

	let stdout = ''
	let stderr = ''
	child.stdout.on('data', (chunk) => {
		stdout += chunk.toString()
	})
	child.stderr.on('data', (chunk) => {
		stderr += chunk.toString()
	})

	const exitCode = new Promise((resolve) => {
		let settled = false
		const settle = (value) => {
			if (settled) return
			settled = true
			resolve(value)
		}
		const timer = setTimeout(() => {
			console.error('\n⚠ 超时（900s），强制结束')
			child.kill()
			settle('timeout')
		}, 900_000)
		child.on('exit', (code) => {
			clearTimeout(timer)
			settle(code)
		})
	})

	return exitCode.then((code) => {
		console.log('--- Electron 输出 ---')
		console.log(stdout.trim() || '(空)')
		if (stderr.trim()) {
			console.log('--- stderr ---')
			console.log(stderr.trim().slice(0, 2000))
		}

		if (!fs.existsSync(REPORT_PATH)) {
			console.error(`\n✗ 未产出报告: ${REPORT_PATH}`)
			process.exit(1)
		}

		const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'))
		console.log('\n--- 断言结果 ---')
		let failed = 0
		for (const check of report.checks) {
			if (check.ok) {
				console.log(
					`  ✅ ${check.name}${check.detail ? `  — ${check.detail}` : ''}`,
				)
			} else {
				failed++
				console.log(
					`  ❌ ${check.name}${check.detail ? `  — ${check.detail}` : ''}`,
				)
			}
		}

		if (report.pending?.length) {
			console.log('\n--- 待人工验证（探针无法覆盖）---')
			for (const item of report.pending) {
				console.log(`  ⏳ ${item.name} — ${item.reason}`)
			}
		}

		if (report.screenshots?.length) {
			console.log('\n截图：')
			for (const file of report.screenshots) console.log(`  ${file}`)
		}

		console.log(`\n${'='.repeat(56)}`)
		console.log(
			`通过 ${report.checks.length - failed} 项，失败 ${failed} 项，待人工验证 ${report.pending?.length ?? 0} 项（electron exit=${code}）`,
		)
		console.log('='.repeat(56))
		process.exit(failed === 0 ? 0 : 1)
	})
}

const reachableDetail = await assertBackendReachable()
console.log(`后端可达（${reachableDetail}）\n`)
// 显式 void：脚本入口的浮动 Promise（内部已处理错误）
void main()
