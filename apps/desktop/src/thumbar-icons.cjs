/**
 * 任务栏缩略图按钮的图标：**运行时生成** 32×32 PNG。
 *
 * ## 为什么不把 base64 硬编码进来
 *
 * 第一版就是那么做的，结果四个图标写成了同一串占位 base64（133 字节），
 * 而且尺寸只有 16×16 —— 在 150% / 200% 缩放的 Windows 上糊成一片。
 * 生成代码只有几十行、用的是 Node 内置的 `zlib`（零依赖），
 * 却换来「改形状/改尺寸只要改一个数」和不会写错的可读性。
 *
 * ## 为什么是 32×32
 *
 * Windows 的缩略图工具栏在 100% DPI 下按 16×16 显示，但 `nativeImage`
 * 不会自动缩放，且高 DPI 下会用更大的位图。32×32 在 100%/200% 下都清晰，
 * 是 Electron 文档建议的量级。
 *
 * PNG 编码只做最小可用集：8 位 RGBA、filter 固定为 `none`。
 * 这些图标是纯色块，deflate 后每张约 100–200 字节。
 */
const zlib = require('node:zlib')

/** CRC-32 查表（PNG 每个 chunk 都要） */
const CRC_TABLE = (() => {
	const table = new Int32Array(256)
	for (let n = 0; n < 256; n += 1) {
		let c = n
		for (let k = 0; k < 8; k += 1) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		}
		table[n] = c
	}
	return table
})()

function crc32(buffer) {
	let c = 0xffffffff
	for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
	return (c ^ 0xffffffff) >>> 0
}

/** 组装一个 PNG chunk：长度 + 类型 + 数据 + CRC */
function pngChunk(type, data) {
	const length = Buffer.alloc(4)
	length.writeUInt32BE(data.length)
	const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(crc32(typeAndData))
	return Buffer.concat([length, typeAndData, crc])
}

/**
 * 把 `pixel(x, y) -> [r, g, b, a]` 编码成 PNG。
 *
 * @param {number} size 边长（方形）
 * @param {(x: number, y: number) => [number, number, number, number]} pixel
 */
function encodePng(size, pixel) {
	const bytesPerRow = size * 4 + 1 // 每行开头一个 filter 字节
	const raw = Buffer.alloc(size * bytesPerRow)
	let offset = 0
	for (let y = 0; y < size; y += 1) {
		raw[offset] = 0 // filter: none
		offset += 1
		for (let x = 0; x < size; x += 1) {
			const [r, g, b, a] = pixel(x, y)
			raw[offset] = r
			raw[offset + 1] = g
			raw[offset + 2] = b
			raw[offset + 3] = a
			offset += 4
		}
	}

	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(size, 0)
	ihdr.writeUInt32BE(size, 4)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 6 // color type: RGBA
	// 10..12 保持 0：压缩/滤波/交错均为默认

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', ihdr),
		pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
		pngChunk('IEND', Buffer.alloc(0)),
	])
}

const SIZE = 32
const WHITE = [255, 255, 255, 255]
const CLEAR = [0, 0, 0, 0]

// 所有几何量都按 32 栅格归一化，改 SIZE 不用改形状定义
const TOP = 7
const BOTTOM = 24
const MID = (TOP + BOTTOM) / 2

/** 右向三角形（播放） */
function triangle(xStart, width) {
	return (x, y) => {
		if (y < TOP || y > BOTTOM) return false
		const centerX = xStart + width / 2
		const frac = 1 - Math.abs((y - MID) / ((BOTTOM - TOP) / 2 + 0.5))
		const half = Math.max(1, (width / 2) * frac)
		return x >= centerX - half && x < centerX + half
	}
}

/** 竖直条（暂停的两条、上一首/下一首的竖线） */
function bars(positions, width) {
	return (x, y) =>
		y >= TOP && y <= BOTTOM && positions.some((x0) => x >= x0 && x < x0 + width)
}

const SHAPES = {
	play: triangle(9, 16),
	pause: bars([9, 19], 5),
	prev: (x, y) => bars([5], 4)(x, y) || triangle(9, 15)(x, y),
	next: (x, y) => triangle(8, 15)(x, y) || bars([23], 4)(x, y),
}

/** `name -> data URL`，名字非法时退回 `play` */
function iconDataUrls() {
	const out = {}
	for (const [name, shape] of Object.entries(SHAPES)) {
		const png = encodePng(SIZE, (x, y) => (shape(x, y) ? WHITE : CLEAR))
		out[name] = `data:image/png;base64,${png.toString('base64')}`
	}
	return out
}

module.exports = { encodePng, iconDataUrls, SHAPES, SIZE }
