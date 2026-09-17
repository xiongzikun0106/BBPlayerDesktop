#!/usr/bin/env node
/**
 * BBPlayer 更新发布工具。
 *
 * 发布**两条互不相干的更新通道**：
 *
 * 1. **移动端**：`update.json` -> Cloudflare Workers KV 的 `update_json` 键，
 *    由 `apps/backend` 的 `GET /update.json` 提供，移动端
 *    `updateService.ts` 消费。
 * 2. **桌面端**：`electron-builder` 生成的 `latest*.yml`（electron-updater
 *    的 feed）加安装包本体，走 **generic provider**。
 *
 * ⚠️ **为什么两条通道不能合并**（这是本文件最重要的一条设计约束）：
 *
 * * 移动端的 `parseDownloads` 只读 `downloads.android`，**其它键会被静默丢弃**；
 * * `update.json` 只有一个全局 `version` 与一个 `url`，而桌面端是**独立版本线**
 *   （从 `0.1.0` 起步）与移动端（`2.7.0-alpha.1`）无法共用一个 version；
 * * 移动端拿 `version` 和**自己**的原生版本比较（`Application.nativeApplicationVersion`），
 *   若把桌面版本写进去，移动端会看到「有 0.1.0 更新」而自己的 2.7.x 更大 ——
 *   逻辑上直接矛盾。
 *
 * 因此：`update.json` **保持移动端契约不变**，桌面端产物只做
 * 「收集 / 校验 / 报告」，实际的 feed 上传由分发主机负责（配置见
 * `apps/desktop/electron-builder.yml` 的 `publish.url`）。
 *
 * 桌面端那部分的核心价值在**校验**：electron-updater 在更新时会核对
 * `latest*.yml` 里的 `sha512` 与 `size`，对不上就**拒绝更新**
 * （用户看到的是「更新失败」，而且往往已经发过版了）。这里在发布前就把
 * 这个问题挡掉。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
	cancel,
	confirm,
	intro,
	isCancel,
	log,
	note,
	outro,
	select,
	spinner,
} from '@clack/prompts'

interface GitHubAsset {
	name: string
	browser_download_url: string
}

interface GitHubRelease {
	tag_name: string
	name: string | null
	body: string | null
	html_url: string
	draft: boolean
	prerelease: boolean
	published_at: string | null
	assets: GitHubAsset[]
}

/**
 * 桌面端某个安装包的记录。
 *
 * `key` 是**格式 + 目标**的组合而不是单纯的扩展名：`.exe` 在 NSIS 安装器与
 * portable 之间是**歧义**的（两者都是 `.exe`），只靠扩展名分不出来。
 * 文件名里的 `-nsis-setup` / `-portable` 后缀由 `electron-builder.yml` 的
 * `nsis.artifactName` / `portable.artifactName` 保证。
 */
interface DesktopArtifact {
	key: string
	name: string
	url: string
	size: number | null
}

interface DesktopFeed {
	/** 平台标识：windows / linux */
	platform: string
	/** feed 文件名，如 latest.yml / latest-linux.yml */
	name: string
	url: string
	version: string | null
	files: Array<{ url: string; sha512: string; size: number }>
}

