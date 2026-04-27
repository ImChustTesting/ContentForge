import { unlink } from 'node:fs/promises';
import { pool } from '../lib/db.js';
import { logger } from '../lib/logger.js';

const SOURCE_TTL_DAYS = Number(process.env.SOURCE_TTL_DAYS || 30);

export async function runCleanup() {
  // Delete unpinned source files older than the TTL.
  const { rows: stale } = await pool.query(`
    SELECT id, path
    FROM assets
    WHERE kind = 'source'
      AND pinned = FALSE
      AND created_at < NOW() - INTERVAL '${SOURCE_TTL_DAYS} days'
    LIMIT 100
  `);
  let deleted = 0;
  for (const row of stale) {
    try {
      await unlink(row.path);
      deleted++;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn({ path: row.path, err: err.message }, 'cleanup: unlink failed');
        continue;
      }
    }
    await pool.query('DELETE FROM assets WHERE id = $1', [row.id]);
  }

  // Clean up orphaned 'work' files that no asset row references.
  // Skip in v1 — the `work/` dir is small and re-created on demand.

  logger.info({ deleted, candidates: stale.length }, 'cleanup pass complete');
}
