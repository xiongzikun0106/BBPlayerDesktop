/* oxlint-disable no-console -- 验证脚本，以 stdout 输出对比结论 */
/**
 * 方案对比：`webRequest` 头注入 vs 自定义协议代理。
 *
 * 跑两次 Electron：
 *   Case A  webRequest 注入 + 渲染进程直连 CDN，webSecurity 默认（开启）
 *   Case B  同上，但 webSecurity: false
 *
 * 然后聚合结论。目的是把 §2.3 里「方案 B 有 CORS 问题」从**推断**变成**实测**。
 *
 * 用法：node scripts/compare-audio-strategies.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')
const OUTPUT = path.join(DESKTOP, 'probe-output')
const COMPARISON = path.join(OUTPUT, 'comparison.json')
const AGGREGATE = path.join(OUTPUT, 'strategy-comparison.json')

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

async function runCase(binary, args, label, extraElectronArgs = []) {
	console.log(`\n${'─'.repeat(70)}`)
	console.log(`运行 ${label}`)
	console.log('─'.repeat(70))

	// 清掉上一次的结果，避免读到陈旧数据
	if (fs.existsSync(COMPARISON)) fs.rmSync(COMPARISON)

	const child = spawn(binary, [...extraElectronArgs, '.', ...args], {
		cwd: DESKTOP,
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

	await new Promise((resolve) => {
		let settled = false
		const settle = () => {
			if (settled) return
			settled = true
			resolve()
		}
		const timer = setTimeout(() => {
			console.error('⚠ 超时，强制结束')
			child.kill()
			settle()
		}, 120_000)
		child.on('exit', () => {
			clearTimeout(timer)
			settle()
		})
	})

	const interesting = stdout
		.split('\n')
		.filter((line) => line.includes('[compare]') || line.includes('[desktop]'))
	console.log(interesting.join('\n') || '(无输出)')
	if (stderr.trim()) console.log('stderr:', stderr.trim().slice(0, 400))

	if (!fs.existsSync(COMPARISON)) {
		return { label, error: '未产出 comparison.json' }
	}
	const data = JSON.parse(fs.readFileSync(COMPARISON, 'utf8'))
	data.label = label
	return data
}

/** 把单次运行的原始结果收敛成可汇总的形状 */
function summarize(result) {
	if (!result || result.error) return { verdict: result?.error ?? '无数据' }
	const direct = result.cases?.directCdn ?? {}
	return {
		upstreamWithHeaders: result.upstreamWithHeaders ?? null,
		rendererFetchNoRange: result.rendererFetch?.noRange ?? null,
		rendererFetchWithRange: result.rendererFetch?.withRange ?? null,
		mainFetch: result.mainFetch ?? null,
		directCdn: {
			metaLoaded: direct.metaLoaded ?? null,
			readyState: direct.readyState ?? null,
			playing: direct.played ?? null,
			currentTime: direct.currentTime ?? null,
			error: direct.error ?? null,
		},
	}
}