interface UpdateManifest {
	version: string
	url: string
	downloads?: {
		android?: Record<string, string>
	}
	notes: string
	listed_notes?: string[]
	forced: boolean
	/**
	 * 桌面端信息，**纯信息性**：桌面端不读这个字段（它走 electron-updater
	 * 的 `latest*.yml`）。放在这里是为了让「这次发布包含哪些桌面产物」
	 * 有单一可查的记录，而且移动端会忽略未知键，所以对它是无害的。
	 */
	desktop?: {
		artifacts: DesktopArtifact[]
		feeds: Array<Pick<DesktopFeed, 'platform' | 'name' | 'url' | 'version'>>
	}
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const DESKTOP_DIST = resolve(REPO_ROOT, 'apps/desktop/dist')
const DEFAULT_REPO = 'bbplayer-app/BBPlayer'
const UPDATE_KEY = 'update_json'
const ANDROID_ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'] as const

// ---------------------------------------------------------------
// 命令行参数
// ---------------------------------------------------------------

interface CliOptions {
	/** 跳过编辑器，直接用生成的 manifest（CI / 无编辑器环境） */
	noEdit: boolean
	/** 只做校验与报告，不写 KV（默认对桌面端就是只读） */
	dryRun: boolean
	repo: string | null
	/** 只处理桌面端产物，不碰移动端的 update.json */
	desktopOnly: boolean
	help: boolean
}

/**
 * 解析参数。
 *
 * 加这些开关的直接原因是**原来的流程无法在无人值守环境里跑**：
 * 它必须先打开 Zed 等用户保存关闭，而 Zed 路径是硬编码的 macOS 路径，
 * 没有 `$EDITOR` 回退、也没有跳过编辑的开关 —— 在没有 Zed 的机器上
 * 直接 spawn 失败、什么都不会发布。
 */
function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		noEdit: false,
		dryRun: false,
		repo: null,
		desktopOnly: false,
		help: false,
	}

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (arg === '--no-edit') options.noEdit = true
		else if (arg === '--dry-run') options.dryRun = true
		else if (arg === '--desktop-only') options.desktopOnly = true
		else if (arg === '--help' || arg === '-h') options.help = true
		else if (arg === '--repo') {
			options.repo = argv[index + 1] ?? null
			index += 1
		}
	}
	return options
}

function printHelp() {
	// oxlint-disable-next-line no-console -- CLI 帮助必须走 stdout
	console.log(
		[
			'用法: pnpm publish:update [选项]',
			'',
			'选项:',
			'  --no-edit       跳过编辑器，直接使用生成的 manifest（CI 用）',
			'  --dry-run       只校验与报告，不写入 Cloudflare KV',
			'  --desktop-only  只处理桌面端产物（不碰移动端的 update.json）',
			'  --repo <owner/name>  覆盖 GitHub 仓库（默认 $BBPLAYER_UPDATE_REPO 或上游）',
			'  -h, --help      显示本帮助',
			'',
			'环境变量:',
			'  BBPLAYER_UPDATE_REPO  GitHub 仓库，默认 bbplayer-app/BBPlayer',
			'  GITHUB_TOKEN          GitHub API token（可选，用于提高速率上限）',
			'  VISUAL / EDITOR       编辑器的可执行文件（优先 VISUAL）',
			'',
			'说明: 桌面端更新走 electron-updater 的 latest*.yml（generic provider），',
			'      不通过 update.json —— 后者是移动端契约。本工具对桌面产物做',
			'      收集、sha512 校验与报告。',
		].join('\n'),
	)
}

// ---------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------

async function main() {
	const options = parseArgs(process.argv.slice(2))
	if (options.help) {
		printHelp()
		return
	}

	intro('BBPlayer update publisher')

	// 桌面端产物：**先做**，因为它不需要网络也不需要交互，
	// 失败能立刻发现（而不是等用户选完 release 才报错）。
	const desktop = await inspectDesktopArtifacts()
	reportDesktopArtifacts(desktop)

	if (options.desktopOnly) {
		if (desktop.problems.length > 0) {
			outro(`桌面端产物有 ${desktop.problems.length} 个问题，请先修复`)
			process.exitCode = 1
			return
		}
		outro('桌面端产物校验通过（update.json 未改动）')
		return
	}

	const repo = options.repo ?? process.env.BBPLAYER_UPDATE_REPO ?? DEFAULT_REPO
	const releaseSpinner = spinner()
	releaseSpinner.start(`Fetching recent releases from ${repo}`)
	const releases = await fetchRecentReleases(repo)
	releaseSpinner.stop(`Fetched ${releases.length} releases`)

	const selected = await selectRelease(releases)
	const manifest = createManifest(selected, desktop)
	const tempPath = await writeTempManifest(manifest)

	// 编辑步骤：只有确实有编辑器时才打开；`--no-edit` 直接跳过
	if (!options.noEdit) {
		await editManifest(tempPath)
	} else {
		log.info('--no-edit：跳过编辑器，直接使用生成的 manifest')
	}

	const edited = await readManifest(tempPath)
	printManifestSummary(edited)

	if (options.dryRun) {
		outro(`--dry-run：已生成 ${tempPath}，未写入 KV`)
		return
	}

	const shouldPublish = await confirm({
		message: 'Publish this update.json to Cloudflare KV?',
		initialValue: false,
	})
	if (isCancel(shouldPublish)) {
		cancel('Cancelled')
		return
	}
	if (!shouldPublish) {
		outro(`Not published. Edited file remains at ${tempPath}`)
		return
	}

	const publishSpinner = spinner()
	publishSpinner.start('Publishing update_json to Cloudflare Workers KV')
	await publishToWorkersKv(tempPath)
	publishSpinner.stop('Published update_json to Cloudflare Workers KV')
	outro('Done')
}

