/* oxlint-disable no-console -- 构建脚本，以 stdout 输出 */
/**
 * 把 `packages/core` 与 `packages/splash` 的 TS/ESM 源码打成 **CJS 单文件**，
 * 供打包后的 Electron 主进程直接 `require`。
 *
 * ## 为什么必须打 bundle
 *
 * 开发期 `core-loader.cjs` 用 jiti 按**相对路径**加载 `packages/core/src/index.ts`
 * —— 因为 core 是 TS + 无扩展名 ESM import，`require()` 直接吃不下。
 * 但打包后目录结构变了：`__dirname` 是 `resources/app.asar/src`，
 * `../../../packages/core` 会指到 asar 外面，源码根本不在那里。
 *
 * 因此生产路径改为：**构建期把 core 打成一个 CJS 文件**，随应用一起分发。
 * `core-loader.cjs` 会优先用 bundle，找不到才退回「源码 + jiti」（开发期）。
 *
 * ## 为什么不用 jiti 直接跑 bundle
 *
 * 也不需要 —— esbuild 输出的就是普通 CJS，`require()` 即可，
 * 生产环境少一个运行时编译器（启动更快、体积更小）。
 *
 * 用法：node scripts/build-core.mjs
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')
const OUT_DIR = path.join(DESKTOP, 'build')

/** 待打包的入口：源文件 -> 输出文件名 */
const ENTRIES = [
	{
		label: 'core',
		input: path.join(ROOT, 'packages', 'core', 'src', 'index.ts'),
		output: path.join(OUT_DIR, 'core.cjs'),
	},
	{
		label: 'splash-merge',
		// 歌词解析器：core 刻意不依赖它，桌面端按绝对路径单独加载
		input: path.join(ROOT, 'packages', 'splash', 'src', 'parser', 'merge.ts'),
		output: path.join(OUT_DIR, 'splash-merge.cjs'),
	},
]

/** 取 esbuild 的可执行入口（用它的 JS API 更可控，避免命令行转义问题） */
function loadEsbuild() {
	try {
		return require('esbuild')
	} catch {
		// pnpm 下 esbuild 可能只在 desktop 的 node_modules 里
		const candidate = path.join(
			DESKTOP,
			'node_modules',
			'esbuild',
			'lib',
			'main.js',
		)
		if (fs.existsSync(candidate)) return require(candidate)
		throw new Error(
			'找不到 esbuild。请在 apps/desktop 下安装：pnpm --filter @bbplayer/desktop add -D esbuild',
		)
	}
}

async function main() {
	const esbuild = loadEsbuild()
	fs.mkdirSync(OUT_DIR, { recursive: true })

	console.log('=== 打包 core / splash 为 CJS ===\n')
	console.log(`输出目录：${OUT_DIR}\n`)

	const results = []

	for (const entry of ENTRIES) {
		if (!fs.existsSync(entry.input)) {
			throw new Error(`找不到入口文件：${entry.input}`)
		}

		const started = Date.now()
		const result = await esbuild.build({
			entryPoints: [entry.input],
			outfile: entry.output,
			// 主进程是 CJS，所以产物也必须是 CJS（不能是 ESM —— 打包后的
			// Electron 主进程用 require 加载它）
			format: 'cjs',
			platform: 'node',
			target: 'node22',
			bundle: true,
			// core 的依赖都是纯 JS，整体打进来，运行时不需要 node_modules
			packages: 'bundle',
			// `node:` 前缀的内置模块必须保持外部，不能被打包
			external: ['node:*'],
			// 产物要给打包器读，压缩能显著减小体积；保留可读性靠 sourcemap 之外的
			// 注释（esbuild 的 legalComments 默认为 eof，已足够）
			minify: true,
			// 生成 sourcemap，线上出问题时能定位到 TS 源码
			sourcemap: 'linked',
			logLevel: 'warning',
			metafile: true,
		})

		const bytes = fs.statSync(entry.output).size
		const inputs = Object.keys(result.metafile.inputs).length
		results.push({ ...entry, bytes, inputs, ms: Date.now() - started })
		console.log(
			`  ✓ ${entry.label}: ${inputs} 个输入 -> ${path.basename(entry.output)}` +
				`（${(bytes / 1024).toFixed(1)} KB，${Date.now() - started} ms）`,
		)
	}

	// 产物必须能被 require —— 只写文件不验证等于没验证
	console.log('\n=== 验证产物可加载 ===\n')
	for (const entry of results) {
		const check = execFileSync(
			process.execPath,
			[
				'-e',
				`const m = require(${JSON.stringify(entry.output)}); console.log(JSON.stringify({ keys: Object.keys(m).length }))`,
			],
			{ encoding: 'utf8' },
		)
		const parsed = JSON.parse(check.trim())
		if (parsed.keys === 0) {
			throw new Error(`${entry.label} 的产物导出为空，bundle 可能有问题`)
		}
		console.log(`  ✓ ${entry.label}: 可 require，导出 ${parsed.keys} 个成员`)
	}

	// 写一份清单，便于打包配置与验证脚本引用
	const manifest = {
		builtAt: new Date().toISOString(),
		entries: results.map((entry) => ({
			label: entry.label,
			output: path.relative(DESKTOP, entry.output),
			bytes: entry.bytes,
			inputs: entry.inputs,
		})),
	}
	fs.writeFileSync(
		path.join(OUT_DIR, 'bundle-manifest.json'),
		JSON.stringify(manifest, null, 2),
	)

	console.log(
		`\n总大小：${(results.reduce((sum, r) => sum + r.bytes, 0) / 1024).toFixed(1)} KB`,
	)
}

// 显式 void：脚本入口的浮动 Promise（内部已由 catch 处理）
main().catch((error) => {
	console.error(`\n✗ 打包失败：${error.message}`)
	process.exit(1)
})
