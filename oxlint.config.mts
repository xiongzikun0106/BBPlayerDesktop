import { defineConfig } from 'oxlint'

export default defineConfig({
	plugins: [
		'react',
		'typescript',
		'unicorn',
		'eslint',
		'oxc',
		'import',
		'promise',
	],
	categories: {
		correctness: 'error',
		suspicious: 'error',
		pedantic: 'allow',
		perf: 'error',
		style: 'allow',
		restriction: 'allow',
	},
	env: {
		builtin: true,
		es2022: true,
		browser: true,
		node: true,
	},
	ignorePatterns: [
		'dist/*',
		'**/dm.d.ts',
		'**/dm.js',
		'**/dist/**',
		'**/build/**',
		'**/.expo/**',
		'**/node_modules/**',
		'**/*.config.mjs',
		/*
		 * ⚠️ 这里原来是一条「排除所有 js」的规则（glob 星号两枚 + 斜杠 + .js，
		 * 写法这里就不复述了 —— 它的 `*` 加 `/` 会在注释里**提前结束块注释**，
		 * 我第一版就是这么写的，直接让配置解析失败）。
		 *
		 * 本意是排除"生成的 / 配置型的 JS"，但**顺带把桌面端整个渲染进程也
		 * 排除掉了**（`apps/desktop/src/renderer` 下 20 个**手写**文件），
		 * 于是那批文件**从来没有被 lint 过**：`pnpm lint` 干净对它们是空的
		 * （实测把 `share.js` / `player.js` 复制成 `.cjs` 再跑，会报出问题）。
		 *
		 * 现在只排除真正需要排除的那几个，逐个写明理由 —— 全仓库被它挡住的
		 * JS 一共只有 7 个（移动端）+ 3 个（杂项），是可以点清的。
		 */
		'apps/mobile/expo-plugins/**', // Expo config plugin：跑在 Node 构建期，风格与 App 代码不同
		'apps/mobile/drizzle/**', // drizzle-kit 生成的迁移索引
		'apps/mobile/babel.config.js', // 构建配置（里面的 console 是构建日志）
		'apps/mobile/metro.config.js', // 构建配置
		'apps/mobile/index.js', // Expo 入口：`import 'expo-router/entry'` 是副作用导入
		'packages/splash/jest.config.js', // 测试配置，不是产品代码
		'packages/eslint-plugin/**', // 自定义 lint 规则本身（JS 写的插件，风格自成一派）
		'packages/logs/**',
		'packages/bottom-tabs-react-navigation/**',
		'packages/react-native-bottom-tabs/**',
		'**/worker-configuration.d.ts',
		'**/package-lock.json',
		'**/pnpm-lock.yaml',
		'.agents/**',
		'apps/update-server/web/src/components/ui/**', // shadcn/ui 组件，不考虑它的报错
	],
	rules: {
		'react/react-in-jsx-scope': 'off',
		'no-unused-vars': [
			'error',
			{
				args: 'all',
				argsIgnorePattern: '^_',
				caughtErrors: 'all',
				caughtErrorsIgnorePattern: '^_',
				destructuredArrayIgnorePattern: '^_',
				varsIgnorePattern: '^_',
				ignoreRestSiblings: true,
			},
		],
		'no-console': 'error',
		'import/no-unassigned-import': ['error', { allow: ['**/*.css'] }],
		'react-hooks/exhaustive-deps': 'error',
		'typescript/no-explicit-any': 'error',
		'typescript/no-misused-promises': ['error', { checksVoidReturn: false }],
		'typescript/no-unsafe-type-assertion': 'allow',
		'typescript/consistent-return': 'off',
		'no-underscore-dangle': ['error', { allow: ['__csrf'] }],
		'react/no-unstable-nested-components': 'off',

		// tanstack query
		'@tanstack/query/exhaustive-deps': 'error',
		'@tanstack/query/no-rest-destructuring': 'warn',
		'@tanstack/query/stable-query-client': 'error',
		'@tanstack/query/no-unstable-deps': 'error',
		'@tanstack/query/infinite-query-property-order': 'error',
		'@tanstack/query/no-void-query-fn': 'error',
		'@tanstack/query/mutation-property-order': 'error',

		// react-compiler
		'react-compiler/react-compiler': 'error',

		// bbplayer
		'bbplayer/no-navigate-after-modal-close': 'error',

		// react-hooks-extra
		'react-hooks-extra/no-direct-set-state-in-use-effect': 'off',
		'react-hooks-extra/no-unnecessary-use-prefix': 'error',
		'react-hooks-extra/prefer-use-state-lazy-initialization': 'error',

		// react-you-might-not-need-an-effect
		'react-you-might-not-need-an-effect/no-empty-effect': 'warn',
		'react-you-might-not-need-an-effect/no-adjust-state-on-prop-change': 'warn',
		'react-you-might-not-need-an-effect/no-reset-all-state-on-prop-change':
			'warn',
		'react-you-might-not-need-an-effect/no-event-handler': 'warn',
		'react-you-might-not-need-an-effect/no-pass-live-state-to-parent': 'warn',
		'react-you-might-not-need-an-effect/no-pass-data-to-parent': 'warn',
		'react-you-might-not-need-an-effect/no-manage-parent': 'warn',
		'react-you-might-not-need-an-effect/no-initialize-state': 'warn',
		'react-you-might-not-need-an-effect/no-chain-state-updates': 'warn',
		'react-you-might-not-need-an-effect/no-derived-state': 'warn',

		'eslint/no-await-in-loop': 'error',
		'always-return': 'allow',
		'no-array-sort': 'allow',
		'no-new-array': 'allow',
		'style-prop-object': 'allow',
		'no-map-spread': 'allow',
		'no-await-in-loop': 'allow',
	},
	settings: {
		react: {
			version: '19.2',
		},
	},
	jsPlugins: [
		'@tanstack/eslint-plugin-query',
		'eslint-plugin-react-compiler',
		{ name: 'bbplayer', specifier: './packages/eslint-plugin/index.js' },
		'eslint-plugin-react-hooks-extra',
		'eslint-plugin-react-you-might-not-need-an-effect',
		{ name: 'drizzle-js', specifier: 'eslint-plugin-drizzle' },
		{
			name: 'import-alias',
			specifier: './oxlint-plugins/import-alias.mjs',
		},
	],
	overrides: [
		{
			/**
			 * 桌面端**渲染进程**（`apps/desktop/src/renderer` 下的手写 .js）。
			 *
			 * 这批文件是纯 DOM/JS 模块（不是 React，也不进打包器），因此：
			 *
			 * * `no-console` 放开：渲染进程**没有别的日志出口** ——
			 *   `renderer.js` 的 `log()` 要同时写进界面日志面板
			 *   （`Ctrl+Shift+L` 可显示）和 devtools 控制台，另外 5 处是
			 *   catch / 冲突分支里的 `warn`/`error`。那不是"忘了删的调试输出"。
			 * * 其余规则（含 `correctness` / `suspicious` 两档）**照常生效** ——
			 *   这里只放开了这一条，别把整个目录变成免检区。
			 */
			files: ['apps/desktop/src/renderer/**/*.js'],
			rules: {
				'no-console': 'allow',
				/**
				 * 渲染进程的**全局标记**用的是双下划线前缀，与 `__csrf` 同一个
				 * 理由：它们是"跨模块/跨进程约定的名字"，不是普通字段。
				 *
				 * * `__bbReady` / `__bbLyricsWindowReady` —— 探针与主进程等的
				 *   "界面已就绪"信号（`renderer.js` 的 boot、独立歌词窗口）；
				 * * `__lyricsPanel` / `__lyricsPanelUtils` / `__lyricsLab` ——
				 *   歌词面板的调试/自动化出口（独立页面 `lyrics-lab.html` 也用）。
				 *
				 * 逐个列出而不是关掉整条规则：这几个名字是要**稳定**的契约，
				 * 新增一个就得显式加到这里来。
				 */
				'no-underscore-dangle': [
					'error',
					{
						allow: [
							'__csrf',
							'__bbReady',
							'__bbLyricsWindowReady',
							'__lyricsPanel',
							'__lyricsPanelUtils',
							'__lyricsLab',
						],
					},
				],
				/**
				 * ⚠️ 这条规则**在这个目录里是错的**，不是"嫌麻烦关掉"。
				 *
				 * 它要求把"没有捕获任何外层变量"的函数**移到外层作用域**。
				 * 但渲染进程的 20 个模块都是 `index.html` 里的**普通 `<script>`**
				 * （不是 ES module、没有打包器），每个文件是 `;(function(){…})()`
				 * 包起来的 —— 所以"外层作用域"就是**全局对象**。
				 *
				 * 于是它的建议会变成"把模块级助手提升为全局函数"。而这些名字是
				 * **重复的**（实测：`setStatus` 出现在 9 个文件、`formatTime` 3 个），
				 * 提升之后就是 9 个同名全局函数互相覆盖 —— 后加载的脚本静默胜出，
				 * 每个文件调到的都可能是别人的实现。这是**规则自己引入的 bug**，
				 * 比它想避免的"每次调用重建一个函数"严重得多。
				 *
				 * 例外：真正**嵌在函数体内**的助手（确实每次调用都会重建）该移的
				 * 已经移到了各自模块的顶层 —— 那是这条规则唯一有价值的部分。
				 */
				'unicorn/consistent-function-scoping': 'allow',
			},
		},
		{
			files: ['apps/mobile/src/**/*.{ts,tsx,mts,cts}'],
			rules: {
				'import-alias/prefer-alias': [
					'error',
					{
						alias: {
							'@': './apps/mobile/src',
						},
						aliasForSubpaths: true,
					},
				],
			},
		},
		{
			files: ['packages/**/*.{ts,tsx,js,jsx}'],
			rules: {
				'no-console': 'allow',
			},
		},
		{
			files: ['apps/hot-update-cli/**/*.{ts,js}'],
			rules: {
				'no-console': 'allow',
			},
		},
		{
			/**
			 * 验证脚本（`scripts/verify-*.{mjs,mts}`）。
			 *
			 * 这些脚本有一种固有写法：把**一段函数序列化**后交给子进程执行
			 * （见 `verify-download.mjs` 的 `runInDesktop`）。函数体在子进程里
			 * 是自包含的，因此会重新 `require('node:fs')` —— 在静态分析看来
			 * 就是对外层同名导入的 shadow，但在运行时是**两个不同进程**，
			 * 不存在真正的遮蔽。`__RESULT__` / `__error` 这类哨兵名同理，
			 * 用双下划线是为了避免与业务字段撞名。
			 *
			 * `promise/no-multiple-resolved` 也一并关掉：脚本里常用
			 * 「轮询 + 超时」两个触发源，标准写法就是 `settled` 布尔守卫，
			 * 但该规则**不识别这个模式**（实测加了守卫、并把清理拆到两个
			 * 触发源里，仍然报）。重复 resolve 的真实风险由「脚本给出错误
			 * 结论」暴露，代价很低。
			 *
			 * `typescript/no-explicit-any` 也一并关掉，但**仅限这些脚本**：探针
			 * 的断言对象是子进程 `JSON.stringify` 出来的，跨进程边界后静态类型
			 * 已经丢失，写 `as ProbeResult` 只是把 `any` 换成名字更好听的
			 * `any`（真正能保护这些断言的是运行时的 `check()`，不是类型）。
			 * 业务代码里的 `any` 依然报错 —— 那里类型是真的、能抓到问题。
			 *
			 * 只关这四条；`no-unused-vars` / 其余 `typescript/*` 这些能抓到真
			 * 问题的规则保持开启。
			 */
			files: ['scripts/**/*.{mjs,mts,js,ts}'],
			rules: {
				'no-shadow': 'allow',
				'no-underscore-dangle': 'allow',
				'promise/no-multiple-resolved': 'allow',
				'typescript/no-explicit-any': 'allow',
			},
		},
	],
})