// ---------------------------------------------------------------
// 桌面端产物：收集 + 校验
// ---------------------------------------------------------------

interface DesktopInspection {
	exists: boolean
	artifacts: DesktopArtifact[]
	feeds: DesktopFeed[]
	problems: string[]
	feedUrl: string | null
}

/**
 * electron-builder 的 `publish.url`。
 *
 * 从 `electron-builder.yml` 里读，避免「配置里改了地址、工具里还是旧值」
 * 这种典型漂移。读不到就返回 null 并如实标注（不猜一个地址出来）。
 */
async function readDesktopFeedUrl(): Promise<string | null> {
	try {
		const yml = await readFile(
			resolve(REPO_ROOT, 'apps/desktop/electron-builder.yml'),
			'utf8',
		)
		// 只做最简单的取值，不引入 YAML 解析依赖（这个仓库没有 yaml 包）
		const section = /publish:\s*\n([\s\S]*?)(?:\n[a-z]+:|$)/.exec(yml)?.[1]
		if (!section) return null
		return /url:\s*(\S+)/.exec(section)?.[1]?.replace(/\/$/, '') ?? null
	} catch {
		return null
	}
}

/**
 * 扫描 `apps/desktop/dist`，收集桌面端产物与 electron-updater feed，
 * 并**校验 feed 与实际文件一致**。
 *
 * 校验的是 electron-updater 更新时真正会核对的两项：`sha512` 与 `size`。
 * 对不上它就会拒绝更新 —— 而那通常发生在已经发版之后。
 */
async function inspectDesktopArtifacts(): Promise<DesktopInspection> {
	const result: DesktopInspection = {
		exists: false,
		artifacts: [],
		feeds: [],
		problems: [],
		feedUrl: await readDesktopFeedUrl(),
	}

	let entries: string[]
	try {
		entries = await readdir(DESKTOP_DIST)
		result.exists = true
	} catch {
		result.problems.push(
			`没有找到桌面端产物目录 ${DESKTOP_DIST}（先跑 pnpm --filter @bbplayer/desktop run build:win / build:linux）`,
		)
		return result
	}

	const files = new Set(entries)

	for (const name of entries) {
		const key = classifyDesktopArtifact(name)
		if (!key) continue
		const full = join(DESKTOP_DIST, name)
		const info = await stat(full)
		// `.blockmap` 之类的附属文件不算产物
		if (!info.isFile()) continue
		result.artifacts.push({
			key,
			name,
			url: result.feedUrl ? `${result.feedUrl}/${name}` : name,
			size: info.size,
		})
	}

	// feed 文件：latest.yml（Windows）、latest-linux.yml（Linux）
	for (const name of entries.filter((n) => /^latest.*\.yml$/.test(n))) {
		const platform = name.includes('linux') ? 'linux' : 'windows'
		const full = join(DESKTOP_DIST, name)
		const text = await readFile(full, 'utf8')
		const parsed = parseUpdaterFeed(text)

		result.feeds.push({
			platform,
			name,
			url: result.feedUrl ? `${result.feedUrl}/${name}` : name,
			version: parsed.version,
			files: parsed.files,
		})

		// **核心校验**：feed 里的 size/sha512 必须与实际文件对得上
		for (const entry of parsed.files) {
			if (!files.has(entry.url)) {
				result.problems.push(`${name} 引用了不存在的文件 ${entry.url}`)
				continue
			}
			const info = await stat(join(DESKTOP_DIST, entry.url))
			if (info.size !== entry.size) {
				result.problems.push(
					`${entry.url} 大小不符：feed 说 ${entry.size}，实际 ${info.size}` +
						'（electron-updater 会因此在更新时报错）',
				)
			}
			const actualSha = await sha512Base64(join(DESKTOP_DIST, entry.url))
			if (actualSha !== entry.sha512) {
				result.problems.push(
					`${entry.url} 的 sha512 与 feed 不一致（electron-updater 会拒绝更新）`,
				)
			}
		}
	}

	if (result.artifacts.length > 0 && result.feeds.length === 0) {
		result.problems.push(
			'有安装包但没有 latest*.yml —— electron-updater 无法发现更新',
		)
	}
	if (result.feedUrl === null) {
		result.problems.push(
			'electron-builder.yml 里读不到 publish.url —— 分发地址未配置，' +
				'生成的 feed 指向本地相对路径',
		)
	}

	return result
}

