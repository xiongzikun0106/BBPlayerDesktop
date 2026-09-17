/* oxlint-disable no-console -- 自检脚本，以 stdout 输出 */
/**
 * 打包产物自检（`--selfcheck`）。
 *
 * 用途：**在没有 GUI 的 Linux VPS 上验证打包产物能跑**，也是 Windows 上
 * 「产物能不能用」的第一道关卡。输出一段 JSON 摘要，供外层脚本断言。
 *
 * ## 为什么单独做这个模式，而不是复用 `--probe`
 *
 * `--probe` 是「点击级播放验收」，需要窗口、媒体解码、真实 CDN —— 在
 * headless Linux（无 X、无音频设备）上跑不起来，而且它验证的是**功能**，
 * 不是「**这个打包产物**是否自洽」。
 *
 * 本模式验证的是打包特有的失败模式，这些在开发目录里永远测不出来：
 *   1. **core 是从 bundle 还是从源码加载的** —— 打包后源码不在 asar 里
 *      （实测确认 `/packages/` 不存在），若 loader 走错路会直接崩；
 *   2. **`drizzle/` 迁移文件是否随包分发** —— 少了它建库就失败；
 *   3. **`userData` 可写** —— asar 内只读，数据库必须落在 userData；
 *   4. **bundle 里的 core 真的能注册端口并被调用**（不是「能 require」而已）；
 *   5. **`bbProbe` 的暴露开关生效** —— 正常启动不该暴露。
 *
 * 刻意**不依赖网络**：VPS 上可能没有外网，而「产物自洽」与「能连 B 站」
 * 是两件事，混在一起会让失败原因不可辨。
 */
