import { pool } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { getBoss } from '../lib/queue.js';

const STUCK_MINUTES = 15;

const STAGE_FOR_STATUS = {
  transcribing: { queue: 'transcribe', payload: (job) => ({ jobId: job.id }) },
  segmenting:   { queue: 'segment',    payload: (job) => ({ jobId: job.id }) },
  editing:      { queue: 'edit',       payload: () => null }, // resumed per-clip below
  reframing:    { queue: 'reframe',    payload: () => null },
  finalizing:   { queue: 'finalize',   payload: () => null }
};

export async function runReconciler() {
  const { rows: stuckJobs } = await pool.query(`
    SELECT id, status, updated_at
    FROM jobs
    WHERE status IN ('transcribing','segmenting','editing','reframing','finalizing')
      AND updated_at < NOW() - INTERVAL '${STUCK_MINUTES} minutes'
  `);

  if (!stuckJobs.length) {
    logger.debug('reconciler: no stuck jobs');
    return;
  }

  const boss = await getBoss();
  for (const job of stuckJobs) {
    const cfg = STAGE_FOR_STATUS[job.status];
    if (!cfg) continue;

    const payload = cfg.payload(job);
    if (payload) {
      await boss.send(cfg.queue, payload);
      logger.warn({ jobId: job.id, queue: cfg.queue, status: job.status },
        'reconciler: re-enqueued job-level stage');
      continue;
    }

    // Per-clip stages: re-enqueue every clip in a non-terminal state.
    const clipStatusByQueue = {
      edit: ['pending', 'editing'],
      reframe: ['reframing'],
      finalize: ['finalizing']
    };
    const wanted = clipStatusByQueue[cfg.queue] ?? ['pending'];
    const { rows: clips } = await pool.query(
      `SELECT id FROM clips WHERE job_id = $1 AND approved AND status = ANY($2::text[])`,
      [job.id, wanted]
    );
    for (const clip of clips) {
      await boss.send(cfg.queue, { jobId: job.id, clipId: clip.id });
      logger.warn({ jobId: job.id, clipId: clip.id, queue: cfg.queue },
        'reconciler: re-enqueued per-clip stage');
    }
  }

  await pool.query(`
    UPDATE jobs SET updated_at = NOW()
    WHERE id = ANY($1::uuid[])
  `, [stuckJobs.map((r) => r.id)]);
}