/**
 * 按文件名判定桌面产物的类型。
 *
 * 返回 `null` 表示不是安装包。`.exe` 必须靠文件名后缀区分 NSIS 与 portable ——
 * 这也是 `electron-builder.yml` 里给两者分别设置 `artifactName` 的原因。
 */
function classifyDesktopArtifact(name: string): string | null {
	const lower = name.toLowerCase()
	// 卸载器/调试文件不是产物
	if (lower.startsWith('__uninstaller') || lower.endsWith('.blockmap'))
		return null

	if (lower.endsWith('.exe')) {
		if (lower.includes('-nsis-setup')) return 'windows-nsis'
		if (lower.includes('-portable')) return 'windows-portable'
		return 'windows-exe'
	}
	if (lower.endsWith('.deb')) return 'linux-deb'
	if (lower.endsWith('.rpm')) return 'linux-rpm'
	if (lower.endsWith('.appimage')) return 'linux-appimage'
	if (lower.endsWith('.dmg')) return 'macos-dmg'
	if (lower.endsWith('.zip')) return 'macos-zip'
	return null
}

/**
 * 解析 electron-updater 的 feed（只取我们需要的字段）。
 *
 * 不引入 YAML 依赖：feed 的结构是 electron-builder 生成的，形状稳定，
 * 用简单的行解析足够，而且**只读我们自己生成的文件**。
 */
function parseUpdaterFeed(text: string): {
	version: string | null
	files: Array<{ url: string; sha512: string; size: number }>
} {
	const version = /^version:\s*(\S+)$/m.exec(text)?.[1] ?? null
	const files: Array<{ url: string; sha512: string; size: number }> = []

	// files 段形如：
	//   - url: xxx.exe
	//     sha512: ...
	//     size: 123
	const block =
		/^files:\s*\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m.exec(text)?.[1] ?? ''
	for (const match of block.matchAll(
		/-\s*url:\s*(\S+)\s*\n\s*sha512:\s*(\S+)\s*\n\s*size:\s*(\d+)/g,
	)) {
		files.push({
			url: match[1],
			sha512: match[2],
			size: Number(match[3]),
		})
	}
	return { version, files }
}

/** electron-updater 用的是 base64 编码的 sha512 */
async function sha512Base64(file: string): Promise<string> {
	const data = await readFile(file)
	return createHash('sha512').update(data).digest('base64')
}

function reportDesktopArtifacts(inspection: DesktopInspection) {
	if (!inspection.exists) {
		log.warn(inspection.problems[0] ?? '没有桌面端产物')
		return
	}

	const lines: string[] = []
	if (inspection.feedUrl) {
		lines.push(`分发地址: ${inspection.feedUrl}`)
	} else {
		lines.push('分发地址: （未配置 publish.url）')
	}
	lines.push('')

	if (inspection.artifacts.length === 0) {
		lines.push('安装包: 无')
	} else {
		lines.push('安装包:')
		for (const artifact of inspection.artifacts) {
			const mb =
				artifact.size === null ? '?' : (artifact.size / 1024 / 1024).toFixed(1)
			lines.push(`  ${artifact.key.padEnd(18)} ${artifact.name}  (${mb} MB)`)
		}
	}

	lines.push('')
	if (inspection.feeds.length === 0) {
		lines.push('electron-updater feed: 无')
	} else {
		lines.push('electron-updater feed:')
		for (const feed of inspection.feeds) {
			lines.push(
				`  ${feed.platform.padEnd(8)} ${feed.name}  version=${feed.version ?? '?'}  ${feed.files.length} 个文件（sha512 已核对）`,
			)
		}
	}

	if (inspection.problems.length > 0) {
		lines.push('')
		lines.push('问题:')
		for (const problem of inspection.problems) lines.push(`  ✗ ${problem}`)
	}

	note(lines.join('\n'), '桌面端产物')
}

