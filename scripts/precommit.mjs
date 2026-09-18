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
/**
 * 与 `runTool` 相同，但**接住输出**而不是直接继承 stdio。
 *
 * 有些工具的"没有可检查的文件"是通过 stdout 文案加退出码 1 表达的，
 * 必须读输出才能区分"真的失败"与"无事可做"。
 */
function runToolCaptured(tool, label, args) {
	const entry = resolveWorkspaceTool(tool)
	if (!entry) {
		return {
			status: 1,
			stdout: '',
			stderr: `在 node_modules 中找不到 ${tool}`,
		}
	}
	const result = spawnSync(process.execPath, [entry, ...args], {
		cwd: ROOT,
		encoding: 'utf8',
		shell: false,
	})
	void label
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	}
}

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

	/*
	 * 探针脚本的静态检查。
	 *
	 * 探针驱动跑在 Electron 主进程里，**加载失败 = 整个应用起不来**
	 * （弹 "A JavaScript error occurred in the main process"），
	 * 而不是"某条断言失败"。我在这个仓库里踩过**四次**同一个坑：
	 * 在模板字符串内部的注释里写反引号 —— 它会当场结束模板，
	 * 后面的内容变成代码。最阴的是全局反引号数量仍然配平，
	 * 所以"数奇偶"的校验看不出来。
	 *
	 * 只在暂存里含 `.cjs` / `.mjs` / `.js` 时才跑（否则是白等一次进程启动）。
	 */
	if (files.some((file) => hasExtension(file, ['.cjs', '.mjs', '.js']))) {
		console.log('\n▸ 探针脚本静态检查（语法 + 模板/反引号）')
		// 这是仓库自己的脚本，不经过 `runTool`（那个是给 node_modules 里的
		// 工具用的，会去找同名包，对本地脚本找不到）
		const result = spawnSync(
			process.execPath,
			['scripts/check-probe-syntax.mjs'],
			{ cwd: ROOT, stdio: 'inherit', shell: false },
		)
		if (result.status !== 0) {
			console.error('✗ 探针脚本静态检查未通过')
			return 1
		}
	}

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
		/*
		 * ⚠️ oxlint 在"传进来的文件**全被 ignorePatterns 排除**"时会打印
		 * 「No files found to lint」并**退出码 1**，钩子于是判失败。
		 *
		 * 但"没有可检查的文件"不是失败。本仓库的 oxlint.config.mts 把
		 * 所有 .js 文件都排除了（移动端有大量生成的 JS），于是**整个桌面端
		 * 渲染进程（renderer 下的 .js）都在忽略范围里** ——
		 * 只改这类文件的提交永远过不了钩子。实测撞到过一次（只暂存 share.js）。
		 *
		 * 所以把输出接住：只有"确实没有文件可查"才放行，真有 lint 错误照常失败。
		 *
		 * 另注：写这段注释时踩了个坑 —— 在块注释里写 glob（星号加斜杠）
		 * 会把注释**提前结束**掉。所以这里用文字描述，不写那个模式。
		 */
		const lint = runToolCaptured('oxlint', 'oxlint', [
			'--type-aware',
			...lintTargets,
		])
		const output = `${lint.stdout}${lint.stderr}`
		const nothingToLint = /No files found to lint/.test(output)
		if (lint.status !== 0 && !nothingToLint) {
			process.stdout.write(output)
			console.error('✗ oxlint 失败')
			return 1
		}
		if (nothingToLint) {
			console.log(`  （${lintTargets.length} 个文件都在忽略范围内，跳过）`)
		} else {
			process.stdout.write(output)
		}
	}

	console.log('\n✅ pre-commit 检查通过')
	return 0
}

process.exit(main())
