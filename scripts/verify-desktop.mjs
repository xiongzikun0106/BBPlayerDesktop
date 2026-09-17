/* oxlint-disable no-console -- 验证脚本，以 stdout 输出结果 */
/**
 * 自动化验证（Phase 1 go/no-go）。
 *
 * 用 Electron 自带的 `webContents.executeJavaScript` 驱动渲染进程做「点击级」
 * 操作（点按钮 → 调 window.bbTest），比人工观察可靠；同时 `capturePage` 落盘
 * 截图，供多模态核对 UI 真的渲染出来了。
 *
 * 断言清单：
 *  1. 主进程代理能解析 bvid → 拿到上游 CDN 地址
 *  2. 自定义协议能把音频交给 <audio> 并加载出元数据（readyState >= 1）
 *  3. 能真正开始播放（currentTime 推进）
 *  4. seek 能生效（触发 seeked 且 currentTime 跳到目标）
 *  5. 主进程收到的代理请求里确实带了 Range（证明拖动 seek 走的是 206）
 *  6. 无媒体错误
 *
 * 用法：node scripts/verify-desktop.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')
const OUTPUT = path.join(DESKTOP, 'probe-output')
const RESULT_FILE = path.join(OUTPUT, 'report.json')

/** 在 main.cjs 里被 require 的探针钩子：通过环境变量启用 */
const PROBE_DRIVER = path.join(DESKTOP, 'src', 'probe-driver.cjs')

const RESULTS = []
let failures = 0

function record(name, ok, detail) {
	RESULTS.push({ name, ok, detail })
	if (ok) {
		console.log(`  ✅ ${name}${detail ? `  — ${detail}` : ''}`)
	} else {
		failures++
		console.log(`  ❌ ${name}${detail ? `  — ${detail}` : ''}`)
	}
}

function electronBinary() {
	const electronPkg = path.join(ROOT, 'node_modules', 'electron', 'path.txt')
	if (fs.existsSync(electronPkg)) {
		const relative = fs.readFileSync(electronPkg, 'utf8').trim()
		return path.join(ROOT, 'node_modules', 'electron', 'dist', relative)
	}
	// 退路：pnpm 的 .pnpm 目录
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
		'electron.exe',
	)
}

async function main() {
	fs.mkdirSync(OUTPUT, { recursive: true })

	const binary = electronBinary()
	console.log('=== BBPlayer Desktop 自动化验证 ===\n')
	console.log(`Electron: ${binary}`)
	console.log(`若文件不存在: ${fs.existsSync(binary)}\n`)

	if (!fs.existsSync(binary)) {
		console.error(
			'✗ Electron 二进制不存在，请先执行下载（见 apps/desktop/README）',
		)
		process.exit(1)
	}

	console.log('启动 Electron（探针模式）…\n')

	const child = spawn(binary, ['.', '--probe'], {
		cwd: DESKTOP,
		env: { ...process.env, BBPLAYER_PROBE_DRIVER: PROBE_DRIVER },
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

	const exitCode = await new Promise((resolve) => {
		// settled 守卫：超时与 exit 可能都触发，避免 Promise 被 resolve 两次
		// （后者是静默失效的，会让超时判定形同虚设）
		let settled = false
		const settle = (value) => {
			if (settled) return
			settled = true
			resolve(value)
		}

		const timer = setTimeout(() => {
			console.error('\n⚠ 超时（180s），强制结束 Electron')
			child.kill()
			settle('timeout')
		}, 180_000)

		child.on('exit', (code) => {
			clearTimeout(timer)
			settle(code)
		})
	})

	console.log('--- Electron stdout ---')
	console.log(stdout.trim() || '(空)')
	if (stderr.trim()) {
		console.log('--- Electron stderr ---')
		console.log(stderr.trim())
	}

	// 读取探针写出的报告
	if (fs.existsSync(RESULT_FILE)) {
		const report = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'))
		console.log('\n--- 探针报告 ---')
		for (const item of report.checks ?? []) {
			record(item.name, item.ok, item.detail)
		}
		if (report.screenshots?.length) {
			console.log('\n截图：')
			for (const file of report.screenshots) {
				console.log(`  ${file}`)
			}
		}
		if (report.summary) {
			console.log('\n--- 播放摘要 ---')
			console.log(JSON.stringify(report.summary, null, 2))
		}
	} else {
		record('探针产出报告文件', false, `未找到 ${RESULT_FILE}`)
	}

	console.log(`\n${'='.repeat(60)}`)
	console.log(
		`通过 ${RESULTS.length - failures} 项，失败 ${failures} 项（electron exit=${exitCode}）`,
	)
	console.log('='.repeat(60))

	process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