// ---------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------

async function fetchRecentReleases(repo: string): Promise<GitHubRelease[]> {
	const headers: Record<string, string> = {
		Accept: 'application/vnd.github+json',
		'User-Agent': '@bbplayer/update-publisher',
		'X-GitHub-Api-Version': '2022-11-28',
	}
	if (process.env.GITHUB_TOKEN) {
		headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
	}

	const url = `https://api.github.com/repos/${repo}/releases?per_page=8`
	const res = await fetch(url, { headers })
	if (!res.ok) {
		throw new Error(
			`GitHub releases request failed: ${res.status} ${res.statusText}`,
		)
	}

	const json: unknown = await res.json()
	if (!Array.isArray(json)) {
		throw new Error('GitHub releases response is not an array')
	}

	return json.map(parseRelease)
}

function parseRelease(value: unknown): GitHubRelease {
	if (typeof value !== 'object' || value === null) {
		throw new Error('Invalid GitHub release item')
	}
	const item = value as Record<string, unknown>
	const assets = Array.isArray(item.assets) ? item.assets.map(parseAsset) : []
	return {
		tag_name: requireString(item.tag_name, 'tag_name'),
		name: typeof item.name === 'string' ? item.name : null,
		body: typeof item.body === 'string' ? item.body : null,
		html_url: requireString(item.html_url, 'html_url'),
		draft: item.draft === true,
		prerelease: item.prerelease === true,
		published_at:
			typeof item.published_at === 'string' ? item.published_at : null,
		assets,
	}
}

function parseAsset(value: unknown): GitHubAsset {
	if (typeof value !== 'object' || value === null) {
		throw new Error('Invalid GitHub release asset')
	}
	const item = value as Record<string, unknown>
	return {
		name: requireString(item.name, 'asset.name'),
		browser_download_url: requireString(
			item.browser_download_url,
			'asset.browser_download_url',
		),
	}
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== 'string') {
		throw new Error(`Missing string field: ${field}`)
	}
	return value
}

async function selectRelease(
	releases: GitHubRelease[],
): Promise<GitHubRelease> {
	if (releases.length === 0) {
		throw new Error('No GitHub releases found')
	}

	const selected = await select({
		message: 'Select GitHub release',
		options: releases.map((release) => ({
			value: release.tag_name,
			label: formatReleaseLabel(release),
			hint: release.html_url,
		})),
	})

	if (isCancel(selected)) {
		cancel('Cancelled')
		process.exit(0)
	}

	const release = releases.find((item) => item.tag_name === selected)
	if (!release) {
		throw new Error(`Selected release not found: ${selected}`)
	}
	return release
}

function formatReleaseLabel(release: GitHubRelease): string {
	const flags = [release.draft ? 'draft' : '', release.prerelease ? 'pre' : '']
		.filter(Boolean)
		.join(', ')
	const date = release.published_at?.slice(0, 10) ?? 'unpublished'
	const name = release.name ? ` - ${release.name}` : ''
	return `${release.tag_name}${name} (${date}${flags ? `, ${flags}` : ''})`
}

// ---------------------------------------------------------------
// manifest
// ---------------------------------------------------------------

function createManifest(
	release: GitHubRelease,
	desktop: DesktopInspection,
): UpdateManifest {
	const notes = release.body ?? ''
	const android = collectAndroidDownloads(release.assets)
	const downloads = Object.keys(android).length > 0 ? { android } : undefined

	const manifest: UpdateManifest = {
		version: normalizeVersion(release.tag_name),
		url: release.html_url,
		downloads,
		notes,
		listed_notes: parseMarkdownListItems(notes),
		forced: false,
	}

	// 桌面端信息纯属附加记录：移动端会忽略未知键（实测 `parseDownloads`
	// 只读 `downloads.android`），但为免歧义，只在确实有产物时才写。
	if (desktop.artifacts.length > 0 || desktop.feeds.length > 0) {
		manifest.desktop = {
			artifacts: desktop.artifacts,
			feeds: desktop.feeds.map((feed) => ({
				platform: feed.platform,
				name: feed.name,
				url: feed.url,
				version: feed.version,
			})),
		}
	}

	return manifest
}

