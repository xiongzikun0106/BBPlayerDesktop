/* oxlint-disable no-console -- 构建脚本，以 stdout 输出 */
/**
 * 生成应用图标（`build/icon.png`，256×256）。
 *
 * ## 为什么用程序生成而不是放一个二进制资源
 *
 * 图标是**构建产物**，不是手绘素材：这样改配色/尺寸只要改常量，
 * 而且不用把二进制塞进 git（diff 里看不出内容、review 时无法核对）。
 * 用的 PNG 编码器与任务栏图标是**同一个**（`src/thumbar-icons.cjs`），
 * 零依赖（Node 内置 zlib）。
 *
 * 设计：M3 深色底 + 主色（`#d0bcff`）的圆角方块与播放三角。
 * 与 `style.css` 用的语义 token 同源，视觉上与应用一致。
 *
 * electron-builder 会从这个 256×256 PNG 自动生成 `.ico`（Windows）
 * 与多尺寸 PNG（Linux），所以只需要提供一张。
 *
 * 用法：node scripts/build-icons.mjs
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')
const OUT_DIR = path.join(DESKTOP, 'build')

// 复用任务栏图标的 PNG 编码器（零依赖，Node 内置 zlib）
const { encodePng } = require(path.join(DESKTOP, 'src', 'thumbar-icons.cjs'))

/** 与 style.css 的 `--primary` / `--bg` 保持一致 */
const COLORS = {
	background: [28, 27, 31, 255], // --bg
	primary: [208, 188, 255, 255], // --primary
	onPrimary: [56, 30, 114, 255], // --on-primary
}

const SIZE = 256

/**
 * 圆角矩形的内外判定。
 *
 * 用「到最近圆角圆心的距离」判断，而不是简单的 x/y 范围 —— 后者画出来是
 * 直角方块，在小尺寸下与应用里到处使用的圆角（`--r-*`）不一致。
 */
function insideRoundedSquare(x, y, inset, radius) {
	const min = inset
	const max = SIZE - inset
	if (x < min || x > max || y < min || y > max) return false

	// 四个圆角区域：到各自圆心的距离必须 <= radius
	const cx =
		x < min + radius ? min + radius : x > max - radius ? max - radius : x
	const cy =
		y < min + radius ? min + radius : y > max - radius ? max - radius : y
	const dx = x - cx
	const dy = y - cy
	return dx * dx + dy * dy <= radius * radius
}

/** 右向播放三角 */
function insidePlayTriangle(x, y) {
	const left = 96
	const right = 178
	const top = 78
	const bottom = 178
	if (x < left || x > right || y < top || y > bottom) return false

	const centerY = (top + bottom) / 2
	const halfSpan = (bottom - top) / 2
	const progress = (x - left) / (right - left) // 0 在左，1 在右
	// 三角形从左边最高到右边收敛到一点
	const allowed = halfSpan * (1 - progress)
	return Math.abs(y - centerY) <= allowed
}

function pixel(x, y) {
	// 底色圆角方块（留 8px 内边距，避免贴边被裁）
	if (insideRoundedSquare(x, y, 8, 52)) {
		// 播放三角用主色，其余用较亮的表面色做「卡片」效果
		if (insidePlayTriangle(x, y)) return COLORS.onPrimary
		return COLORS.primary
	}
	return [0, 0, 0, 0] // 透明
}

function main() {
	fs.mkdirSync(OUT_DIR, { recursive: true })

	const png = encodePng(SIZE, pixel)
	const outFile = path.join(OUT_DIR, 'icon.png')
	fs.writeFileSync(outFile, png)

	// 校验产物真的是合法 PNG（只写文件不验证等于没验证）
	const width = png.readUInt32BE(16)
	const height = png.readUInt32BE(20)
	const magicOk = png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
	if (!magicOk || width !== SIZE || height !== SIZE) {
		throw new Error(
			`图标生成异常：magic=${magicOk} 尺寸=${width}x${height}（期望 ${SIZE}x${SIZE}）`,
		)
	}

	// 统计不透明像素，防止画出全透明图（那样桌面上是个空白图标）
	let opaque = 0
	for (let y = 0; y < SIZE; y += 1) {
		for (let x = 0; x < SIZE; x += 1) {
			if (pixel(x, y)[3] > 0) opaque += 1
		}
	}
	const ratio = opaque / (SIZE * SIZE)
	if (ratio < 0.3) {
		throw new Error(
			`不透明像素占比过低（${(ratio * 100).toFixed(1)}%），图标可能几乎不可见`,
		)
	}

	console.log('=== 应用图标 ===\n')
	console.log(`  ✓ ${outFile}`)
	console.log(`    ${width}x${height}，${(png.length / 1024).toFixed(1)} KB`)
	console.log(`    不透明像素 ${(ratio * 100).toFixed(1)}%`)
	console.log(
		'\nelectron-builder 会用它生成 Windows 的 .ico 与 Linux 的多尺寸 PNG。',
	)
}

main()
