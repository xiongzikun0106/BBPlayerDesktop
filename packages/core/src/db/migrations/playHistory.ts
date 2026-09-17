import { getCorePorts } from '../../ports/index'
import { DataMigration } from './state'

const migration = new DataMigration(
	'play_history_v1',
	'play_history_migrated_v1',
)

/** 将 tracks 表中的 JSON 播放历史迁移到 play_history 表。 */
export function migratePlayHistory(): void {
	const { logger: log, db } = getCorePorts()
	const logger = log.extend('migratePlayHistory')
	const sqlite = db.sqlite

	if (migration.isApplied()) return

	try {
		const tracksTableInfo = sqlite.getAllSync<{ name: string }>(
			`PRAGMA table_info(tracks)`,
		)
		const hasOldColumn = tracksTableInfo.some(
			(column) => column.name === 'play_history',
		)
		if (!hasOldColumn) {
			logger.info(
				'[play_history] tracks 表中无 play_history 字段，无需执行数据迁移',
			)
			migration.markAsApplied()
			return
		}

		const tableExists = sqlite.getFirstSync<{ name: string }>(
			`SELECT name FROM sqlite_master WHERE type='table' AND name='play_history'`,
		)
		if (!tableExists) {
			logger.warn('[play_history] play_history 表尚未创建，跳过本次数据迁移')
			return
		}

		sqlite.withTransactionSync(() => {
			type Row = { id: number; play_history: string }
			const rows = sqlite.getAllSync<Row>(
				`SELECT id, play_history FROM tracks WHERE play_history IS NOT NULL AND play_history != '[]'`,
			)
			if (rows.length > 0) {
				for (const row of rows) {
					const history: unknown = JSON.parse(row.play_history)
					if (!Array.isArray(history)) continue
					for (const record of history) {
						sqlite.runSync(
							`INSERT INTO play_history (track_id, start_time, duration_played, completed, created_at)
							 VALUES (?, ?, ?, ?, (unixepoch() * 1000))`,
							[
								row.id,
								record.startTime,
								record.durationPlayed,
								record.completed ? 1 : 0,
							],
						)
					}
				}
				logger.info(
					`[play_history] 播放记录迁移完成，共处理 ${rows.length} 条歌曲记录`,
				)
			}
			migration.markAsApplied()
		})
	} catch (error) {
		logger.error('[play_history] 迁移过程中发生致命错误:', error)
	}
}