function collectAndroidDownloads(
	assets: GitHubAsset[],
): Record<string, string> {
	const downloads: Record<string, string> = {}
	for (const asset of assets) {
		if (!asset.name.toLowerCase().endsWith('.apk')) continue
		const abi = inferAndroidAbi(asset.name)
		if (abi) downloads[abi] = asset.browser_download_url
	}
	return downloads
}

function inferAndroidAbi(fileName: string): string | null {
	const normalized = fileName.toLowerCase()
	for (const abi of ANDROID_ABIS) {
		if (normalized.includes(abi)) return abi
	}
	if (normalized.includes('universal')) return 'universal'
	return null
}

function normalizeVersion(tag: string): string {
	return tag.startsWith('v') ? tag.slice(1) : tag
}

function parseMarkdownListItems(markdown: string): string[] | undefined {
	const items = markdown
		.split(/\r?\n/)
		.map((line) => line.match(/^\s*(?:[-*+]|\d+\.)\s+(.+?)\s*$/)?.[1])
		.filter((line): line is string => Boolean(line))
		.map((line) => line.replace(/\s+/g, ' ').trim())
		.map((line, index) => `${index + 1}. ${line}`)

	return items.length > 0 ? items : undefined
}

async function writeTempManifest(manifest: UpdateManifest): Promise<string> {
	const dir = resolve(REPO_ROOT, '.tmp/update-publisher')
	await mkdir(dir, { recursive: true })
	const path = resolve(dir, `update-${manifest.version}.json`)
	await writeFile(path, `${JSON.stringify(manifest, null, '\t')}\n`)
	return path
}

// ---------------------------------------------------------------
// 编辑器
// ---------------------------------------------------------------

/**
 * 解析编辑器命令。
 *
 * ⚠️ 原实现硬编码 `/Applications/Zed.app/Contents/MacOS/cli`，不存在就退回
 * 字符串 `'zed'`，而 `spawn('zed', …, { shell: false })` 在没有 Zed 的机器上
 * 直接失败 —— **整个发布流程中断，且什么都不会发布**。而且它没有跳过编辑的
 * 开关，所以在 CI 里根本跑不了。
 *
 * 现在的顺序：`$VISUAL` -> `$EDITOR` -> 平台默认（Windows 用 notepad，
 * 其它平台试 zed / nano / vi）。**任何情况下都有可用的回退**，
 * 而且返回值可能带参数（如 `code --wait`），所以拆成命令 + 参数。
 *
 * @returns {{command: string, args: string[]} | null} null 表示找不到编辑器
 */
async function resolveEditor(): Promise<{
	command: string
	args: string[]
} | null> {
	// 1) 环境变量优先（`$VISUAL` 是「全屏编辑器」的约定，优先于 `$EDITOR`）
	for (const envName of ['VISUAL', 'EDITOR'] as const) {
		const value = process.env[envName]?.trim()
		if (!value) continue
		const [command, ...args] = value.split(/\s+/)
		if (command) return { command, args }
	}

	// 2) 平台常见默认值
	const candidates: Array<{ command: string; args: string[] }> =
		process.platform === 'win32'
			? [
					{ command: 'notepad.exe', args: [] },
					{ command: 'code', args: ['--wait'] },
				]
			: [
					// macOS 的 Zed 是 app bundle 里的 cli
					{
						command: '/Applications/Zed.app/Contents/MacOS/cli',
						args: ['--wait'],
					},
					{ command: 'zed', args: ['--wait'] },
					{ command: 'nano', args: [] },
					{ command: 'vi', args: [] },
				]

	for (const candidate of candidates) {
		if (await commandExists(candidate.command)) return candidate
	}
	return null
}

/** 命令是否可执行（用 `--version` 探一次，最可靠） */
async function commandExists(command: string): Promise<boolean> {
	// 绝对路径直接看文件在不在
	if (command.includes('/') || command.includes('\\')) {
		try {
			await stat(command)
			return true
		} catch {
			return false
		}
	}
	try {
		await run(command, ['--version'], { cwd: REPO_ROOT, quiet: true })
		return true
	} catch {
		return false
	}
}

