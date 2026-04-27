import { pool } from './db.js';
import { decrypt } from './encryption.js';

export async function loadJob(jobId) {
  const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
  return rows[0] ?? null;
}

export async function setJobStatus(jobId, status, extra = {}) {
  const params = [status, jobId];
  let setClauses = 'status = $1, updated_at = NOW()';
  if (extra.last_error !== undefined) {
    params.push(extra.last_error);
    setClauses += `, last_error = $${params.length}`;
  }
  await pool.query(`UPDATE jobs SET ${setClauses} WHERE id = $2`, params);
}

export async function loadClip(clipId) {
  const { rows } = await pool.query('SELECT * FROM clips WHERE id = $1', [clipId]);
  return rows[0] ?? null;
}

export async function setClipStatus(clipId, status) {
  await pool.query(
    'UPDATE clips SET status = $1, updated_at = NOW() WHERE id = $2',
    [status, clipId]
  );
}

export async function getSourcePath(jobId) {
  const { rows } = await pool.query(
    `SELECT path FROM assets
     WHERE job_id = $1 AND kind = 'source'
     ORDER BY created_at LIMIT 1`,
    [jobId]
  );
  return rows[0]?.path ?? null;
}

export async function getAsset(jobId, kind) {
  const { rows } = await pool.query(
    `SELECT * FROM assets
     WHERE job_id = $1 AND kind = $2
     ORDER BY created_at DESC LIMIT 1`,
    [jobId, kind]
  );
  return rows[0] ?? null;
}

export async function getClipAsset(clipId, kind) {
  const { rows } = await pool.query(`
    SELECT a.* FROM assets a
    JOIN clips c ON c.job_id = a.job_id
    WHERE c.id = $1 AND a.kind = $2
    ORDER BY a.created_at DESC LIMIT 1
  `, [clipId, kind]);
  return rows[0] ?? null;
}

export async function registerAsset(jobId, kind, path, sizeBytes, opts = {}) {
  const { rows } = await pool.query(
    `INSERT INTO assets (job_id, kind, path, size_bytes, pinned)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [jobId, kind, path, sizeBytes, !!opts.pinned]
  );
  return rows[0];
}

export async function getDecryptedAnthropicKey(userId) {
  const { rows } = await pool.query(
    `SELECT u.id AS user_id, s.anthropic_key, s.key_version
     FROM users u
     JOIN user_secrets s ON s.user_id = u.id
     ${userId ? 'WHERE u.id = $1' : ''}
     LIMIT 1`,
    userId ? [userId] : []
  );
  if (!rows.length) throw new Error('No user / Anthropic key configured');
  const { anthropic_key, key_version } = rows[0];
  return decrypt(anthropic_key, process.env.ENCRYPTION_KEY, key_version);
}

export async function logExecution(jobId, clipId, stage, status, extra = {}) {
  const { rows } = await pool.query(
    `INSERT INTO executions
       (job_id, clip_id, stage, status, started_at, finished_at, duration_ms, error_message, result)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      jobId, clipId, stage, status,
      extra.started_at ?? new Date(),
      extra.finished_at ?? null,
      extra.duration_ms ?? null,
      extra.error_message ?? null,
      extra.result ? JSON.stringify(extra.result) : null
    ]
  );
  return rows[0].id;
}

export async function getBrandConfig() {
  const { rows } = await pool.query('SELECT * FROM brand_config WHERE id = 1');
  return rows[0];
}
