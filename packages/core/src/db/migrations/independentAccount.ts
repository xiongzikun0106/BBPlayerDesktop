import { getCorePorts } from '../../ports/index'
import { DataMigration } from './state'

const migration = new DataMigration(
	'independent_account_v1',
	'independent_account_migrated_v1',
)

/** 将旧共享歌单账号状态清空，迁移到独立账号体系。 */
export function migrateIndependentAccountReset(): void {
	const { logger: log, db, storage } = getCorePorts()
	const logger = log.extend('migrateIndependentAccountReset')
	const sqlite = db.sqlite

	if (migration.isApplied()) return

	try {
		sqlite.withTransactionSync(() => {
			sqlite.runSync(
				`UPDATE playlists
				 SET share_id = NULL,
					 share_role = NULL,
					 last_share_sync_at = NULL
				 WHERE share_id IS NOT NULL
					OR share_role IS NOT NULL
					OR last_share_sync_at IS NOT NULL`,
			)
			sqlite.runSync(`DELETE FROM playlist_sync_queue`)
			migration.markAsApplied()
		})

		storage.delete('shared-playlist-members')
		storage.delete('bbplayer_jwt')
		logger.info('[account] 已清空旧共享歌单状态与同步队列')
	} catch (error) {
		logger.error('[account] 清空旧共享歌单状态失败:', error)
	}
}