const path = require('node:path')
const fs = require('node:fs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function run(window, { app }) {
	const out = {
		ok: false,
		platform: process.platform,
		arch: process.arch,
		electron: process.versions.electron,
		node: process.versions.node,
		chrome: process.versions.chrome,
		isPackaged: app.isPackaged,
		appPath: app.getAppPath(),
		userData: app.getPath('userData'),
		checks: {},
		failures: [],
	}

	const record = (name, ok, detail) => {
		out.checks[name] = { ok: Boolean(ok), detail: detail ?? null }
		if (!ok) out.failures.push(`${name}: ${detail ?? '失败'}`)
	}

	try {
		// ---------- 1. core 的加载路径 ----------
		const { describeLoader } = require('./core-loader.cjs')
		const loader = describeLoader()
		out.loader = loader
		// 打包后**必须**走 bundle：源码在 asar 里不存在
		record(
			'core 从 bundle 加载（打包后源码不在包内）',
			out.isPackaged ? !loader.coreSourceExists : true,
			`coreSourceExists=${loader.coreSourceExists} coreBundleExists=${loader.coreBundleExists}`,
		)
		record('核心 bundle 存在', loader.coreBundleExists, loader.coreBundle)
		record(
			'歌词解析 bundle 存在',
			loader.splashBundleExists,
			loader.splashBundle,
		)

		// ---------- 2. core 真的可用（不只是能 require）----------
		const { core } = require('./ports.cjs')
		record(
			'core 导出了端口注册函数',
			typeof core.registerCorePorts === 'function' &&
				typeof core.getCorePorts === 'function',
		)
		record(
			'bundle 里的 core 导出规模合理（> 50）',
			Object.keys(core).length > 50,
			`${Object.keys(core).length} 个导出`,
		)

		// 端口必须真的注册成功（bundle 与源码是两份模块实例，这里是关键回归点）
		let portsOk = false
		let portsDetail = null
		try {
			const ports = core.getCorePorts()
			portsOk = Boolean(ports?.logger && ports?.db && ports?.bilibili)
			portsDetail = Object.keys(ports ?? {}).join(', ')
		} catch (error) {
			portsDetail = error.message
		}
		record('端口已注册且可读取', portsOk, portsDetail)

		// ---------- 3. 迁移文件随包分发 + 建库成功 ----------
		const {
			runMigrations,
			listTables,
			BASELINE_MIGRATION,
		} = require('./db.cjs')
		const migration = runMigrations()
		const tables = listTables()
		record(
			'迁移可运行（drizzle/ 已随包分发）',
			Array.isArray(tables) && tables.length >= 9,
			`建出 ${tables.length} 张表；本次执行 ${migration.executed.length} 个迁移`,
		)
		record(
			'基线迁移文件名正确',
			typeof BASELINE_MIGRATION === 'string' &&
				BASELINE_MIGRATION.endsWith('.sql'),
			BASELINE_MIGRATION,
		)
		record(
			'迁移记录已落库（表结构可用）',
			tables.includes('playlists') &&
				tables.includes('tracks') &&
				tables.includes('bilibili_metadata'),
			tables.join(', '),
		)

		// ---------- 4. userData 可写（asar 内只读，数据库必须落在这里）----------
		const probeFile = path.join(out.userData, 'selfcheck-write-test.txt')
		let writable = false
		let writeError = null
		try {
			fs.writeFileSync(probeFile, 'ok')
			writable = fs.readFileSync(probeFile, 'utf8') === 'ok'
			fs.unlinkSync(probeFile)
		} catch (error) {
			writeError = error.message
		}
		record('userData 可写', writable, writeError ?? out.userData)
		// 数据库必须落在 userData 而不是 asar
		const dbFile = path.join(out.userData, 'bbplayer.db')
		record('数据库落在 userData 下', fs.existsSync(dbFile), dbFile)

		// ---------- 5. 关键模块能加载（打包后路径变化最容易断的地方）----------
		const modules = {}
		for (const name of [
			'./bilibili-api.cjs',
			'./bilibili-login.cjs',
			'./download.cjs',
			'./backup.cjs',
			'./backup-webdav.cjs',
			'./media-integration.cjs',
			'./settings.cjs',
		]) {
			try {
				const mod = require(name)
				modules[name] = Object.keys(mod).length
			} catch (error) {
				modules[name] = `ERROR: ${error.message}`
			}
		}
		out.modules = modules
		const moduleFailures = Object.entries(modules).filter(([, v]) =>
			String(v).startsWith('ERROR'),
		)
		record(
			'运行时模块全部可加载',
			moduleFailures.length === 0,
			moduleFailures.length === 0
				? Object.keys(modules).length + ' 个'
				: moduleFailures.map(([k, v]) => `${k}: ${v}`).join(' | '),
		)

		// ---------- 6. 渲染进程：窗口与 preload 契约 ----------
		if (window) {
			const renderer = await window.webContents.executeJavaScript(
				`(() => ({
					ready: Boolean(window.__bbReady),
					hasBbplayer: typeof window.bbplayer,
					hasBbProbe: typeof window.bbProbe,
					hasSettings: typeof window.bbplayer?.settings,
					hasDownload: typeof window.bbplayer?.download,
					hasBackup: typeof window.bbplayer?.backup,
					hasShare: typeof window.bbplayer?.share,
					hasPlaylist: typeof window.bbplayer?.playlist,
					hasExternalImport: typeof window.bbplayer?.externalImport,
					theme: document.documentElement.getAttribute('data-theme'),
					title: document.title,
					bodyLength: document.body.innerHTML.length,
				}))()`,
				true,
			)
			out.renderer = renderer
			record('渲染进程就绪', renderer.ready)
			// 逐个列出来断言，不进「都行」的兜底判断里 ——
			// 少一个桥就是打包后某个功能**整块消失**，必须指名道姓地失败。
			record(
				'preload 契约完整（settings/download/backup/share/playlist/externalImport 都在）',
				renderer.hasSettings === 'object' &&
					renderer.hasDownload === 'object' &&
					renderer.hasBackup === 'object' &&
					renderer.hasShare === 'object' &&
					renderer.hasPlaylist === 'object' &&
					renderer.hasExternalImport === 'object',
				JSON.stringify({
					settings: renderer.hasSettings,
					download: renderer.hasDownload,
					backup: renderer.hasBackup,
					share: renderer.hasShare,
					playlist: renderer.hasPlaylist,
					externalImport: renderer.hasExternalImport,
				}),
			)
			record(
				'界面已渲染出内容',
				renderer.bodyLength > 1000,
				`${renderer.bodyLength} 字节`,
			)
			record(
				'主题已应用',
				renderer.theme === 'dark' || renderer.theme === 'light',
				renderer.theme,
			)
			// 自检模式本身属于探针模式，所以 bbProbe **应该**存在
			record(
				'自检模式下 bbProbe 已暴露（探针依赖它）',
				renderer.hasBbProbe === 'object',
				renderer.hasBbProbe,
			)
		} else {
			// headless（无窗口）下渲染进程那几项**不适用**，记为「跳过」而不是失败 ——
			// 否则 VPS 上的自检永远红着，红久了就没人看了。
			out.skipped = [
				'渲染进程就绪',
				'preload 契约完整',
				'界面已渲染出内容',
				'主题已应用',
				'bbProbe 暴露',
			]
			out.checks['渲染进程检查'] = {
				ok: true,
				detail: 'headless 模式：无窗口，渲染进程相关断言已跳过',
			}
		}

		out.ok = out.failures.length === 0
	} catch (error) {
		out.failures.push(`自检抛错：${error.message}`)
		out.stack = String(error.stack ?? '')
			.split('\n')
			.slice(0, 8)
		out.ok = false
	}

	return out
}

module.exports = { run, sleep }
