import { getCorePorts } from '../../ports/index'

const DATA_MIGRATIONS_TABLE = '__bbplayer_data_migrations'

export const legacyMigrationKeys = [
	'db_schema_version',
	'sort_key_migrated_v1',
	'sort_key_migrated_v2', // gitleaks:allow
	'sort_key_migrated_v3',
	'play_history_migrated_v1',
	'independent_account_migrated_v1',
	'play_history_ms_migrated_v1',
] as const

type LegacyDataMigrationKey = Exclude<
	(typeof legacyMigrationKeys)[number],
	'db_schema_version' | 'sort_key_migrated_v1'
>

/**
 * A JS data migration and its one-time legacy MMKV marker.
 *
 * 平台能力通过 `getCorePorts()` 在**调用时**获取，而不是在模块加载时 ——
 * 这样各端只要在启动时 `registerCorePorts()` 即可，且 core 不需要 import
 * 任何平台库。
 */
export class DataMigration {
	public constructor(
		private readonly name: string,
		private readonly legacyStorageKey: LegacyDataMigrationKey,
	) {}

	public isApplied(): boolean {
		const { db, storage } = getCorePorts()
		db.sqlite.execSync(
			`CREATE TABLE IF NOT EXISTS ${DATA_MIGRATIONS_TABLE} (name TEXT PRIMARY KEY NOT NULL)`,
		)

		const applied = db.sqlite.getFirstSync<{ name: string }>(
			`SELECT name FROM ${DATA_MIGRATIONS_TABLE} WHERE name = ?`,
			[this.name],
		)
		if (applied) {
			storage.delete(this.legacyStorageKey)
			return true
		}

		const appliedInLegacyStorage =
			storage.getBoolean(this.legacyStorageKey) === true
		if (appliedInLegacyStorage) {
			this.markAsApplied()
		}
		storage.delete(this.legacyStorageKey)

		return appliedInLegacyStorage
	}

	public markAsApplied(): void {
		const { db } = getCorePorts()
		db.sqlite.runSync(
			`INSERT OR IGNORE INTO ${DATA_MIGRATIONS_TABLE} (name) VALUES (?)`,
			[this.name],
		)
	}
}

/** The SQL migration journal replaces these two obsolete MMKV-only markers. */
export function clearObsoleteLegacyMigrationKeys(): void {
	const { storage } = getCorePorts()
	storage.delete('db_schema_version')
	storage.delete('sort_key_migrated_v1')
}

/** Never let a destination device's legacy flags affect a restored database. */
export function clearLegacyMigrationKeys(): void {
	const { storage } = getCorePorts()
	for (const key of legacyMigrationKeys) {
		storage.delete(key)
	}
}
