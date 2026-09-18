/* oxlint-disable no-console -- 构建脚本，以 stdout 输出 */
/**
 * 从 Google Fonts 取一份 **Material Symbols Rounded 的子集 woff2**，
 * 落到 `src/renderer/assets/`（随源码提交，不依赖构建期联网）。
 *
 * ## 为什么要有这个脚本
 *
 * 第一版的图标是 **unicode 字形**（♪ ⌕ ⤓ ↺ ★ ▤ ⇄ ⚙ ▶ ⏮ ⏭ ✕）。
 * 问题有三个，用户一眼就看出来"杂乱"：
 *   1. 跨平台渲染不一致（Windows 的 Segoe UI Symbol 与 Linux 的
 *      DejaVu Sans 画出来粗细、基线、比例都不同）；
 *   2. 同一个界面上混着"音乐符号 / 几何符号 / 箭头"三类字形，
 *      视觉重量不齐；
 *   3. 移动端用的是 Material 图标，两端语言不统一。
 *
 * ## 为什么是"子集"而不是整包
 *
 * 完整的 Material Symbols Rounded 变量字体约 **300+ KB**。
 * Google Fonts 的 `icon_names=` 参数可以把字体裁剪成**只含指定图标**，
 * 结果通常十几到几十 KB —— 对桌面端来说是白送。
 *
 * ## 为什么下载后要提交进仓库
 *
 * 字体是**源码资产**，不是构建产物：
 *   * CI / 别人 clone 之后不该需要联网才能构建；
 *   * 上游改了图标集不该让历史提交的产物变样；
 *   * `apps/desktop/build/` 是 gitignore 的，放那里就等于"每次都要重新下"。
 *
 * 用法：
 *   node scripts/build-icon-font.mjs            # 用 icons.txt 里的清单
 *   node scripts/build-icon-font.mjs --dry-run  # 只打印 URL 与清单
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')
const ICON_LIST = path.join(DESKTOP, 'scripts', 'icons.txt')
const OUT_DIR = path.join(DESKTOP, 'src', 'renderer', 'assets')
const OUT_FONT = path.join(OUT_DIR, 'material-symbols-rounded.woff2')
const OUT_CSS = path.join(OUT_DIR, 'material-symbols.css')
const OUT_META = path.join(OUT_DIR, 'material-symbols.json')

/**
 * 必须伪装成现代 Chrome。
 *
 * Google Fonts 按 UA 决定返回格式：拿不到 woff2 支持时会回退到 **TTF**，
 * 体积大好几倍。第一版用默认 UA 试过一次，返回的就是 TTF。
 */
const CHROME_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function readIconNames() {
	const raw = fs.readFileSync(ICON_LIST, 'utf8')
	return raw
		.split('\n')
		.map((line) => line.replace(/#.*$/, '').trim())
		.filter(Boolean)
}

function buildCssUrl(iconNames) {
	const family = 'Material+Symbols+Rounded'
	/*
	 * ⚠️ 变量轴**只留 FILL 可变**，其余固定成实例。
	 *
	 * 实测同一份 57 个图标的清单：
	 *   全轴可变（opsz 20..48 / wght 100..700 / FILL 0..1 / GRAD -50..200）→ **69.3 KB**
	 *   只留 FILL（其余 @24,400,…）                                        → **9.3 KB**
	 *
	 * 差了 7 倍。我们真正需要的只有 FILL（描边 / 填充两态），
	 * 字号用 `font-size` 控制、字重固定 400 —— 剩下那些轴全是白带的体积。
	 */
	const axes = 'opsz,wght,FILL,GRAD@24,400,0..1,0'
	// 排序只是为了 URL 稳定（同样的清单永远生成同一个 URL，便于比对与缓存）；
	// 显式给 compare 是 lint 要求的 —— 默认的字典序在这里就是想要的顺序。
	const sorted = [...iconNames].sort((a, b) => a.localeCompare(b, 'en'))
	return (
		`https://fonts.googleapis.com/css2?family=${family}:${axes}` +
		`&icon_names=${sorted.join(',')}&display=block`
	)
}

/**
 * 带重试的 fetch。
 *
 * Google Fonts 偶发 `fetch failed`（实测过一次，重试即成功）。
 * 构建脚本不该因为一次网络抖动就红。
 */
async function fetchWithRetry(url, { attempts = 3 } = {}) {
	let lastError = null
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const response = await fetch(url, {
				headers: { 'User-Agent': CHROME_UA },
			})
			if (!response.ok) throw new Error(`HTTP ${response.status}`)
			return response
		} catch (error) {
			lastError = error
			if (attempt < attempts) {
				console.log(`  （第 ${attempt} 次失败：${error.message}，重试…）`)
				await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
			}
		}
	}
	throw new Error(`重试 ${attempts} 次仍失败：${lastError?.message}`)
}

