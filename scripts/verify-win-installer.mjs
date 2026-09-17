/* oxlint-disable no-console -- 验证脚本，以 stdout 输出 */
/**
 * Phase 5 验收：**Windows 安装包**的装/卸全程（静默）。
 *
 * 为什么不能只验 `win-unpacked`：安装包会做几件解包目录里看不到的事 ——
 * 写注册表卸载项、建开始菜单快捷方式、装 `Uninstall BBPlayer.exe`、
 * 以及在 `perMachine: false` 下把程序装进 `%LOCALAPPDATA%\Programs`。
 * 这些恰恰是「用户到底能不能装上、能不能卸干净」的答案。
 *
 * 覆盖：
 *   1. 静默安装 `/S` → 可执行文件与卸载器都出现
 *   2. 对**装出来的那个**可执行文件跑完整的打包产物自检（24 项）
 *   3. 静默卸载 `/S` → 目录被清空、卸载器消失
 *   4. portable 产物也能启动并自检通过
 *
 * 只能在 Windows 上跑；其它平台直接跳过（退出码 0，并说明原因）。
 *
 * 用法：node scripts/verify-win-installer.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIST = path.join(ROOT, 'apps', 'desktop', 'dist')

/** electron-builder 在 `perMachine: false` 下的默认安装目录 */
const INSTALL_DIR = path.join(
	process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
	'Programs',
	'BBPlayer',
)
const INSTALLED_EXE = path.join(INSTALL_DIR, 'BBPlayer.exe')
const UNINSTALLER = path.join(INSTALL_DIR, 'Uninstall BBPlayer.exe')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let passed = 0
let failed = 0

function check(name, ok, detail = '') {
	if (ok) {
		passed++
		console.log(`  ✅ ${name}${detail ? `  — ${detail}` : ''}`)
	} else {
		failed++
		console.log(`  ❌ ${name}${detail ? `  — ${detail}` : ''}`)
	}
}

function findFirst(pattern) {
	if (!fs.existsSync(DIST)) return null
	const name = fs.readdirSync(DIST).find((entry) => pattern.test(entry))
	return name ? path.join(DIST, name) : null
}

/** 轮询直到条件成立或超时 */
async function waitUntil(label, predicate, timeoutMs = 120_000) {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		if (await predicate()) return true
		await sleep(1000)
	}
	console.log(`     （等待超时：${label}）`)
	return false
}

/** 用系统默认方式执行一个 .exe 并等它结束 */
function runExe(exe, args, timeoutMs = 300_000) {
	const result = spawnSync(exe, args, {
		timeout: timeoutMs,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	})
	return {
		status: result.status,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	}
}

/** 静默卸载已经装着的旧版本，保证测试从一个干净状态开始 */
async function purgeExisting() {
	if (!fs.existsSync(UNINSTALLER)) {
		// 没有卸载器但目录还在：直接删掉（上一次测试留下的残骸）
		if (fs.existsSync(INSTALL_DIR))
			fs.rmSync(INSTALL_DIR, { recursive: true, force: true })
		return
	}
	console.log('   清理上一次安装…')
	runExe(UNINSTALLER, ['/S'])
	await waitUntil('旧安装被移除', () => !fs.existsSync(INSTALLED_EXE), 60_000)
}

