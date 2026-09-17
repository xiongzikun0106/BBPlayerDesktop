/**
 * MD5（RFC 1321）的最小实现，输出十六进制小写。
 *
 * 为什么自己实现而不用 `md5` 包：`packages/core` 要同时被移动端与桌面端消费，
 * 依赖面越小越好；而 WBI 只需要对短查询串做一次 MD5。
 *
 * 正确性由 `scripts/verify-md5.mts` 以 Node 内置 `crypto` 为基准做交叉验证
 * （含 RFC 1321 向量、56/64 分块边界、UTF-8 多字节、WBI 实际长串）。
 */

/** 32 位加法（保持 32 位溢出语义） */
const safeAdd = (x: number, y: number): number => {
	const lsw = (x & 0xffff) + (y & 0xffff)
	const msw = (x >> 16) + (y >> 16) + (lsw >> 16)
	return (msw << 16) | (lsw & 0xffff)
}

/** 循环左移 */
const rol = (num: number, cnt: number): number =>
	(num << cnt) | (num >>> (32 - cnt))

/** 以小端写出 32 位整数的十六进制 */
const toHexLE = (num: number): string => {
	let out = ''
	for (let i = 0; i < 4; i++) {
		out += ((num >> (i * 8)) & 0xff).toString(16).padStart(2, '0')
	}
	return out
}

export function md5Hex(input: string): string {
	// UTF-8 编码
	const utf8 = unescape(encodeURIComponent(input))
	const bytes: number[] = []
	for (let i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i))

	const bitLength = bytes.length * 8
	bytes.push(0x80)
	while (bytes.length % 64 !== 56) bytes.push(0)
	// 长度以 64 位小端写入
	for (let i = 0; i < 8; i++) {
		bytes.push(Math.floor(bitLength / 2 ** (8 * i)) & 0xff)
	}

	let a = 0x67452301
	let b = 0xefcdab89
	let c = 0x98badcfe
	let d = 0x10325476

	const S = [
		7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
		9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
		16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
		15, 21,
	]
	const K: number[] = []
	for (let i = 0; i < 64; i++) {
		K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32))
	}

	for (let chunk = 0; chunk < bytes.length; chunk += 64) {
		const M: number[] = []
		for (let i = 0; i < 16; i++) {
			const offset = chunk + i * 4
			M.push(
				bytes[offset] |
					(bytes[offset + 1] << 8) |
					(bytes[offset + 2] << 16) |
					(bytes[offset + 3] << 24),
			)
		}

		let A = a
		let B = b
		let C = c
		let D = d

		for (let i = 0; i < 64; i++) {
			let F: number
			let g: number
			if (i < 16) {
				F = (B & C) | (~B & D)
				g = i
			} else if (i < 32) {
				F = (D & B) | (~D & C)
				g = (5 * i + 1) % 16
			} else if (i < 48) {
				F = B ^ C ^ D
				g = (3 * i + 5) % 16
			} else {
				F = C ^ (B | ~D)
				g = (7 * i) % 16
			}
			const tmp = D
			D = C
			C = B
			B = safeAdd(B, rol(safeAdd(safeAdd(A, F), safeAdd(K[i], M[g])), S[i]))
			A = tmp
		}

		a = safeAdd(a, A)
		b = safeAdd(b, B)
		c = safeAdd(c, C)
		d = safeAdd(d, D)
	}

	return toHexLE(a) + toHexLE(b) + toHexLE(c) + toHexLE(d)
}
