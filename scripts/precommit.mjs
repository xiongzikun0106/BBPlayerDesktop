/* oxlint-disable no-console -- CLI 脚本，以 stdout 为输出 */
/**
 * pre-commit 钩子的全部逻辑，用 Node 实现。
 *
 * 为什么不写在 `lefthook.yml` 的 `run` 里：
 *  1. lefthook 会把自己的 `{...}` 模板语法套用到 `run` 脚本正文上，正文里的
 *     `${#files[@]}` 会被它当成占位符处理（实测被替换成 `0files[@]`），脚本随即坏掉；
 *  2. `{staged_files}` 展开时**不加引号**，本仓库存在 `app/(tabs)/index.tsx`、
 *     `app/comments/[bvid].tsx` 这类路径，括号会让 shell 数组赋值直接语法错误；
 *  3. `run` 里的脚本由 `sh` 执行（Windows 上是 `cmd`），两个平台行为不一致。
 *
 * 放进 Node 后上述问题都不存在：路径通过 argv / git 命令获取，不经 shell 解析。
 *
 * 用法：
 *   node scripts/precommit.mjs              # 作为 pre-commit 钩子运行
 *   node scripts/precommit.mjs --check      # 只检查不写回（CI 友好）
 *   node scripts/precommit.mjs a.ts b.tsx   # 显式指定文件（调试用）
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const CHECK_ONLY = process.argv.includes('--check')

/** 需要交给 oxfmt 的扩展名（与原 lefthook glob 保持一致） */
const FORMAT_EXTENSIONS = [
	'.js',
	'.ts',
	'.cjs',
	'.mjs',
	'.cts',
	'.mts',
	'.jsx',
	'.tsx',
	'.json',
	'.jsonc',
	'.yml',
	'.yaml',
	'.toml',
	'.md',
	'.mdx',
]

/** 需要交给 oxlint 的扩展名 */
const LINT_EXTENSIONS = [
	'.js',
	'.ts',
	'.cjs',
	'.mjs',
	'.cts',
	'.mts',
	'.jsx',
	'.tsx',
]

const GITLEAKS_BASELINE = '.gitleaks-baseline.json'

function gitOutput(args) {
	return execFileSync('git', args, {
		cwd: ROOT,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	})
}

/** 暂存区中新增/修改/重命名的文件（排除删除） */
function stagedFiles() {
	return gitOutput([
		'diff',
		'--cached',
		'--name-only',
		'--diff-filter=ACMR',
		'-z',
	])
		.split('\0')
		.filter(Boolean)
}

const hasExtension = (file, extensions) => {
	const lower = file.toLowerCase()
	return extensions.some((extension) => lower.endsWith(extension))
}

/** 只保留工作区中确实存在的文件（重命名后旧路径可能已不存在） */
const existingOnly = (files) =>
	files.filter((file) => existsSync(path.join(ROOT, file)))

/**
 * 把格式化后的文件重新加入暂存区。
 *
 * 用 `git add -- <files>`，路径以数组传入、不经 shell，因此含括号/方括号的
 * 路径同样安全。
 */
function restage(files) {
	try {
		execFileSync('git', ['add', '--', ...files], {
			cwd: ROOT,
			stdio: ['ignore', 'ignore', 'pipe'],
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(`⚠ 重新暂存格式化结果失败：${message}`)
	}
}

/**
 * 解析 workspace 内某工具的 JS 入口。
 *
 * 不用 `pnpm exec`：Windows 上它是 `pnpm.cmd`，必须经 `cmd.exe` 执行，
 * 而 `cmd.exe` 会把参数里的 `(` `)`（本仓库有 `app/(tabs)/index.tsx`）当成
 * 分组符号，导致 `… was unexpected at this time`。
 *
 * 直接用 `node <entry>` 则完全不经 shell，参数按数组传递，绝对安全。
 */
function resolveWorkspaceTool(name) {
	const candidates = [
		path.join(ROOT, 'node_modules', name, 'bin', name),
		path.join(ROOT, 'node_modules', '.bin', name),
	]
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate
	}
	return null
}

/**
 * 运行 workspace 内工具（oxfmt / oxlint）。不经 shell，因此路径中的
 * 括号、方括号、空格都不会引发解析问题。
 */
function runTool(label, tool, args) {
	const entry = resolveWorkspaceTool(tool)
	if (!entry) {
		console.error(
			`✗ ${label}: 在 node_modules 中找不到 ${tool}，请先执行 pnpm install`,
		)
		return false
	}

	const result = spawnSync(process.execPath, [entry, ...args], {
		cwd: ROOT,
		stdio: 'inherit',
		shell: false,
	})
	if (result.error) {
		console.error(`✗ ${label}: ${result.error.message}`)
		return false
	}
	if (result.status !== 0) {
		console.error(`✗ ${label} 失败（exit ${result.status}）`)
		return false
	}
	return true
}

function runGitleaks() {
	const probe = spawnSync('gitleaks', ['--version'], {
		stdio: 'ignore',
		shell: false,
	})
	if (probe.error) {
		console.log('⚠ gitleaks 未安装，跳过密钥扫描')
		return true
	}

	const args = ['protect', '--staged', '--verbose']
	if (existsSync(path.join(ROOT, GITLEAKS_BASELINE))) {
		// 用 `=` 形式传值，避免以 `/` 开头的值被当成选项
		args.push(`--baseline-path=${GITLEAKS_BASELINE}`)
	}

	const result = spawnSync('gitleaks', args, {
		cwd: ROOT,
		stdio: 'inherit',
		shell: false,
	})
	if (result.status !== 0) {
		console.error('✗ gitleaks 发现疑似密钥')
		return false
	}
	return true
}

function main() {
	const explicit = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
	const files = explicit.length > 0 ? explicit : stagedFiles()

	if (files.length === 0) {
		console.log('没有暂存文件，跳过检查。')
		return 0
	}

	console.log(`暂存文件 ${files.length} 个，开始 pre-commit 检查…`)

	if (!runGitleaks()) return 1

	const formatTargets = existingOnly(
		files.filter((file) => hasExtension(file, FORMAT_EXTENSIONS)),
	)
	const lintTargets = existingOnly(
		files.filter((file) => hasExtension(file, LINT_EXTENSIONS)),
	)

	if (formatTargets.length > 0) {
		console.log(
			`\n▸ oxfmt ${CHECK_ONLY ? '--check' : '--write'}（${formatTargets.length} 个文件）`,
		)
		if (
			!runTool('oxfmt', 'oxfmt', [
				'--no-error-on-unmatched-pattern',
				...(CHECK_ONLY ? ['--check'] : ['--write']),
				...formatTargets,
			])
		)
			return 1

		// oxfmt 是原地写回，改完的文件必须重新暂存，否则格式化只在工作区生效、
		// 没有被提交（原 lefthook 配置里的 `stage_fixed: true` 就是干这个的）。
		if (!CHECK_ONLY) restage(formatTargets)
	}

	if (lintTargets.length > 0) {
		console.log(`\n▸ oxlint（${lintTargets.length} 个文件）`)
		if (!runTool('oxlint', 'oxlint', ['--type-aware', ...lintTargets])) return 1
	}

	console.log('\n✅ pre-commit 检查通过')
	return 0
}

process.exit(main())