async function main() {
	if (process.platform !== 'win32') {
		console.log('非 Windows 平台，跳过安装包验收（这属于 Linux 那条路径）。')
		process.exit(0)
	}

	console.log('=== Phase 5 验收：Windows 安装包 ===\n')

	const setup = findFirst(/nsis-setup\.exe$/)
	const portable = findFirst(/portable\.exe$/)

	if (!setup) {
		console.error(
			`✗ 找不到 nsis-setup 产物，先跑 pnpm --filter @bbplayer/desktop build:win`,
		)
		process.exit(1)
	}

	console.log(
		`安装包: ${setup}（${(fs.statSync(setup).size / 1024 / 1024).toFixed(1)} MB）`,
	)
	console.log(`安装目录: ${INSTALL_DIR}\n`)

	// ---------- 1. 静默安装 ----------
	console.log('1. 静默安装')

	await purgeExisting()
	check(
		'安装前是干净状态（没有已安装的可执行文件）',
		!fs.existsSync(INSTALLED_EXE),
	)

	const install = runExe(setup, ['/S'])
	const installed = await waitUntil(
		'可执行文件出现',
		() => fs.existsSync(INSTALLED_EXE),
		180_000,
	)
	check(
		'`/S` 静默安装成功并装出可执行文件',
		installed,
		`exit=${install.status}，路径=${INSTALLED_EXE}`,
	)
	check(
		'安装目录里有卸载器（用户能在「应用和功能」里卸载）',
		fs.existsSync(UNINSTALLER),
	)
	check(
		'安装目录里有 asar 资源（不是只拷了个空壳）',
		fs.existsSync(path.join(INSTALL_DIR, 'resources', 'app.asar')),
	)

	// ---------- 2. 对装出来的可执行文件跑完整自检 ----------
	console.log('\n2. 对**装出来的**可执行文件跑打包产物自检')

	const verify = spawnSync(
		process.execPath,
		[path.join(ROOT, 'scripts', 'verify-packaged.mjs'), '--exe', INSTALLED_EXE],
		{ stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 600_000 },
	)
	const verifyOut = `${verify.stdout ?? ''}${verify.stderr ?? ''}`
	const passedMatch = verifyOut.match(/通过 (\d+) 项，失败 (\d+) 项/)
	const preloadLine = verifyOut
		.split('\n')
		.find((line) => line.includes('preload 契约完整'))
	console.log(
		`    verify-packaged: ${passedMatch ? passedMatch[0] : '（没解析到汇总行）'}`,
	)
	check(
		'安装后的产物自检全绿',
		Boolean(passedMatch) && passedMatch[2] === '0' && verify.status === 0,
		passedMatch ? passedMatch[0] : `exit=${verify.status}`,
	)
	check(
		'安装后的产物里六个 preload 桥都在',
		Boolean(preloadLine) &&
			[
				'settings',
				'download',
				'backup',
				'share',
				'playlist',
				'externalImport',
			].every((bridge) => preloadLine.includes(`"${bridge}":"object"`)),
		(preloadLine ?? '(没找到该断言)').trim(),
	)

	// ---------- 3. 静默卸载 ----------
	console.log('\n3. 静默卸载')

	const uninstall = runExe(UNINSTALLER, ['/S'])
	const removed = await waitUntil(
		'可执行文件被移除',
		() => !fs.existsSync(INSTALLED_EXE),
		180_000,
	)
	check(
		'`/S` 静默卸载成功（可执行文件已移除）',
		removed,
		`exit=${uninstall.status}`,
	)

	const leftovers = (await waitUntil(
		'目录被清空',
		() =>
			!fs.existsSync(INSTALL_DIR) || fs.readdirSync(INSTALL_DIR).length === 0,
		60_000,
	))
		? []
		: fs.existsSync(INSTALL_DIR)
			? fs.readdirSync(INSTALL_DIR)
			: []
	check(
		'安装目录被清空（没有残留文件）',
		leftovers.length === 0,
		leftovers.length > 0 ? leftovers.slice(0, 8).join(', ') : '空',
	)

	// ---------- 4. portable 产物 ----------
	console.log('\n4. portable 产物')

	if (!portable) {
		check('存在 portable 产物', false, '没找到 *portable.exe')
	} else {
		check('存在 portable 产物', true, path.basename(portable))

		// ⚠️ portable 是 NSIS 自解压启动器：它**解包后 detach 子进程**，
		// 所以拿不到子进程的 stdout —— `spawnSync` 立刻以 0 退出，
		// 而应用还在跑（第一版因此误判成「没输出自检结果」）。
		//
		// 因此改为**从它建出来的库取证**：把 userData 指到一个空目录，
		// 等它把数据库建出来，再直接打开那个库检查表与迁移记账。
		// 这能证明「portable 产物真的能启动，且包内的 core 与迁移都生效」。
		const dataDir = path.join(os.tmpdir(), `bbplayer-portable-${Date.now()}`)
		fs.mkdirSync(dataDir, { recursive: true })

		const launcher = spawnSync(
			portable,
			['--no-sandbox', '--headless', '--selfcheck'],
			{
				timeout: 300_000,
				encoding: 'utf8',
				env: { ...process.env, BBPLAYER_DATA_DIR: dataDir },
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
			},
		)

		const dbFile = path.join(dataDir, 'bbplayer.db')
		const created = await waitUntil(
			'portable 建出数据库',
			() => fs.existsSync(dbFile),
			120_000,
		)
		check(
			'portable 产物能启动并初始化出数据库',
			created,
			`launcher exit=${launcher.status}，userData=${dataDir}`,
		)

		let tables = []
		let ledger = []
		if (created) {
			const { DatabaseSync } = await import('node:sqlite')
			const db = new DatabaseSync(dbFile)
			// node:sqlite 的原始 API 是 `prepare(...).all()`（桌面端的
			// `getAllSync` 是 ports.cjs 包出来的一层）
			tables = db
				.prepare("SELECT name FROM sqlite_master WHERE type='table'")
				.all()
				.map((row) => row.name)
			ledger = db
				.prepare('SELECT name FROM __bbplayer_data_migrations')
				.all()
				.map((row) => row.name)
			db.close()
		}
		check(
			'portable 包内的 core 与基线迁移都生效（12 张表）',
			tables.length === 12,
			`${tables.length} 张：${tables.join(', ')}`,
		)
		check(
			'portable 包内的 sort_key 数据迁移也跑到了',
			ledger.includes('sort_key_desktop_v1') && ledger.includes('sort_key_v3'),
			ledger.join(', '),
		)
	}

	console.log(`\n${'='.repeat(56)}`)
	console.log(`通过 ${passed} 项，失败 ${failed} 项`)
	console.log('='.repeat(56))
	process.exit(failed === 0 ? 0 : 1)
}

// 显式 void：脚本入口的浮动 Promise（内部已处理错误）
void main()
