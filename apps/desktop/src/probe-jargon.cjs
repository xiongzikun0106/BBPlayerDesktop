/* oxlint-disable no-console -- 探针公共模块 */
/**
 * 「开发日志」黑名单（探针共用）。
 *
 * ## 为什么需要它
 *
 * 桌面端第一版把很多实现细节直接写进了界面：凭据「已由系统密钥环加密存储」、
 * 「等同明文」的警告、账号 UUID、后端 URL、备份格式（ZIP + SQLite 快照）、
 * `exportedAt=`、导出后的**绝对路径**、常驻的「就绪」状态栏……
 *
 * 这些是我当时**刻意**做的（想把事实说清楚，并写进了 `DESKTOP_PLAN.md`
 * 当作「不静默降级」的优点），但位置全错了：**该知道 ≠ 该在主流程里说**。
 * 用户在上号、存密码、点备份的时候不需要被教育这些，一句「等同明文」
 * 只会让人以为出事了。
 *
 * 清一遍只解决今天，所以把规则钉成断言。允许的唯一出口是
 * 「诊断信息」折叠区（`.settings-diagnostics`），以及显式标了
 * `data-allow-jargon` 的容器 —— 需要新增例外时**先想清楚**。
 *
 * ## 扫描范围
 *
 * **不按可见性过滤**：隐藏面板里的文案同样是"会被用户看到"的文案，
 * 而且第一版正是栽在没被打开的共享面板上（它在 DOM 里但 `display:none`，
 * 第一版按可见性扫描于是完全漏掉）。只跳过被豁免的子树与 `<pre>`（日志）。
 */

/**
 * 这些词出现在**主界面**上就是设计错误。
 *
 * 全是"实现细节"词，没有一个是功能词 —— 用户真正要的东西（歌单、歌词、
 * 备份、登录、同步）一个都不在里面。
 */
const JARGON_PATTERNS = [
	'密钥环',
	'明文',
	'混淆存储',
	'DPAPI',
	'safeStorage',
	'加密存储',
	'outbox',
	'游标',
	'幂等',
	'manifest',
	'__drizzle',
	'迁移',
	'schema',
	'SQLite',
	'快照',
	'exportedAt',
	'Bearer',
	'JWT',
	'AppData\\',
	'/tmp/',
	'Temp\\',
]

/**
 * 生成一段能被 `webContents.executeJavaScript` 执行的表达式，
 * 返回命中黑名单的词（JSON 数组字符串）。
 *
 * 之所以在这里生成而不是在驱动里手写模板字符串：反斜杠要穿两层转义
 * （驱动的模板字符串 → 被求值的源码 → 字符串字面量），
 * 第一版手写时多写了一层，`'AppData\\'` 变成 `AppData\\`，黑名单形同虚设。
 */
function jargonScanExpression() {
	return `(() => {
		const SKIP = ['.settings-diagnostics', '[data-allow-jargon]', 'pre']
		const walk = (node) => {
			if (node.nodeType === 3) return node.nodeValue || ''
			if (node.nodeType !== 1) return ''
			for (const sel of SKIP) if (node.matches?.(sel)) return ''
			let text = ''
			for (const child of node.childNodes) text += walk(child)
			return text + ' '
		}
		const text = walk(document.body).replace(/\\s+/g, ' ')
		return JSON.stringify(${JSON.stringify(JARGON_PATTERNS)}.filter((p) => text.includes(p)))
	})()`
}

/** 命中列表 → 一句可读的 detail */
function describeJargonHits(hits) {
	if (!Array.isArray(hits) || hits.length === 0) return '零命中'
	return `命中：${hits.join('、')}`
}

module.exports = { JARGON_PATTERNS, jargonScanExpression, describeJargonHits }
