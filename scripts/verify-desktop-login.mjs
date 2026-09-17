/* oxlint-disable no-console -- 验证脚本，以 stdout 输出 */
/**
 * Phase 3 验收：登录（扫码 / 密码 / 粘贴 Cookie）+ 收藏夹同步。
 *
 * 用 Electron 的 `executeJavaScript` 驱动渲染进程做**点击级**操作，
 * 并截图供多模态核对。断言序列在 `apps/desktop/src/login-probe-driver.cjs`。
 *
 * 用法：
 *   node scripts/verify-desktop-login.mjs
 *
 * 可选：设置 `BILIBILI_TEST_COOKIE` 后，探针会额外验证「真实登录后的行为」
 * （音质升级、私密收藏夹）。未设置时这几项被记为**待人工验证**而不是通过 ——
 * 扫码登录的最后一跳只有真人能做，不能拿假数据冒充。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')
const SHOT_DIR = path.join(DESKTOP, 'probe-output', 'login-shots')

/** 独立临时数据目录：保证「未登录」起点，也不污染真实数据 */
const DATA_DIR = path.join(os.tmpdir(), `bbplayer-login-${Date.now()}`)
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
	console.log('=== Phase 3 验收：登录 + 收藏夹 ===\n')
	console.log(`数据目录: ${DATA_DIR}`)
	console.log(`截图目录: ${SHOT_DIR}`)
	console.log(
		`真实凭据: ${process.env.BILIBILI_TEST_COOKIE ? '已提供（将验证登录后行为）' : '未提供（相关项记为待人工验证）'}\n`,
	)

	const child = spawn(binary, ['.', '--login-probe'], {
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

		const reportPath = path.join(DESKTOP, 'probe-output', 'login-report.json')
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

		// 待人工验证项：**不计入通过，也不计入失败**，但必须显式列出，
		// 否则「0 失败」会被误读成「功能已完整验证」。
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

// 显式 void：脚本入口的浮动 Promise（内部已处理错误）
void main()
