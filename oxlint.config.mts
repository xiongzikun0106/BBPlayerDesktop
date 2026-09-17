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
		'**/*.js',
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
			 * 只关这三条；`no-unused-vars` / `typescript/*` 这些能抓到真问题的
			 * 规则保持开启。
			 */
			files: ['scripts/**/*.{mjs,mts,js,ts}'],
			rules: {
				'no-shadow': 'allow',
				'no-underscore-dangle': 'allow',
				'promise/no-multiple-resolved': 'allow',
			},
		},
	],
})
