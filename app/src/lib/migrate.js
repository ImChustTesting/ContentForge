import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pool } from './db.js';
import { logger } from './logger.js';

const MIGRATIONS_DIR = path.resolve(process.cwd(), '..', 'db', 'migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function runMigrations() {
  let dir;
  try {
    dir = await readdir(MIGRATIONS_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.warn({ dir: MIGRATIONS_DIR }, 'no migrations dir found; skipping');
      return;
    }
    throw err;
  }

  const files = dir.filter((f) => f.endsWith('.sql')).sort();

  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const { rows: appliedRows } = await client.query(
      'SELECT filename FROM migrations'
    );
    const applied = new Set(appliedRows.map((r) => r.filename));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      logger.info({ file }, 'applying migration');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
          [file]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error({ file, err: err.message }, 'migration failed');
        throw err;
      }
    }
    logger.info({ count: files.length }, 'migrations up to date');
  } finally {
    client.release();
  }
}
