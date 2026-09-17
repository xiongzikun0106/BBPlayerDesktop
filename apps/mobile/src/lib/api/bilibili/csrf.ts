import { err, ok, type Result } from 'neverthrow'

import useAppStore from '@/hooks/stores/useAppStore'
import { BilibiliApiError } from '@bbplayer/core'

/**
 * 读取当前登录态中的 CSRF Token（bili_jct）。
 *
 * 因为要读应用状态，所以留在移动端；纯计算的 `bv2av` / `av2bv` 已下沉到
 * `@bbplayer/core` 供两端共用。
 */
export function getCsrfToken(): Result<string, BilibiliApiError> {
	const cookieList = useAppStore.getState().bilibiliCookie
	if (!cookieList)
		return err(
			new BilibiliApiError({
				message: '未找到 Cookie',
				type: 'NoCookie',
			}),
		)
	const csrfToken = cookieList.bili_jct as string | undefined
	if (!csrfToken) {
		return err(
			new BilibiliApiError({
				message: '未找到 CSRF Token',
				type: 'CsrfError',
			}),
		)
	}
	return ok(csrfToken)
}
