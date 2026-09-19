/* oxlint-disable no-console -- 验证脚本，以 stdout 输出 */
/**
 * Phase 2 验收：三栏 shell + 音乐库 + 搜索 + 队列 + 快捷键。
 *
 * 用 Electron 的 `executeJavaScript` 驱动渲染进程做**点击级**操作
 * （点真实按钮、派发真实键盘事件），而不是只调内部函数；同时截图供多模态核对。
 *
 * 覆盖：
 *  1. 三栏 shell 渲染（左/中/右/底 + 状态栏）
 *  2. 空库欢迎视图 → 点「导入示例合集」→ 歌单与曲目落库并能列出
 *  3. 点曲目行的「播放全部」→ 真的开始播放
 *  4. 搜索框输入 + 点搜索 → 结果列表
 *  5. 快捷键：Space 暂停/播放、←/→ 快进退、Ctrl+Q 切换面板
 *  6. 右栏队列随播放更新、歌词 tab 可切换
 *
 * 用法：node scripts/verify-desktop-ui.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')
const SHOT_DIR = path.join(DESKTOP, 'probe-output', 'ui-shots')

/** 用独立的临时数据目录，避免污染真实库，也保证「空库」起点 */
const DATA_DIR = path.join(os.tmpdir(), `bbplayer-ui-${Date.now()}`)
fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(SHOT_DIR, { recursive: true })

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
		'electron.exe',
	)
}

function main() {
	const binary = electronBinary()
	console.log('=== Phase 2 验收：桌面 UI ===\n')
	console.log(`数据目录: ${DATA_DIR}`)
	console.log(`截图目录: ${SHOT_DIR}\n`)

	// 探针驱动复用 `--probe` 通道，但由 ui-probe-driver 执行 UI 序列
	const child = spawn(binary, ['.', '--ui-probe'], {
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
			/*
			 * ⚠️ 正常一轮约 80 秒；这里的上限留得比它宽得多。
			 *
			 * 这套断言里夹着**真实网络**等待（导入示例合集、搜索、歌词匹配），
			 * B 站限流时会显著变慢 —— 上限太紧就会出现"跑到一半被砍、
			 * 打印上一次的报告"这种**看不出是超时**的失败。
			 * 超时的意义是"卡死了要说一声"，不是"跑得久就判死"。
			 */
			console.error('\n⚠ 超时（480s），强制结束')
			child.kill()
			settle('timeout')
		}, 480_000)
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

		const reportPath = path.join(DESKTOP, 'probe-output', 'ui-report.json')
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
