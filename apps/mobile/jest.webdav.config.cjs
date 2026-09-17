module.exports = {
	rootDir: '../..',
	testEnvironment: 'node',
	testMatch: ['<rootDir>/packages/core/src/backup/webdav-client.test.ts'],
	extensionsToTreatAsEsm: ['.ts'],
	// webdav 包只发布 ESM，必须让 jest 转换它
	transformIgnorePatterns: ['/node_modules/(?!(.pnpm/)?webdav)'],
	moduleNameMapper: {
		'^(\\.{1,2}/.*)\\.js$': '$1',
		// packages/core 通过子路径导出；jest 的 ts-jest 解析不到，这里显式映射回源码
		'^@bbplayer/core/db/schema$': '<rootDir>/packages/core/src/db/schema.ts',
		'^@bbplayer/core$': '<rootDir>/packages/core/src/index.ts',
	},
	transform: {
		'^.+\\.ts$': [
			'ts-jest',
			{
				tsconfig: {
					target: 'ES2022',
					module: 'ESNext',
					moduleResolution: 'Bundler',
					strict: true,
					esModuleInterop: true,
					isolatedModules: true,
					skipLibCheck: true,
					types: ['jest', 'node'],
					lib: ['ES2022', 'DOM'],
				},
				useESM: true,
			},
		],
	},
}
