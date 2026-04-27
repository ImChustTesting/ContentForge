import express from 'express';
import busboy from 'busboy';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { pool } from '../lib/db.js';
import { getBoss } from '../lib/queue.js';
import { requireAuth } from '../lib/auth.js';
import { renderPage, renderPartial } from '../lib/views.js';
import { logger } from '../lib/logger.js';

const router = express.Router();

const DATA_DIR = process.env.DATA_DIR || '/data';
const MAX_BYTES = 2 * 1024 ** 3;
const MAX_MINUTES = Number(process.env.MAX_SOURCE_MINUTES || 30);
const ALLOWED_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm']);

const createJobSchema = z.object({
  title: z.string().min(1).max(200),
  speakerCount: z.coerce.number().int().min(1).max(2),
  cameraCount: z.coerce.number().int().min(1).max(2)
});

router.get('/jobs', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        j.id, j.title, j.status, j.created_at, j.updated_at, j.last_error,
        (SELECT COUNT(*) FROM clips c WHERE c.job_id = j.id AND c.approved) AS approved_count,
        (SELECT COUNT(*) FROM clips c WHERE c.job_id = j.id AND c.status = 'ready') AS ready_count
      FROM jobs j
      WHERE j.user_id = $1
      ORDER BY j.updated_at DESC
      LIMIT 100
    `, [req.session.userId]);
    const html = await renderPage('jobs-list.html', { jobs: rows });
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

router.get('/jobs/new', requireAuth, async (req, res, next) => {
  try {
    const html = await renderPage('job-new.html', { maxMinutes: MAX_MINUTES });
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

router.post('/api/jobs', requireAuth, async (req, res, next) => {
  try {
    const parsed = createJobSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { title, speakerCount, cameraCount } = parsed.data;

    const { rows } = await pool.query(
      `INSERT INTO jobs (user_id, title, speaker_count, camera_count, status)
       VALUES ($1, $2, $3, $4, 'queued')
       RETURNING id`,
      [req.session.userId, title, speakerCount, cameraCount]
    );

    const jobId = rows[0].id;
    if (req.headers['hx-request']) {
      res.set('HX-Redirect', `/jobs/${jobId}/upload`);
      return res.status(204).end();
    }
    res.status(201).json({ id: jobId });
  } catch (err) {
    next(err);
  }
});

router.get('/jobs/:id/upload', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, title, status FROM jobs WHERE id = $1 AND user_id = $2',
      [req.params.id, req.session.userId]
    );
    if (!rows.length) return res.status(404).send('Job not found');
    if (rows[0].status !== 'queued') return res.redirect(`/jobs/${rows[0].id}`);
    const html = await renderPage('job-upload.html', { job: rows[0], maxMinutes: MAX_MINUTES });
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

router.post('/api/jobs/:id/upload', requireAuth, async (req, res, next) => {
  const jobId = req.params.id;
  const owned = await pool.query(
    'SELECT id, status FROM jobs WHERE id = $1 AND user_id = $2',
    [jobId, req.session.userId]
  );
  if (!owned.rows.length) return res.status(404).send('Job not found');
  if (owned.rows[0].status !== 'queued') {
    return res.status(409).send('Upload already received for this job');
  }

  const dir = path.join(DATA_DIR, 'uploads', jobId);
  await mkdir(dir, { recursive: true });

  let savedPath = null;
  let savedSize = 0;
  let aborted = false;
  let badExt = false;

  const bb = busboy({
    headers: req.headers,
    limits: { fileSize: MAX_BYTES, files: 1 }
  });

  bb.on('file', (_field, file, info) => {
    const ext = path.extname(info.filename || '').toLowerCase() || '.mp4';
    if (!ALLOWED_EXT.has(ext)) {
      badExt = true;
      file.resume();
      return;
    }
    savedPath = path.join(dir, `source${ext}`);
    const out = createWriteStream(savedPath);
    file.on('limit', () => {
      aborted = true;
      out.destroy();
    });
    file.on('data', (chunk) => {
      savedSize += chunk.length;
    });
    file.pipe(out);
  });

  bb.on('close', async () => {
    try {
      if (badExt) {
        return res.status(415).send('File type not supported. Use MP4 / MOV / MKV / WebM.');
      }
      if (aborted) {
        if (savedPath) await unlink(savedPath).catch(() => {});
        return res.status(413).send('File exceeds 2 GB.');
      }
      if (!savedPath) {
        return res.status(400).send('No file received.');
      }
      const st = await stat(savedPath).catch(() => null);
      const size = st?.size ?? savedSize;

      await pool.query(
        `INSERT INTO assets (job_id, kind, path, size_bytes, pinned)
         VALUES ($1, 'source', $2, $3, TRUE)`,
        [jobId, savedPath, size]
      );

      const boss = await getBoss();
      await boss.send('transcribe', { jobId });
      await pool.query(
        `UPDATE jobs SET status = 'transcribing', updated_at = NOW() WHERE id = $1`,
        [jobId]
      );

      logger.info({ jobId, size }, 'source uploaded, transcribe enqueued');
      if (req.headers['hx-request']) {
        res.set('HX-Redirect', `/jobs/${jobId}`);
        return res.status(204).end();
      }
      res.status(201).json({ id: jobId, size });
    } catch (err) {
      next(err);
    }
  });

  bb.on('error', (err) => next(err));
  req.pipe(bb);
});

router.get('/jobs/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM jobs WHERE id = $1 AND user_id = $2',
      [req.params.id, req.session.userId]
    );
    if (!rows.length) return res.status(404).send('Job not found');
    const job = rows[0];
    const ctx = await buildJobContext(job);
    const html = await renderPage('job-detail.html', ctx);
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

router.get('/api/jobs/:id/status', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM jobs WHERE id = $1 AND user_id = $2',
      [req.params.id, req.session.userId]
    );
    if (!rows.length) return res.status(404).send('Job not found');
    const job = rows[0];
    const ctx = await buildJobContext(job);
    const html = await renderPartial('partials/job-status.html', ctx);
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

async function buildJobContext(job) {
  const { rows: clips } = await pool.query(
    `SELECT c.*, t.path AS thumb_path
     FROM clips c
     LEFT JOIN assets t ON t.id = c.thumb_asset_id
     WHERE c.job_id = $1
     ORDER BY c.clip_index`,
    [job.id]
  );
  return { job, clips };
}

export default router;
