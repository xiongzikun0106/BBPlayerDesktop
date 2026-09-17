/**
 * 登录管理器的持有者（避免循环依赖的小模块）。
 *
 * ## 为什么需要它
 *
 * 依赖关系上：
 *   * `bilibili-api.cjs` 需要知道「是否已登录」来决定要不要开会员音轨；
 *   * `ports.cjs` 的 `BilibiliCredentialPort` 需要从登录模块取 cookie；
 *   * 而登录模块自己要用 `fetch`（不经过 core 客户端）—— 所以它**不**依赖
 *     `bilibili-api.cjs`。
 *
 * 看起来没有环，但 `ports.cjs` ← `bilibili-api.cjs` 已经存在，
 * 若让 `ports.cjs` 直接 require 登录模块，而登录模块将来用到 core 客户端，
 * 立刻成环。用这个「先注册、后取用」的 holder 把时序理清：
 * `main.cjs` 在 `app.whenReady()` 前创建管理器并注册，之后任何模块按需取。
 *
 * 取不到时返回 `null` 而不是抛错：`scripts/verify-desktop*.mjs` 这类
 * 纯 Node 验证脚本不注册登录管理器，也不该因此崩。
 */

/** @type {object|null} */
let manager = null

function setLoginManager(next) {
	manager = next
	return manager
}

function getLoginManager() {
	return manager
}

module.exports = { setLoginManager, getLoginManager }