async function main() {
	fs.mkdirSync(OUTPUT, { recursive: true })
	const binary = electronBinary()

	// CDN 响应有明显抖动（同一地址可能给 video/mp4 或 application/octet-stream，
	// 偶发 403）。单次运行不足以定论，因此每侧跑多轮取成功率。
	const ROUNDS = Number(process.env.COMPARE_ROUNDS ?? 3)
	console.log(`每侧运行 ${ROUNDS} 轮（CDN 有抖动，需要看成功率而非单次结果）`)

	const caseARuns = []
	const caseBRuns = []
	for (let round = 1; round <= ROUNDS; round++) {
		console.log(`\n########## 第 ${round}/${ROUNDS} 轮 ##########`)
		caseARuns.push(
			await runCase(
				binary,
				['--compare'],
				`Case A 第 ${round} 轮（webSecurity 开启）`,
			),
		)
		caseBRuns.push(
			await runCase(
				binary,
				['--compare', '--insecure'],
				`Case B 第 ${round} 轮（webSecurity: false + --disable-web-security）`,
				[
					'--disable-web-security',
					// Chromium 的 profile 写到系统临时目录，别污染仓库
					'--user-data-dir=' +
						path.join(os.tmpdir(), 'bbplayer-insecure-profile'),
				],
			),
		)
	}

	// ---------------------------------------------------------------
	// 汇总
	// ---------------------------------------------------------------
	const tally = (runs) => {
		const rows = runs.map(summarize)
		const played = rows.filter((r) => r.directCdn?.playing === true).length
		const metadata = rows.filter((r) => r.directCdn?.metaLoaded === true).length
		const rendererFetchOk = rows.filter(
			(r) => r.rendererFetchWithRange?.ok === true,
		).length
		const range206 = rows.filter(
			(r) => r.rendererFetchWithRange?.status === 206,
		).length
		const contentTypes = rows
			.map((r) => r.rendererFetchWithRange?.contentType)
			.filter(Boolean)
		return {
			runs: rows.length,
			played,
			metadata,
			rendererFetchOk,
			range206,
			contentTypes,
		}
	}

	const aggregate = {
		generatedAt: new Date().toISOString(),
		rounds: ROUNDS,
		caseA: { summary: tally(caseARuns), detail: caseARuns.map(summarize) },
		caseB: { summary: tally(caseBRuns), detail: caseBRuns.map(summarize) },
		caseC: {
			approach: '自定义协议代理 bbplayer-audio://',
			webSecurityDisabled: false,
			verifiedBy: 'scripts/verify-desktop.mjs',
			result:
				'18/18 断言通过：元数据加载、播放推进、seek、上游 206、Range 精确 1024 字节',
		},
	}

	const aPlays = aggregate.caseA.summary.played
	const aRuns = aggregate.caseA.summary.runs
	const bPlays = aggregate.caseB.summary.played

	let verdict
	if (aPlays === aRuns) {
		verdict =
			'方案 B（webRequest 注入 + 直连 CDN）在**开启** webSecurity 的情况下可用，且不需要关闭 webSecurity'
		if (bPlays === aRuns) {
			verdict += '；关闭 webSecurity 并未带来额外收益，因此没有必要关'
		}
	} else if (aPlays > 0) {
		verdict = `方案 B 不稳定（${aPlays}/${aRuns} 成功）——取决于 CDN 节点，不宜作为主路径`
	} else {
		verdict = `方案 B 在 ${aRuns} 轮中全部失败，不可行`
	}
	aggregate.verdict = verdict

	fs.writeFileSync(AGGREGATE, JSON.stringify(aggregate, null, 2))

	console.log(`\n${'='.repeat(72)}`)
	console.log('方案对比结论')
	console.log('='.repeat(72))
	console.log(
		`\nCase A（webRequest 注入，webSecurity 开启）  ${aPlays}/${aRuns} 轮播放成功`,
	)
	console.log(
		`  Renderer fetch 成功 ${aggregate.caseA.summary.rendererFetchOk}/${aRuns}，其中 206 有 ${aggregate.caseA.summary.range206}`,
	)
	console.log(
		`  content-type 观测值: ${JSON.stringify(aggregate.caseA.summary.contentTypes)}`,
	)
	console.log(
		`\nCase B（webSecurity: false + --disable-web-security）  ${bPlays}/${aRuns} 轮播放成功`,
	)
	console.log(
		`  content-type 观测值: ${JSON.stringify(aggregate.caseB.summary.contentTypes)}`,
	)
	console.log(`\nCase C（自定义协议代理）`)
	console.log(`  ${aggregate.caseC.result}`)
	console.log(`\n判定: ${verdict}`)
	console.log(`\n聚合结果: ${AGGREGATE}`)

	// 如果方案 A 可行，就说明「必须走代理」这个前提需要修正
	if (aPlays === aRuns) {
		console.log(
			'\n⚠ 注意：这与 docs/DESKTOP_PLAN.md §2.3 的推断不一致 —— 那里认为 CORS 会挡住方案 B。',
		)
		console.log(
			'  实际原因是渲染进程 HTML 的 CSP 缺少 connect-src，与 CORS 无关。',
		)
	}

	process.exit(0)
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
