import express from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pool, withTx } from '../lib/db.js';
import { getBoss } from '../lib/queue.js';
import { requireAuth } from '../lib/auth.js';
import { renderPartial } from '../lib/views.js';
import { logger } from '../lib/logger.js';

const router = express.Router();

router.post('/api/jobs/:id/approve', requireAuth, async (req, res, next) => {
  const jobId = req.params.id;
  try {
    const owned = await pool.query(
      'SELECT id, status FROM jobs WHERE id = $1 AND user_id = $2',
      [jobId, req.session.userId]
    );
    if (!owned.rows.length) return res.status(404).send('Job not found');
    if (owned.rows[0].status !== 'awaiting_approval') {
      return res.status(409).send('Job is not awaiting approval');
    }

    let clipIds = req.body?.clipIds ?? [];
    if (!Array.isArray(clipIds)) clipIds = [clipIds];
    clipIds = clipIds.filter(Boolean);

    if (clipIds.length === 0) {
      return res.status(400).send('Pick at least one clip.');
    }

    const approved = await withTx(async (client) => {
      const { rows: pending } = await client.query(
        'SELECT id FROM clips WHERE job_id = $1',
        [jobId]
      );
      const allIds = new Set(pending.map((r) => r.id));
      const okIds = clipIds.filter((id) => allIds.has(id));
      if (okIds.length === 0) {
        return [];
      }

      await client.query(
        `UPDATE clips SET approved = TRUE, updated_at = NOW()
         WHERE id = ANY($1::uuid[])`,
        [okIds]
      );
      await client.query(
        `DELETE FROM clips WHERE job_id = $1 AND id <> ALL($2::uuid[])`,
        [jobId, okIds]
      );
      await client.query(
        `UPDATE jobs SET status = 'editing', updated_at = NOW() WHERE id = $1`,
        [jobId]
      );
      return okIds;
    });

    if (approved.length === 0) {
      return res.status(400).send('No matching clip ids found.');
    }

    const boss = await getBoss();
    for (const clipId of approved) {
      await boss.send('edit', { jobId, clipId });
    }

    logger.info({ jobId, clipCount: approved.length }, 'clips approved, edit enqueued');

    if (req.headers['hx-request']) {
      res.set('HX-Redirect', `/jobs/${jobId}`);
      return res.status(204).end();
    }
    res.status(200).json({ approved });
  } catch (err) {
    next(err);
  }
});

router.get('/api/clips/:id/download', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.clip_index, j.title, a.path
      FROM clips c
      JOIN jobs j ON j.id = c.job_id
      LEFT JOIN assets a ON a.id = c.mp4_asset_id
      WHERE c.id = $1 AND j.user_id = $2
    `, [req.params.id, req.session.userId]);
    if (!rows.length || !rows[0].path) return res.status(404).send('Clip not ready');
    const { path: filePath, title, clip_index } = rows[0];
    const safeName = title.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40);
    const filename = `${safeName}_${clip_index}.mp4`;
    const st = await stat(filePath);
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Length': st.size,
      'Content-Disposition': `attachment; filename="${filename}"`
    });
    await pool.query(
      `UPDATE assets SET last_used_at = NOW() WHERE path = $1`,
      [filePath]
    );
    createReadStream(filePath).pipe(res);
  } catch (err) {
    next(err);
  }
});

router.get('/api/clips/:id/thumb', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT a.path
      FROM clips c
      JOIN jobs j ON j.id = c.job_id
      LEFT JOIN assets a ON a.id = c.thumb_asset_id
      WHERE c.id = $1 AND j.user_id = $2
    `, [req.params.id, req.session.userId]);
    if (!rows.length || !rows[0].path) return res.status(404).end();
    res.set('Content-Type', 'image/jpeg');
    createReadStream(rows[0].path).pipe(res);
  } catch (err) {
    next(err);
  }
});

router.get('/api/clips/:id/preview', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT a.path
      FROM clips c
      JOIN jobs j ON j.id = c.job_id
      LEFT JOIN assets a ON a.id = c.mp4_asset_id
      WHERE c.id = $1 AND j.user_id = $2
    `, [req.params.id, req.session.userId]);
    if (!rows.length || !rows[0].path) return res.status(404).end();
    const filePath = rows[0].path;
    const st = await stat(filePath);
    const range = req.headers.range;
    if (!range) {
      res.set({
        'Content-Type': 'video/mp4',
        'Content-Length': st.size,
        'Accept-Ranges': 'bytes'
      });
      return createReadStream(filePath).pipe(res);
    }
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : st.size - 1;
    const chunkSize = end - start + 1;
    res.status(206).set({
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4'
    });
    createReadStream(filePath, { start, end }).pipe(res);
  } catch (err) {
    next(err);
  }
});

router.get('/api/jobs/:id/segments', requireAuth, async (req, res, next) => {
  try {
    const owned = await pool.query(
      'SELECT id FROM jobs WHERE id = $1 AND user_id = $2',
      [req.params.id, req.session.userId]
    );
    if (!owned.rows.length) return res.status(404).end();
    const { rows: clips } = await pool.query(
      `SELECT id, clip_index, start_ms, end_ms, draft_title, draft_caption, reason
       FROM clips WHERE job_id = $1 ORDER BY start_ms ASC`,
      [req.params.id]
    );
    const html = await renderPartial('partials/segments.html', { clips, jobId: req.params.id });
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

export default router;