async function editManifest(path: string): Promise<void> {
	const editor = await resolveEditor()
	if (!editor) {
		log.warn(
			'找不到可用的编辑器（$VISUAL / $EDITOR 都没设置，平台默认也都不在）。\n' +
				'跳过编辑，直接使用生成的 manifest。\n' +
				`如需手工调整，可编辑：${path}`,
		)
		return
	}

	log.info(
		`Opening ${basename(path)} in ${editor.command}. ` +
			'Save and close the editor to continue.',
	)
	await run(editor.command, [...editor.args, path], { cwd: REPO_ROOT })
}

async function readManifest(path: string): Promise<UpdateManifest> {
	const raw = await readFile(path, 'utf8')
	const parsed: unknown = JSON.parse(raw)
	validateManifest(parsed)
	return parsed
}

function validateManifest(value: unknown): asserts value is UpdateManifest {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Edited update manifest must be a JSON object')
	}
	const manifest = value as Record<string, unknown>
	for (const field of ['version', 'url', 'notes']) {
		if (typeof manifest[field] !== 'string') {
			throw new Error(
				`Edited update manifest field "${field}" must be a string`,
			)
		}
	}
	if (typeof manifest.forced !== 'boolean') {
		throw new Error('Edited update manifest field "forced" must be a boolean')
	}
	if (
		manifest.listed_notes !== undefined &&
		(!Array.isArray(manifest.listed_notes) ||
			!manifest.listed_notes.every((item) => typeof item === 'string'))
	) {
		throw new Error(
			'Edited update manifest field "listed_notes" must be a string array',
		)
	}
}

function printManifestSummary(manifest: UpdateManifest) {
	const androidDownloads = manifest.downloads?.android
		? Object.keys(manifest.downloads.android)
		: []
	const desktopArtifacts = manifest.desktop?.artifacts?.length ?? 0
	const desktopFeeds = manifest.desktop?.feeds?.length ?? 0
	note(
		[
			`Version: ${manifest.version}`,
			`URL: ${manifest.url}`,
			`Android downloads: ${androidDownloads.join(', ') || 'none'}`,
			`Desktop artifacts: ${desktopArtifacts}（feed ${desktopFeeds} 个）`,
			`Listed notes: ${manifest.listed_notes?.length ?? 0}`,
			`Forced: ${manifest.forced}`,
		].join('\n'),
		'Prepared update.json',
	)
}

// ---------------------------------------------------------------
// 发布
// ---------------------------------------------------------------

async function publishToWorkersKv(path: string) {
	await run(
		'pnpm',
		[
			'--dir',
			'apps/backend',
			'exec',
			'wrangler',
			'kv',
			'key',
			'put',
			UPDATE_KEY,
			'--path',
			path,
			'--binding',
			'KV',
			'--remote',
		],
		{ cwd: REPO_ROOT },
	)
}

/**
 * 执行一个子进程。
 *
 * ⚠️ **Windows 上必须让 `pnpm` 经 shell 执行**：`pnpm` 在 Windows 上是
 * `pnpm.cmd`，而 Node 的 `spawn` 在 `shell: false` 下**不能直接执行 `.cmd`**
 * —— 报 `ENOENT`。本仓库在 `docs/DESKTOP_PLAN.md` 里已经记录过同一个坑
 * （lefthook 的 `spawnSync('pnpm', …, { shell: false })`）。
 *
 * 代价是经 shell 后参数会被 shell 解析，所以这里对含空格的参数加引号。
 * 我们的参数都是固定字面量或仓库内路径，风险可控。
 */
async function run(
	command: string,
	args: string[],
	options: { cwd: string; quiet?: boolean },
): Promise<void> {
	const useShell = process.platform === 'win32'
	const quoted = useShell
		? args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))
		: args

	await new Promise<void>((resolveRun, reject) => {
		const child = spawn(command, quoted, {
			cwd: options.cwd,
			stdio: options.quiet ? 'ignore' : 'inherit',
			shell: useShell,
		})
		child.on('error', reject)
		child.on('exit', (code) => {
			if (code === 0) {
				resolveRun()
				return
			}
			reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`))
		})
	})
}

main().catch((error: unknown) => {
	// oxlint-disable-next-line no-console
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
})
