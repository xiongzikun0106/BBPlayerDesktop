/* oxlint-disable no-console -- 验证脚本，以 stdout 输出 */
/**
 * 交叉验证 `packages/core/src/utils/md5.ts` 的自实现 MD5。
 *
 * 以 Node 内置 `crypto.createHash('md5')` 为基准，覆盖：
 *  - RFC 1321 的标准测试向量
 *  - 各种长度（跨 56/64 字节分块边界，这是最容易写错的地方）
 *  - 非 ASCII（UTF-8 多字节）输入
 *  - WBI 实际用到的形态：长查询串
 *
 * 用法：pnpm exec tsx scripts/verify-md5.mjs
 */
import { createHash } from 'node:crypto'
import process from 'node:process'

import { md5Hex } from '../packages/core/src/utils/md5.ts'

const reference = (input) =>
	createHash('md5').update(input, 'utf8').digest('hex')

let passed = 0
let failed = 0

function check(label, input) {
	const expected = reference(input)
	const actual = md5Hex(input)
	if (expected === actual) {
		passed++
	} else {
		failed++
		console.log(`  ❌ ${label}`)
		console.log(`     输入长度 ${input.length}`)
		console.log(`     期望 ${expected}`)
		console.log(`     实际 ${actual}`)
	}
}

console.log('=== 自实现 MD5 交叉验证 ===\n')

console.log('[1] RFC 1321 标准测试向量')
check('空串', '')
check('"a"', 'a')
check('"abc"', 'abc')
check('"message digest"', 'message digest')
check('a-z', 'abcdefghijklmnopqrstuvwxyz')
check(
	'A-Za-z0-9',
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
)
check(
	'数字串',
	'12345678901234567890123456789012345678901234567890123456789012345678901234567890',
)

console.log('\n[2] 分块边界（最容易写错的地方）')
// 55/56/57 与 63/64/65 是 padding 的关键边界
for (const length of [
	51, 52, 53, 54, 55, 56, 57, 58, 63, 64, 65, 119, 120, 121,
]) {
	check(`长度 ${length}`, 'x'.repeat(length))
}

console.log('\n[3] 非 ASCII（UTF-8 多字节）')
check('中文', '哔哩哔哩干杯')
check('emoji', '🎵🎶🎧')
check('混合', 'BV1GJ411x7h7 测试 mix 123')

console.log('\n[4] WBI 实际形态（长查询串）')
check(
	'典型 WBI query',
	'foo=114&bar=514&bvid=BV1GJ411x7h7&cid=137649199&fnval=4048&fnver=0&fourk=1&qlt=30280&wts=1735000000',
)

console.log(`\n${'='.repeat(44)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
console.log('='.repeat(44))
process.exit(failed === 0 ? 0 : 1)
