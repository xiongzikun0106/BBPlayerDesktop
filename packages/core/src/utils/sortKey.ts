import { generateKeyBetween } from 'fractional-indexing'

/**
 * 歌单顺序的**唯一约定**（移动端与桌面端共用这一份实现）。
 *
 * ## 约定本身
 *
 * `playlist_tracks.sort_key` 是 `fractional-indexing` 字符串，
 * **越大越靠前**，读取一律 `ORDER BY sort_key DESC`。
 *
 * 选这套的理由是「插入不用重排」：在两首歌之间插一首，只需要生成一个
 * 严格夹在两者之间的新键，剩下的行一个都不用动。用递增整数下标的话，
 * 每次插入都要把后面所有行 +1。
 *
 * ## 为什么必须抽到 core
 *
 * 两端**各自实现过一次，而且实现了相反的方向**：移动端是
 * `generateKeyBetween(prev, null)` + `DESC`，桌面端一度是
 * `` `a${index}` ``（越小越靠前）+ `ASC`。两端各自自洽，所以**单端跑起来
 * 完全看不出问题** —— 但备份是「整个 SQLite 文件搬家」，移动端拿到桌面端的
 * 库后用自己的规则去读，顺序就整体倒过来了。
 *
 * 更隐蔽的是移动端的 `sortKeysV3` 迁移**只翻转 `type != 'local'` 的歌单**，
 * 于是桌面端自己新建的 local 歌单（最常见的一类）**恰好不会被翻转**。
 *
 * 结论：顺序是**跨端数据格式**的一部分，不能各写一份。
 * 见 `scripts/verify-sortkey-interop.mts`（两端读法在同一个库上对拍）。
 */

/** 列表**最靠前**一项的键（`null` 表示列表是空的） */
export type SortKeyAnchor = string | null

/**
 * 追加到列表**顶部**：返回一个比 `currentTopKey` 更大的键。
 *
 * 与移动端 `addManyTracksToLocalPlaylist` 的行为一致
 * （`generateKeyBetween(MAX(sort_key), null)`）。
 */
export function generateKeyForTop(currentTopKey: SortKeyAnchor = null): string {
	return generateKeyBetween(currentTopKey, null)
}

/**
 * 追加到列表**底部**：返回一个比 `currentBottomKey` 更小的键。
 *
 * 桌面端此前用递增下标 + `ASC` 读取，也就是「新加的落在末尾」。
 * 迁移到本约定时**保留这个用户可见行为**，因此需要这个方向。
 */
export function generateKeyForBottom(
	currentBottomKey: SortKeyAnchor = null,
): string {
	return generateKeyBetween(null, currentBottomKey)
}

/**
 * 在两项之间插入。
 *
 * ⚠️ 参数是**字典序**的下界与上界，不是「视觉上的左右邻居」——
 * 由于约定是「越大越靠前」，视觉上的前一项反而是**上界**。
 * 调用方传反了会得到 `generateKeyBetween` 的
 * `Invalid key order` 异常，这是**好事**：宁可抛错也不静默乱序。
 */
export function generateKeyBetweenPositions(
	lowerKey: SortKeyAnchor,
	upperKey: SortKeyAnchor,
): string {
	return generateKeyBetween(lowerKey, upperKey)
}

/**
 * 为「从前往后」的一整个列表生成一套键：`keys[0]` 最大。
 *
 * 倒序生成是必须的 —— 正序生成会让 `keys[0]` 最小，而这套约定里最小
 * 意味着排在最后。删除整个歌单再重建（`replacePlaylistAllTracks`）时用它。
 */
export function generateSortKeySequence(count: number): string[] {
	const keys: string[] = new Array(count)
	let previousKey: SortKeyAnchor = null
	for (let i = count - 1; i >= 0; i--) {
		keys[i] = generateKeyBetween(previousKey, null)
		previousKey = keys[i]!
	}
	return keys
}
