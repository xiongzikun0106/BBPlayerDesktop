/* oxlint-disable no-console -- 检查脚本，以 stdout 输出 */
/**
 * 探针脚本的静态检查。
 *
 * ## 为什么需要它
 *
 * 探针驱动跑在 Electron 主进程里，**加载失败 = 整个应用起不来**
 * （Electron 弹 "A JavaScript error occurred in the main process"），
 * 而不是"某条断言失败"。所以这类错误必须在**跑之前**拦住。
 *
 * 我在这个仓库里踩了**四次**同一个坑：
 *
 *     在模板字符串（反引号）**内部**的 `//` 注释里写 markdown 行内代码
 *
 * 反引号会当场**结束模板字符串**，后面的内容被当成代码 → 语法错误。
 * 最阴的是：全局反引号**数量**仍然配平（成对出现），
 * 所以"数反引号奇偶"这种校验完全看不出来。
 *
 * 检查两件事：
 *   1. 每个 `.cjs` / `.mjs` 都过一遍 `node --check`（语法）；
 *   2. 扫「模板字符串内部的注释里出现反引号」这个具体模式。
 *
 * 用法：`node scripts/check-probe-syntax.mjs`
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const TARGET_DIRS = [
	path.join(ROOT, 'apps', 'desktop', 'src'),
	path.join(ROOT, 'scripts'),
]

function collectFiles() {
	const files = []
	for (const dir of TARGET_DIRS) {
		if (!fs.existsSync(dir)) continue
		for (const name of fs.readdirSync(dir)) {
			if (/\.(cjs|mjs|js)$/.test(name)) files.push(path.join(dir, name))
		}
	}
	return files.sort()
}

/** 语法检查；返回错误信息或 null */
function syntaxError(file) {
	try {
		execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
		return null
	} catch (error) {
		const text = String(error.stderr ?? error.message)
		// 只留第一段（文件名 + 那一行 + 错误类型），其余是调用栈
		return text.split('\n').slice(0, 3).join('\n').trim()
	}
}

const BACKTICK = String.fromCodePoint(96)
const bareBacktick = new RegExp(BACKTICK, 'g')

/**
 * 找「模板字符串内部的注释里出现反引号」。
 *
 * 这个扫描是**启发式**的：它按行跟踪"是否在模板里"（用反引号的奇偶切换），
 * 在模板内部遇到 `//` 注释且该行含反引号就报。会误报"注释里成对写反引号"
 * 的情况 —— 但那种写法**本身就是错的**（反引号会结束模板），所以不算误报。
 */
function templateCommentProblems(file) {
	const problems = []
	const lines = fs.readFileSync(file, 'utf8').split('\n')
	let inTemplate = false
	/**
	 * ⚠️ 两处都要盯：`//` 行注释**和** `/* … *​/` 块注释。
	 *
	 * 第一版只扫行注释，于是我在模板里的**块注释**里写了一个反引号就漏过了
	 * —— 守卫报绿、探针加载失败、整个应用起不来。
	 *
	 * 但补上块注释之后又出现**误报**：文件头的 JSDoc 里常有 Markdown 代码
	 * 围栏（三连反引号），它让"按行奇偶切换是否在模板内"的启发式算错，
	 * 于是把注释里的围栏报成"模板内的反引号"。
	 *
	 * 修法：**只让非注释行参与奇偶切换**。注释行上的反引号本来就不是模板
	 * 定界符 —— 它要么是"注释在模板里"（那是真 bug，报），要么是"注释在
	 * 模板外"（栅栏，不该切换）。
	 */
	let inBlockComment = false
	lines.forEach((line, index) => {
		const count = (line.match(bareBacktick) ?? []).length
		const startsBlock = /\/\*/.test(line)
		const isCommentLine = inBlockComment || startsBlock || /^\s*\/\//.test(line)

		if (inTemplate && isCommentLine && count > 0) {
			problems.push(
				`${path.relative(ROOT, file)}:${index + 1}  ${line.trim().slice(0, 70)}`,
			)
		}

		if (startsBlock && !/\*\//.test(line)) inBlockComment = true
		else if (inBlockComment && /\*\//.test(line)) inBlockComment = false

		// 注释行不参与奇偶切换（见上面的注释）
		if (!isCommentLine && count % 2 === 1) inTemplate = !inTemplate
	})
	return problems
}

function main() {
	const files = collectFiles()
	console.log(`=== 检查 ${files.length} 个脚本 ===\n`)

	const syntax = []
	const templates = []
	for (const file of files) {
		const error = syntaxError(file)
		if (error) syntax.push({ file: path.relative(ROOT, file), error })
		templates.push(...templateCommentProblems(file))
	}

	if (templates.length > 0) {
		console.error(
			'✗ 模板字符串内部的注释里出现了反引号 —— 它会提前结束模板：\n  ' +
				templates.join('\n  ') +
				'\n\n  改法：注释里不要用反引号（用「」或直接写标识符名）。\n',
		)
	}
	if (syntax.length > 0) {
		console.error('✗ 语法错误（探针脚本加载失败会让整个应用起不来）：')
		for (const { file, error } of syntax)
			console.error(`\n  ${file}\n    ${error}`)
		console.error('')
	}

	if (syntax.length + templates.length === 0) {
		console.log(`✅ ${files.length} 个脚本语法正确，没有模板/反引号问题`)
		return
	}
	process.exit(1)
}

main()
