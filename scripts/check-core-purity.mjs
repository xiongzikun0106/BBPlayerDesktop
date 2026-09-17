/* oxlint-disable no-console -- 校验脚本，以 stdout 为输出 */
/**
 * 守卫 `packages/core` 的平台无关性。
 *
 * `tsconfig.json` 的 `"types": []` + `"lib": ["ES2023"]` 已经能在**类型层面**
 * 拦住绝大多数违规（因为 RN / Expo 的类型不会被加载）。但类型永远解析不到的
 * 裸包名（比如纯 JS 包、或声明为 `any` 的包）不会被拦住，所以再加一道源码扫描。
 *
 * 用法：node scripts/check-core-purity.mjs
 * 退出码 1 表示发现违规（供 CI 使用）。
 */
import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

const CORE_SRC = path.resolve('packages/core/src')

/** 禁止出现在 core 里的依赖（正则匹配模块说明符） */
const FORBIDDEN = [
	{ pattern: /^react$/, why: 'React 属于渲染层' },
	{ pattern: /^react-dom$/, why: 'React DOM 属于渲染层' },
	{ pattern: /^react-native$/, why: 'React Native 属于应用层' },
	{ pattern: /^react-native-/, why: 'React Native 生态属于应用层' },
	{ pattern: /^@react-native/, why: 'React Native 生态属于应用层' },
	{ pattern: /^@react-native-/, why: 'React Native 生态属于应用层' },
	{ pattern: /^expo$/, why: 'Expo 属于应用层' },
	{ pattern: /^expo-/, why: 'Expo 模块属于应用层' },
	{ pattern: /^@expo\//, why: 'Expo 模块属于应用层' },
	{ pattern: /^@sentry\/react-native$/, why: '移动端 SDK' },
	{ pattern: /^@bbplayer\/native$/, why: 'Android 原生模块' },
	{ pattern: /^@bbplayer\/orpheus$/, why: '原生播放引擎' },
	{ pattern: /^@shopify\/react-native-skia$/, why: '原生渲染' },
	{ pattern: /^@bottom-tabs\//, why: '原生 Tab 栏' },
	{ pattern: /^react-native-bottom-tabs$/, why: '原生 Tab 栏' },
	{ pattern: /^expo-wavy-slider$/, why: 'Android 原生滑块' },
	{ pattern: /^@legendapp\//, why: '移动端状态库' },
]

async function walk(dir) {
	const out = []
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) out.push(...(await walk(full)))
		else if (/\.tsx?$/.test(entry.name)) out.push(full)
	}
	return out
}

/** 提取所有 import/export 的模块说明符 */
function specifiersOf(code) {
	const found = []
	const re =
		/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[\s\S]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
	let m
	while ((m = re.exec(code)) !== null) {
		const spec = m[1] ?? m[2]
		if (spec && !spec.startsWith('.') && !spec.startsWith('@/'))
			found.push(spec)
	}
	return found
}

const files = await walk(CORE_SRC)
const violations = []

for (const file of files) {
	const code = readFileSync(file, 'utf8')
	for (const spec of specifiersOf(code)) {
		// 归一化到包名（去掉子路径）
		const pkg = spec.startsWith('@')
			? spec.split('/').slice(0, 2).join('/')
			: spec.split('/')[0]
		for (const { pattern, why } of FORBIDDEN) {
			if (pattern.test(pkg)) {
				violations.push({
					file: path.relative(process.cwd(), file).split(path.sep).join('/'),
					spec,
					why,
				})
			}
		}
	}
}

console.log(`检查 packages/core：${files.length} 个文件`)

if (violations.length === 0) {
	console.log('✅ 平台无关性检查通过：未发现被禁依赖')
	process.exit(0)
}

console.error(`\n❌ 发现 ${violations.length} 处违规：\n`)
for (const v of violations) {
	console.error(`  ${v.file}`)
	console.error(`    import '${v.spec}'  —  ${v.why}`)
}
console.error(
	'\npackages/core 必须保持平台无关（移动端与桌面端共用）。' +
		'\n若这段逻辑确实依赖平台，请把它留在 apps/ 下，并通过 port 接口注入。',
)
process.exit(1)
