/**
 * `packages/core` 与 `packages/splash` 的加载器。
 *
 * ## 两条路径，优先 bundle
 *
 * **生产（打包后）**：`build/core.cjs` —— 构建期用 esbuild 打成的 CJS 单文件
 * （见 `scripts/build-core.mjs`）。直接 `require`，不需要运行时编译器。
 *
 * **开发**：jiti 按绝对路径加载源码。因为 core 是 **TypeScript + ESM**，
 * 而 Electron 主进程是 **CJS**，`require()` 既不能解析 `.ts` 也不能解析 core
 * 内部的无扩展名 ESM import，所以必须有 jiti。
 *
 * ⚠️ 打包后源码路径**必然**失效：`__dirname` 变成
 * `resources/app.asar/src`，`../../../packages/core` 指向 asar 外面。
 * 所以判断「用哪条路」的依据是**文件是否存在**，而不是 `app.isPackaged`
 * —— 后者在 `--probe` 等自定义启动方式下不一定可靠，而文件存在与否是硬事实。
 *
 * 注意：**不要**通过包名 `@bbplayer/core` 去 require —— pnpm 把它软链到
 * `node_modules`，而 jiti 默认不处理 node_modules 内的 TS。这里始终用绝对路径。
 */
const path = require('node:path')
const fs = require('node:fs')

/** 构建产物（打包后使用） */
const BUILD_DIR = path.resolve(__dirname, '..', 'build')
const CORE_BUNDLE = path.join(BUILD_DIR, 'core.cjs')
const SPLASH_BUNDLE = path.join(BUILD_DIR, 'splash-merge.cjs')

/** 源码（开发时使用） */
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
const SPLASH_MERGE_ENTRY = path.resolve(
	__dirname,
	'..',
	'..',
	'..',
	'packages',
	'splash',
	'src',
	'parser',
	'merge.ts',
)

/**
 * 懒加载 jiti。
 *
 * 放在函数里而不是模块顶部：生产路径用不到它，而 `jiti` 在打包产物里
 * 可能被移到 devDependencies（见 package.json 的说明）。顶部 require 会让
 * 生产启动直接崩，即使 bundle 明明可用。
 */
let jitiInstance = null

function getJiti() {
	if (jitiInstance) return jitiInstance
	let createJiti
	try {
		;({ createJiti } = require('jiti'))
	} catch (error) {
		throw new Error(
			'既没有可用的 bundle，也加载不到 jiti。\n' +
				`  bundle 路径：${CORE_BUNDLE}\n` +
				'  解决方式：跑 `node apps/desktop/scripts/build-core.mjs` 生成 bundle，\n' +
				'  或在 apps/desktop 下安装 jiti（pnpm --filter @bbplayer/desktop add jiti）。\n' +
				`  原始错误：${error.message}`,
			{ cause: error },
		)
	}

	jitiInstance = createJiti(__filename, {
		interopDefault: true,
		// 必须开启模块缓存：core 内部用模块级变量保存端口注册状态
		// （`registerCorePorts` / `getCorePorts`）。若每次加载都是新实例，
		// 注册与取用会落在不同实例上，表现为「端口尚未注册」。
		moduleCache: true,
		fsCache: false,
	})
	return jitiInstance
}

let cached = null
let loadedFrom = null

/** 载入 core（带缓存）。优先 bundle，找不到才用源码 + jiti */
function loadCore() {
	if (cached) return cached

	if (fs.existsSync(CORE_BUNDLE)) {
		// 生产路径：普通 CJS，直接 require
		cached = require(CORE_BUNDLE)
		loadedFrom = 'bundle'
		return cached
	}

	if (!fs.existsSync(CORE_ENTRY)) {
		throw new Error(
			`既没有 bundle 也没有源码：\n  bundle: ${CORE_BUNDLE}\n  源码:   ${CORE_ENTRY}\n` +
				'若这是打包后的产物，说明构建时忘了跑 scripts/build-core.mjs。',
		)
	}
	cached = getJiti()(CORE_ENTRY)
	loadedFrom = 'source'
	return cached
}

/**
 * 用同一个加载策略加载任意 TS/ESM 文件。
 *
 * 目前只有一个调用点（歌词解析器）。传入 splash 的源码路径时，
 * 如果有对应的 bundle 就优先用它 —— 否则打包后会因为找不到源码而失败。
 */
function loadTsFile(absolutePath) {
	// splash 的歌词解析器有专门的 bundle
	if (path.resolve(absolutePath) === SPLASH_MERGE_ENTRY) {
		if (fs.existsSync(SPLASH_BUNDLE)) return require(SPLASH_BUNDLE)
	}

	if (!fs.existsSync(absolutePath)) {
		throw new Error(
			`找不到模块：${absolutePath}\n` +
				'（打包后请确认已跑 scripts/build-core.mjs，且该模块在 ENTRIES 列表里）',
		)
	}
	return getJiti()(absolutePath)
}

/** 诊断：当前用的是哪条加载路径（验证脚本会断言打包产物走 bundle） */
function describeLoader() {
	return {
		loadedFrom,
		coreBundle: CORE_BUNDLE,
		coreBundleExists: fs.existsSync(CORE_BUNDLE),
		splashBundle: SPLASH_BUNDLE,
		splashBundleExists: fs.existsSync(SPLASH_BUNDLE),
		coreSource: CORE_ENTRY,
		coreSourceExists: fs.existsSync(CORE_ENTRY),
		jitiLoaded: Boolean(jitiInstance),
	}
}

module.exports = {
	loadCore,
	loadTsFile,
	describeLoader,
	CORE_ENTRY,
	CORE_BUNDLE,
	SPLASH_BUNDLE,
}
