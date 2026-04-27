import { bootQueues, getBoss, shutdownBoss } from './lib/queue.js';
import { pool } from './lib/db.js';
import { logger } from './lib/logger.js';
import { runTranscribe } from './stages/transcribe.js';
import { runSegment } from './stages/segment.js';
import { runEdit } from './stages/edit.js';
import { runReframe } from './stages/reframe.js';
import { runFinalize } from './stages/finalize.js';
import { runReconciler } from './stages/reconcile.js';
import { runCleanup } from './stages/cleanup.js';

async function main() {
  for (const k of ['DATABASE_URL', 'ENCRYPTION_KEY']) {
    if (!process.env[k]) throw new Error(`Missing env: ${k}`);
  }

  const boss = await bootQueues();

  const cEdit = Number(process.env.WORKER_CONCURRENCY_EDIT || 2);
  const cReframe = Number(process.env.WORKER_CONCURRENCY_REFRAME || 1);

  await boss.work('transcribe', { batchSize: 1,        teamSize: 1 },        wrap('transcribe', runTranscribe));
  await boss.work('segment',    { batchSize: 1,        teamSize: 1 },        wrap('segment',    runSegment));
  await boss.work('edit',       { batchSize: cEdit,    teamSize: cEdit },    wrap('edit',       runEdit));
  await boss.work('reframe',    { batchSize: cReframe, teamSize: cReframe }, wrap('reframe',    runReframe));
  await boss.work('finalize',   { batchSize: 2,        teamSize: 2 },        wrap('finalize',   runFinalize));
  await boss.work('reconcile',  { batchSize: 1 },                            wrap('reconcile',  runReconciler));
  await boss.work('cleanup',    { batchSize: 1 },                            wrap('cleanup',    runCleanup));
  await boss.work('dlq',        { batchSize: 1 },                            wrap('dlq',        runDeadLetter));

  logger.info(
    { cEdit, cReframe },
    'contentforge-worker ready and listening on transcribe / segment / edit / reframe / finalize / reconcile / cleanup'
  );

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down worker');
    await shutdownBoss().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function wrap(stage, fn) {
  return async (jobs) => {
    const job = jobs[0];
    const start = Date.now();
    try {
      await fn(jobs);
      logger.info({ stage, jobData: job?.data, ms: Date.now() - start }, `${stage} ok`);
    } catch (err) {
      logger.error({ stage, jobData: job?.data, err: err.message, stack: err.stack }, `${stage} failed`);
      // Mark job/clip failed if relevant
      try {
        const { jobId, clipId } = job?.data ?? {};
        if (jobId) {
          const { setJobStatus, setClipStatus, logExecution } = await import('./lib/repo.js');
          if (clipId) await setClipStatus(clipId, 'failed').catch(() => {});
          await setJobStatus(jobId, 'failed', { last_error: `${stage}: ${err.message}` }).catch(() => {});
          await logExecution(jobId, clipId ?? null, stage, 'error', {
            error_message: err.message,
            duration_ms: Date.now() - start,
            finished_at: new Date()
          }).catch(() => {});
        }
      } catch (e2) {
        logger.error({ err: e2.message }, 'failed to mark job failed');
      }
      throw err; // let pg-boss retry
    }
  };
}

async function runDeadLetter(jobs) {
  for (const j of jobs) {
    logger.error({ data: j.data }, 'job hit dead-letter queue');
  }
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'worker startup failed');
  process.exit(1);
});
