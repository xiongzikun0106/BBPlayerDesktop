/* oxlint-disable no-console -- 验证脚本，以 stdout 输出 */
/**
 * Phase 5 验收：**打包产物自检**。
 *
 * 对 `electron-builder` 产出的可执行文件跑 `--selfcheck`，
 * 断言「产物自洽」而不是「开发目录能跑」。
 *
 * 用法：
 *   node scripts/verify-packaged.mjs                          # Windows：dist/win-unpacked/BBPlayer.exe
 *   node scripts/verify-packaged.mjs --dir dist/linux-unpacked # Linux：指定解包目录
 *   node scripts/verify-packaged.mjs --exe /path/to/BBPlayer   # 指定可执行文件
 *
 * 在 Linux VPS 上配合 `xvfb-run` 或直接 headless 运行（自检模式不建窗口）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')

/** 从命令行取目标；默认按平台猜 */
function resolveTarget() {
	const args = process.argv.slice(2)
	const dirIndex = args.indexOf('--dir')
	const exeIndex = args.indexOf('--exe')

	if (exeIndex !== -1 && args[exeIndex + 1]) {
		return { exe: path.resolve(args[exeIndex + 1]), dir: null }
	}

	const dir =
		dirIndex !== -1 && args[dirIndex + 1]
			? path.resolve(args[dirIndex + 1])
			: path.join(
					DESKTOP,
					'dist',
					process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked',
				)

	const candidates =
		process.platform === 'win32'
			? ['BBPlayer.exe', 'bbplayer.exe']
			: ['BBPlayer', 'bbplayer', 'bbplayer-desktop']

	for (const name of candidates) {
		const full = path.join(dir, name)
		if (fs.existsSync(full)) return { exe: full, dir }
	}
	return { exe: null, dir }
}

/**
 * 跑一次产物并收集 `__MARKER__` 之后的 JSON。
 *
 * @param {string} exe
 * @param {string[]} argv
 * @param {string} marker
 * @param {number} timeoutMs
 */
