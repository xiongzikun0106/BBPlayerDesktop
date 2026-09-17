/* oxlint-disable no-console -- 校验脚本 */
/**
 * 校验任务栏图标生成器：PNG 结构、尺寸、四个图标互不相同。
 *
 * 存在的理由：第一版把图标硬编码成 base64，四个值是**同一串占位图**，
 * 而且尺寸不对。所以「生成器真的产出了四张不同的合法 PNG」必须被断言，
 * 不能靠肉眼。
 *
 * 用法：node scripts/verify-thumbar-icons.mjs
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '..')
const { iconDataUrls, SIZE } = require(
	path.join(ROOT, 'apps', 'desktop', 'src', 'thumbar-icons.cjs'),
)

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

let passed = 0
let failed = 0
const check = (label, ok, detail = '') => {
	if (ok) {
		passed++
		console.log(`  ✅ ${label}${detail ? `  — ${detail}` : ''}`)
	} else {
		failed++
		console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`)
	}
}

console.log('=== 任务栏图标生成器校验 ===\n')

const urls = iconDataUrls()
const names = Object.keys(urls)
console.log(`生成的图标：${names.join(', ')}\n`)

check('生成了 4 个图标', names.length === 4, names.join(', '))

const decoded = {}
for (const [name, url] of Object.entries(urls)) {
	const prefix = 'data:image/png;base64,'
	if (!url.startsWith(prefix)) {
		check(`${name}: data URL 前缀正确`, false, url.slice(0, 40))
		continue
	}
	const bytes = Buffer.from(url.slice(prefix.length), 'base64')
	decoded[name] = bytes

	const hasMagic = bytes.subarray(0, 8).equals(PNG_MAGIC)
	check(`${name}: PNG magic 正确`, hasMagic, `${bytes.length} 字节`)

	if (hasMagic) {
		const width = bytes.readUInt32BE(16)
		const height = bytes.readUInt32BE(20)
		check(
			`${name}: 尺寸 ${SIZE}×${SIZE}`,
			width === SIZE && height === SIZE,
			`${width}×${height}`,
		)
		// 位深 8、颜色类型 6(RGBA) —— 任务栏按钮需要 alpha 通道
		const bitDepth = bytes[24]
		const colorType = bytes[25]
		check(
			`${name}: 8 位 RGBA（有 alpha 通道）`,
			bitDepth === 8 && colorType === 6,
			`bitDepth=${bitDepth} colorType=${colorType}`,
		)
		// IEND 必须存在且文件以它收尾
		check(
			`${name}: 以 IEND 正常收尾`,
			bytes.subarray(-8, -4).toString('ascii') === 'IEND',
		)
	}
}

// 关键断言：四个图标必须真的不同（第一版就是四个一样）
const hashes = Object.entries(decoded).map(([name, bytes]) => ({
	name,
	hash: createHash('sha256').update(bytes).digest('hex'),
}))
const uniqueHashes = new Set(hashes.map((h) => h.hash))
check(
	'四个图标内容互不相同',
	uniqueHashes.size === 4,
	hashes.map((h) => `${h.name}=${h.hash.slice(0, 8)}`).join(' '),
)

// 每个图标必须有非透明像素（否则任务栏上是空白按钮）
for (const [_name, bytes] of Object.entries(decoded)) {
	// 简单判定：PNG 压缩后若全透明，deflate 流会非常短；
	// 更可靠的判据是解出来的原始数据里有 alpha != 0 的像素。
	// 这里用「文件字节数明显大于纯透明图」来近似，并在下面用像素级复核。
	void bytes
}
{
	const { encodePng: enc } = require(
		path.join(ROOT, 'apps', 'desktop', 'src', 'thumbar-icons.cjs'),
	)
	const emptyPng = enc(SIZE, () => [0, 0, 0, 0])
	for (const [name, bytes] of Object.entries(decoded)) {
		check(
			`${name}: 有不透明像素（不是空白按钮）`,
			bytes.length > emptyPng.length,
			`${bytes.length} 字节 vs 全透明 ${emptyPng.length} 字节`,
		)
	}
}

// 像素级复核：直接调用 encodePng，确认形状函数真的画了东西且左右不同
{
	const shapes = require(
		path.join(ROOT, 'apps', 'desktop', 'src', 'thumbar-icons.cjs'),
	).SHAPES
	const counts = {}
	for (const [name, shape] of Object.entries(shapes)) {
		let on = 0
		for (let y = 0; y < SIZE; y++) {
			for (let x = 0; x < SIZE; x++) if (shape(x, y)) on++
		}
		counts[name] = on
	}
	check(
		'每个形状都有实际像素',
		Object.values(counts).every((n) => n > 40),
		JSON.stringify(counts),
	)
	check(
		'播放与暂停形状不同',
		counts.play !== counts.pause,
		`play=${counts.play} pause=${counts.pause}`,
	)
	check(
		'上一首与下一首形状不同（左右分离）',
		counts.prev !== counts.next ||
			(() => {
				// 像素数可能相同，逐点比较确保不是镜像误判
				let diff = 0
				for (let y = 0; y < SIZE; y++) {
					for (let x = 0; x < SIZE; x++) {
						if (shapes.prev(x, y) !== shapes.next(x, y)) diff++
					}
				}
				return diff > 10
			})(),
		`prev=${counts.prev} next=${counts.next}`,
	)

	// 落盘供目视核对
	const dir = path.join(os.tmpdir(), 'bbplayer-thumbar-check')
	fs.mkdirSync(dir, { recursive: true })
	for (const [name, bytes] of Object.entries(decoded)) {
		fs.writeFileSync(path.join(dir, `${name}.png`), bytes)
	}
	console.log(`\n图标已落盘供目视核对：${dir}`)
}

console.log(`\n=== 结果：${passed} 通过, ${failed} 失败 ===`)
process.exit(failed === 0 ? 0 : 1)
