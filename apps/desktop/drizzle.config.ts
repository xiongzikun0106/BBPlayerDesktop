import { defineConfig } from 'drizzle-kit'

/**
 * 桌面端的 drizzle 配置。
 *
 * 只用来**生成一份完整基线迁移**，替换上游那套在空库上跑不通的增量链
 * （见 apps/desktop/src/db.cjs 里的详细说明）。schema 直接指向
 * `packages/core/src/db/schema.ts`，因此与移动端最终结构一致。
 */
export default defineConfig({
	dialect: 'sqlite',
	schema: '../../packages/core/src/db/schema.ts',
	out: './drizzle-baseline',
})