function runArtifact(exe, argv, marker, timeoutMs = 120_000) {
	const dataDir = path.join(
		process.env.TEMP ?? '/tmp',
		`bbplayer-packaged-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	)
	fs.mkdirSync(dataDir, { recursive: true })

	const child = spawn(exe, argv, {
		env: {
			...process.env,
			BBPLAYER_DATA_DIR: dataDir,
			ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
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

	return new Promise((resolve) => {
		let settled = false
		const settle = (value) => {
			if (settled) return
			settled = true
			resolve(value)
		}
		const timer = setTimeout(() => {
			child.kill()
			settle({ timeout: true, stdout, stderr })
		}, timeoutMs)
		child.on('exit', (code) => {
			clearTimeout(timer)
			settle({ code, stdout, stderr })
		})
		child.on('error', (error) => {
			clearTimeout(timer)
			settle({ spawnError: error.message, stdout, stderr })
		})
	}).then((outcome) => {
		fs.rmSync(dataDir, { recursive: true, force: true })
		const at = outcome.stdout.lastIndexOf(marker)
		return {
			...outcome,
			parsed:
				at === -1
					? null
					: JSON.parse(
							outcome.stdout
								.slice(at + marker.length)
								.split('\n')[0]
								.trim(),
						),
		}
	})
}

function main() {
	console.log('=== Phase 5 验收：打包产物自检 ===\n')
	console.log(`平台: ${process.platform} ${process.arch}`)

	const { exe, dir } = resolveTarget()
	if (!exe) {
		console.error(`\n✗ 找不到可执行文件。先跑打包：`)
		console.error('    pnpm --filter @bbplayer/desktop run pack:dir')
		console.error(`  查找目录: ${dir}`)
		process.exit(1)
	}

	const stat = fs.statSync(exe)
	console.log(`产物: ${exe}`)
	console.log(`大小: ${(stat.size / 1024 / 1024).toFixed(1)} MB`)

	// Linux 上以 root 运行 Electron 必须加 --no-sandbox；
	// Windows 上加了也无害（参数被忽略）。
	const headless = process.argv.includes('--headless')
	const baseArgs = ['--no-sandbox', '--disable-gpu']
	if (headless) baseArgs.push('--headless')

	if (headless) {
		console.log(
			'模式: headless（不建窗口 —— 渲染进程相关断言会被标记为「跳过」而不是失败）',
		)
	} else {
		console.log('模式: 带窗口（会额外验证渲染进程 + preload 契约）')
	}
	console.log('')

	// 两次运行：一次探针模式（验产物自洽），一次非探针模式（验门控）
	return runArtifact(exe, ['--selfcheck', ...baseArgs], '__SELFCHECK__').then(
		(selfRun) => {
			if (!selfRun.parsed) {
				console.error('\n✗ 产物没有输出自检结果 —— 说明它启动就失败了')
				console.error(`exit=${selfRun.code} ${selfRun.spawnError ?? ''}`)
				console.error('--- stdout ---')
				console.error(selfRun.stdout.trim() || '(空)')
				console.error('--- stderr ---')
				console.error(selfRun.stderr.trim().slice(0, 3000) || '(空)')
				process.exit(1)
			}
			return runArtifact(
				exe,
				['--verify-gating', ...baseArgs],
				'__GATING__',
				90_000,
			).then((gatingRun) => report(selfRun, gatingRun, exe))
		},
	)
}

function report(selfRun, gatingRun, exe) {
	const result = selfRun.parsed

	console.log('--- 运行时信息 ---')
	console.log(
		`  Electron ${result.electron} / Node ${result.node} / Chrome ${result.chrome}`,
	)
	console.log(`  isPackaged = ${result.isPackaged}`)
	console.log(`  appPath    = ${result.appPath}`)
	console.log(`  userData   = ${result.userData}`)
	console.log(`  core 加载来源 = ${result.loader?.loadedFrom ?? '?'}`)

	console.log('\n--- 断言结果 ---')
	const selfcheckTotal = Object.keys(result.checks ?? {}).length
	const selfcheckFailed = Object.values(result.checks ?? {}).filter(
		(c) => !c.ok,
	).length
	for (const [name, check] of Object.entries(result.checks ?? {})) {
		console.log(
			`  ${check.ok ? '✅' : '❌'} ${name}${check.detail ? `  — ${check.detail}` : ''}`,
		)
	}

	if (result.skipped?.length) {
		console.log('\n--- headless 跳过（不适用）---')
		for (const name of result.skipped) console.log(`  ⏭ ${name}`)
	}

	// 打包产物的**关键**断言：必须真的是 packaged 且走 bundle
	console.log('\n--- 打包特有断言 ---')
	const packagedChecks = [
		['产物确实是打包态（isPackaged）', result.isPackaged === true],
		[
			'core 从 bundle 加载（源码不在包内）',
			result.loader?.loadedFrom === 'bundle',
		],
		['core 源码确实不在包内', result.loader?.coreSourceExists === false],
		[
			'没有加载 jiti（生产不需要运行时编译器）',
			result.loader?.jitiLoaded === false,
		],
	]
	for (const [name, ok] of packagedChecks) {
		console.log(`  ${ok ? '✅' : '❌'} ${name}`)
	}

	// 门控断言：非探针模式下 bbProbe 必须**不存在**
	console.log('\n--- 能力门控断言（非探针模式启动）---')
	const gating = gatingRun.parsed
	const gatingChecks = []
	const skippedGating = []
	if (!gating || gating.error) {
		gatingChecks.push([
			'门控验证能跑起来',
			false,
			gating?.error ?? `没有输出（exit=${gatingRun.code}）`,
		])
	} else if (gating.headless === true) {
		// headless：读不到渲染进程，如实记为「跳过」而不是失败
		gatingChecks.push([
			'主进程侧确认非探针模式下不启用探针通道',
			gating.probeEnabled === false,
			`PROBE_ENABLED=${gating.probeEnabled}`,
		])
		skippedGating.push(
			'非探针模式下 window.bbProbe 不存在（需要显示环境；VPS 上可用 xvfb-run）',
			'非探针模式下 window.bbplayer 仍可用',
			'非探针模式下应用仍能就绪',
		)
	} else {
		gatingChecks.push([
			'非探针模式下 window.bbProbe 不存在',
			gating.hasBbProbe === 'undefined',
			`typeof window.bbProbe = ${gating.hasBbProbe}`,
		])
		gatingChecks.push([
			'非探针模式下 window.bbplayer 仍可用（门控只关探针通道）',
			gating.hasBbplayer === 'object',
			`typeof window.bbplayer = ${gating.hasBbplayer}`,
		])
		gatingChecks.push([
			'非探针模式下应用仍能就绪',
			gating.ready === true,
			`__bbReady = ${gating.ready}`,
		])
	}
	for (const [name, ok, detail] of gatingChecks) {
		console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`)
	}
	for (const name of skippedGating) console.log(`  ⏭ ${name}`)

	if (result.failures?.length) {
		console.log('\n--- 自检失败原因 ---')
		for (const failure of result.failures) console.log(`  ${failure}`)
	}
	if (result.stack) {
		console.log('\n--- 堆栈 ---')
		console.log(result.stack.join('\n'))
	}

	const packagedFailed = packagedChecks.filter(([, ok]) => !ok).length
	const gatingFailed = gatingChecks.filter(([, ok]) => !ok).length
	const totalFailed = selfcheckFailed + packagedFailed + gatingFailed
	const totalPassed =
		selfcheckTotal -
		selfcheckFailed +
		(packagedChecks.length - packagedFailed) +
		(gatingChecks.length - gatingFailed)

	console.log(`\n${'='.repeat(56)}`)
	console.log(`产物: ${path.basename(exe)}`)
	console.log(`通过 ${totalPassed} 项，失败 ${totalFailed} 项`)
	console.log('='.repeat(56))

	process.exit(totalFailed === 0 ? 0 : 1)
}

// 显式 void：脚本入口的浮动 Promise（内部已处理错误）
void main()
