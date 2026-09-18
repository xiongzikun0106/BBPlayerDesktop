/* oxlint-disable no-console -- 巡检脚本，以 stdout 输出 */
/**
 * UI 截图巡检：把桌面端**每一个视图、每一个弹窗、每一个空状态**都截下来。
 *
 * 断言能证明「元素存在 / 颜色一致 / 尺寸正确」，但证明不了「好不好看」——
 * 第一版界面被否掉的正是后者：断言全绿，观感依然杂乱。
 * 这个脚本产出可逐张核对的截图，配 `--dark` 可跑深色。
 *
 * 用法：
 *   node scripts/capture-ui-tour.mjs           # 浅色
 *   node scripts/capture-ui-tour.mjs --dark    # 深色
 *   pnpm verify:desktop:tour                   # 两套都跑
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')
const OUT_ROOT = path.join(DESKTOP, 'probe-output', 'ui-tour')
const THEMES = process.argv.includes('--dark') ? ['dark'] : ['light']

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

function runTheme(binary, theme) {
	return new Promise((resolve) => {
		// 每套主题一个全新的数据目录：保证空库起点一致，也不会互相污染
		const dataDir = path.join(
			os.tmpdir(),
			`bbplayer-tour-${theme}-${Date.now()}`,
		)
		fs.mkdirSync(dataDir, { recursive: true })

		const args = ['.', '--ui-tour']
		if (theme === 'dark') args.push('--dark')

		const child = spawn(binary, args, {
			cwd: DESKTOP,
			env: {
				...process.env,
				BBPLAYER_DATA_DIR: dataDir,
				BBPLAYER_TOUR_DIR: OUT_ROOT,
				// 巡检比断言更慢（要等动画与网络），给足时间
				BBPLAYER_TOUR_TIMEOUT: '600000',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		})

		let stdout = ''
		child.stdout.on('data', (chunk) => {
			const text = String(chunk)
			stdout += text
			process.stdout.write(text)
		})
		child.stderr.on('data', (chunk) => process.stderr.write(chunk))

		// 上限 12 分钟：巡检包含真实的网络导入与歌词匹配
		const timer = setTimeout(() => {
			console.error(`\n⚠ ${theme} 巡检超时，强制结束`)
			child.kill('SIGKILL')
		}, 720_000)

		child.on('close', (code) => {
			clearTimeout(timer)
			const manifest = path.join(OUT_ROOT, theme, 'manifest.json')
			let count = 0
			let problems = []
			if (fs.existsSync(manifest)) {
				const data = JSON.parse(fs.readFileSync(manifest, 'utf8'))
				count = data.shots.length
				problems = data.problems ?? []
			}
			console.log(
				`\n[${theme}] 截图 ${count} 张，问题 ${problems.length} 条（exit=${code}）`,
			)
			for (const problem of problems) console.log(`  ⚠ ${problem}`)
			resolve({ theme, count, problems, code })
		})
	})
}

async function main() {
	const binary = electronBinary()
	if (!fs.existsSync(binary)) throw new Error(`找不到 electron：${binary}`)

	const results = []
	for (const theme of THEMES) {
		console.log(`\n════════ ${theme} ════════`)
		results.push(await runTheme(binary, theme))
	}

	const totalShots = results.reduce((sum, r) => sum + r.count, 0)
	const allProblems = results.flatMap((r) =>
		r.problems.map((p) => `${r.theme}: ${p}`),
	)
	console.log(`\n总计 ${totalShots} 张截图，${allProblems.length} 条问题`)
	console.log(`目录：${OUT_ROOT}`)
	// 有问题不代表截图失败，所以只在没截到图时判失败
	if (totalShots === 0) process.exit(1)
}

main().catch((error) => {
	console.error(`✗ ${error.message}`)
	process.exit(1)
})
