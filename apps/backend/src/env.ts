/**
 * Worker 运行时绑定（env）的显式入口。
 *
 * 为什么需要这个文件：`apps/backend/tsconfig.json` 通过 `include` 引入了
 * `wrangler types` 生成的 `worker-configuration.d.ts`，所以 backend 独立编译时
 * 裸全局 `Env` 是可解析的；但 `apps/mobile` 为了复用 `AppType` 而借道编译
 * backend 源码时并不会带上那份环境声明，于是会报 `Cannot find name 'Env'`。
 *
 * 这里**只声明本服务实际使用的绑定**，刻意不引用 `worker-configuration.d.ts`：
 * 任何形式的引入（`/// <reference>` 或 `import()`）都会把 Cloudflare 的全局声明
 * 带进消费方的作用域，与 RN / DOM 的 `fetch`、`RequestInit`（`cf` 属性）冲突。
 *
 * 若 `wrangler.toml` 增删了绑定，请同步更新此处；真实全量形状见
 * `worker-configuration.d.ts` 中的 `Cloudflare.Env`。
 */
export interface Env {
	/** Cloudflare KV：存放 update.json 等 */
	KV: {
		get(key: string): Promise<string | null>
		put(key: string, value: string): Promise<void>
		delete(key: string): Promise<void>
	}
	/** Postgres 连接串 */
	DATABASE_URL: string
	/** JWT 签名密钥 */
	JWT_SECRET: string
}
