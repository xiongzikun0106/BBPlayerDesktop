/* oxlint-disable no-console -- 验证脚本，以 stdout 输出 */
/**
 * Phase 4.1 验收：独立歌词窗口（MediaSession / 任务栏缩略图 / 媒体键兜底）。
 *
 * 断言序列在 `apps/desktop/src/media-probe-driver.cjs`。
 *
 * 用法：node scripts/verify-desktop-lyrics-window.mjs
 *
 * 说明：`navigator.mediaSession` 的**系统侧呈现**（Windows 的 SMTC 面板、
 * Linux 的 MPRIS）无法从应用内部断言 —— 那需要看操作系统 UI。本脚本断言的是
 * 应用**交给系统**的那份数据（标题/作者/封面/播放状态/进度）以及主进程侧的
 * 任务栏按钮与图标，这些是可自动化的部分。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')
const SHOT_DIR = path.join(DESKTOP, 'probe-output', 'lyrics-window-shots')

const DATA_DIR = path.join(os.tmpdir(), `bbplayer-media-${Date.now()}`)
fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(SHOT_DIR, { recursive: true })

function electronBinary() {
	const pnpmDir = path.join(ROOT, 'node_modules', '.pnpm')
	const match = fs
		.readdirSync(pnpmDir)
		.find((name) => name.startsWith('electron@'))
	if (!match) throw new Error('找不到 electron 包')
	const exe = path.join(
		pnpmDir,
		match,
		'node_modules',
		'electron',
		'dist',
		process.platform === 'win32' ? 'electron.exe' : 'electron',
	)
	if (!fs.existsSync(exe)) throw new Error(`找不到 electron 可执行文件: ${exe}`)
	return exe
}

function main() {
	const binary = electronBinary()
	console.log('=== Phase 4.1 验收：独立歌词窗口 ===\n')
	console.log(`数据目录: ${DATA_DIR}`)
	console.log(`截图目录: ${SHOT_DIR}`)
	console.log(`平台: ${process.platform}\n`)

	const child = spawn(binary, ['.', '--lyrics-probe'], {
		cwd: DESKTOP,
		env: {
			...process.env,
			BBPLAYER_DATA_DIR: DATA_DIR,
			BBPLAYER_UI_SHOTS: SHOT_DIR,
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
			console.error('\n⚠ 超时（420s），强制结束')
			child.kill()
			settle('timeout')
		}, 420_000)
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

		const reportPath = path.join(
			DESKTOP,
			'probe-output',
			'lyrics-window-report.json',
		)
		if (!fs.existsSync(reportPath)) {
			console.error(`\n✗ 未产出报告: ${reportPath}`)
			process.exit(1)
		}

		const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
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

		if (report.screenshots?.length) {
			console.log('\n截图：')
			for (const file of report.screenshots) console.log(`  ${file}`)
		}

		console.log(`\n${'='.repeat(56)}`)
		console.log(
			`通过 ${report.checks.length - failed} 项，失败 ${failed} 项（electron exit=${code}）`,
		)
		console.log('='.repeat(56))
		process.exit(failed === 0 ? 0 : 1)
	})
}

// 显式 void：脚本入口的浮动 Promise（内部已处理错误）
void main()
