/**
 * `packages/core` 的加载器。
 *
 * 背景：core 是 **TypeScript + ESM**，而 Electron 主进程是 **CJS**，`require()`
 * 既不能解析 `.ts` 也不能解析 core 内部的无扩展名 ESM import。
 *
 * 解决方式：用 `jiti` 在运行时加载并编译 core。好处是不必为「运行开发版」引入
 * 打包步骤（Phase 5 打包时再走 esbuild bundle）。
 *
 * 注意：**不要**通过包名 `@bbplayer/core` 去 require —— pnpm 把它软链到
 * `node_modules`，而 jiti 默认不处理 node_modules 内的 TS。这里始终用绝对路径。
 */
const path = require('node:path')
const fs = require('node:fs')
const { createJiti } = require('jiti')

const CORE_ENTRY = path.resolve(
	__dirname,
	'..',
	'..',
	'..',
	'packages',
	'core',
	'src',
	'index.ts',
)

const jiti = createJiti(__filename, {
	interopDefault: true,
	// 必须开启模块缓存：core 内部用模块级变量保存端口注册状态
	// （`registerCorePorts` / `getCorePorts`）。若每次加载都是新实例，
	// 注册与取用会落在不同实例上，表现为「端口尚未注册」。
	moduleCache: true,
	fsCache: false,
})

let cached = null

/** 载入 core（带缓存） */
function loadCore() {
	if (cached) return cached
	if (!fs.existsSync(CORE_ENTRY)) {
		throw new Error(
			`[desktop] 找不到 packages/core 入口：${CORE_ENTRY}\n` +
				'若这是打包后的产物，说明 core 没有被打进 bundle。',
		)
	}
	cached = jiti(CORE_ENTRY)
	return cached
}

/**
 * 用同一个 jiti 实例加载任意 TS/ESM 文件。
 *
 * 用途：`packages/splash` 这类 core 未依赖的纯 TS 包（core 的依赖面刻意保持小），
 * 以及将来需要从 CJS 主进程引用的其他 TS 模块。
 * 复用同一实例可保证模块缓存一致（core 的端口注册依赖这一点）。
 */
function loadTsFile(absolutePath) {
	if (!fs.existsSync(absolutePath)) {
		throw new Error(`[desktop] 找不到模块：${absolutePath}`)
	}
	return jiti(absolutePath)
}

module.exports = { loadCore, loadTsFile, CORE_ENTRY }