async function main() {
	const dryRun = process.argv.includes('--dry-run')
	const iconNames = readIconNames()
	const cssUrl = buildCssUrl(iconNames)

	console.log('=== 生成 Material Symbols 子集字体 ===\n')
	console.log(`图标数量：${iconNames.length}`)
	console.log(`图标清单：${path.relative(ROOT, ICON_LIST)}`)
	console.log(`CSS URL：${cssUrl}\n`)

	if (dryRun) {
		console.log('（--dry-run，不下载）')
		return
	}

	const css = await fetchWithRetry(cssUrl).then((r) => r.text())

	// 从返回的 CSS 里挑出 woff2 源。
	//
	// ⚠️ URL **不一定以 `.woff2` 结尾**：Google 现在会返回
	// `https://fonts.gstatic.com/l/font?kit=…&skey=…&v=…` 这种形式，
	// 格式由后面的 `format('woff2')` 声明。第一版按扩展名匹配，
	// 于是明明拿到了字体却报「没有 woff2 源」。
	const fontUrls = [
		...css.matchAll(
			/url\((https:\/\/[^)]+)\)\s*format\(\s*['"]?woff2['"]?\s*\)/g,
		),
	].map((m) => m[1])
	if (fontUrls.length === 0) {
		throw new Error(
			`返回的 CSS 里没有 woff2 源（可能 UA 没被识别）。CSS 片段：\n${css.slice(0, 400)}`,
		)
	}

	console.log(`返回 ${fontUrls.length} 个 woff2 分片，逐个下载：`)
	const buffers = []
	for (const url of fontUrls) {
		const buffer = Buffer.from(
			await fetchWithRetry(url).then((r) => r.arrayBuffer()),
		)
		buffers.push(buffer)
		console.log(
			`  ✓ ${(buffer.length / 1024).toFixed(1)} KB  ${url.split('/').pop()}`,
		)
	}

	if (buffers.length !== 1) {
		throw new Error(
			`期望 1 个 woff2 分片（子集字体不该被拆分），实际 ${buffers.length} 个。` +
				'如果确实变多了，需要改成多 @font-face + unicode-range。',
		)
	}

	fs.mkdirSync(OUT_DIR, { recursive: true })
	fs.writeFileSync(OUT_FONT, buffers[0])

	// 自己写 @font-face，不直接用 Google 返回的那段：
	// 它会引用远端 URL，而我们要的是**本地**文件。
	const localCss = `/*
 * Material Symbols Rounded（子集）。
 *
 * ⚠️ 这个文件是 scripts/build-icon-font.mjs **生成**的，不要手改。
 * 改图标清单请改 scripts/icons.txt 再重新生成。
 *
 * 用法：<span class="icon">play_arrow</span>
 * （ligature：字体把图标名当成合字渲染成图形）
 */
@font-face {
	font-family: 'Material Symbols Rounded';
	font-style: normal;
	font-weight: 100 700;
	src: url('material-symbols-rounded.woff2') format('woff2');
	font-display: block;
}

.icon {
	font-family: 'Material Symbols Rounded';
	font-weight: normal;
	font-style: normal;
	line-height: 1;
	letter-spacing: normal;
	text-transform: none;
	display: inline-block;
	white-space: nowrap;
	word-wrap: normal;
	direction: ltr;
	/* 默认档位：M3 常用的 24dp / wght 400 / 不填充 */
	font-variation-settings:
		'FILL' 0,
		'wght' 400,
		'GRAD' 0,
		'opsz' 24;
	-webkit-font-smoothing: antialiased;
	text-rendering: optimizeLegibility;
	/* 让图标在行内与文字对齐（否则会因为 line-height 顶上去） */
	vertical-align: middle;
	user-select: none;
}

/* 尺寸档位 */
.icon--sm {
	font-size: 16px;
}
.icon--md {
	font-size: 20px;
}
.icon--lg {
	font-size: 24px;
}
.icon--xl {
	font-size: 40px;
}

/* 填充版（选中态、当前曲目） */
.icon--filled {
	font-variation-settings:
		'FILL' 1,
		'wght' 400,
		'GRAD' 0,
		'opsz' 24;
}
`
	fs.writeFileSync(OUT_CSS, localCss)

	fs.writeFileSync(
		OUT_META,
		JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				family: 'Material Symbols Rounded',
				cssUrl,
				iconCount: iconNames.length,
				icons: [...iconNames].sort(),
				bytes: buffers[0].length,
			},
			null,
			2,
		),
	)

	console.log(
		`\n字体：${path.relative(ROOT, OUT_FONT)}（${(buffers[0].length / 1024).toFixed(1)} KB）`,
	)
	console.log(`样式：${path.relative(ROOT, OUT_CSS)}`)
	console.log(`清单：${path.relative(ROOT, OUT_META)}`)

	// 自检：字体文件必须以 woff2 的魔数开头（'wOF2'），否则说明存坏了
	const magic = buffers[0].subarray(0, 4).toString('latin1')
	if (magic !== 'wOF2') {
		throw new Error(
			`字体文件头不是 wOF2（实际 ${JSON.stringify(magic)}），下载可能被拦了`,
		)
	}
	console.log('✓ 文件头校验通过（wOF2）')
}

main().catch((error) => {
	console.error(`\n✗ 生成失败：${error.message}`)
	process.exit(1)
})
