import PgBoss from 'pg-boss';
import { logger } from './logger.js';

let _boss = null;

export async function getBoss() {
  if (_boss) return _boss;
  _boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    schema: 'pgboss',
    retentionDays: 7
  });
  _boss.on('error', (err) => logger.error({ err: err.message }, 'pg-boss error'));
  await _boss.start();
  return _boss;
}

export async function bootQueues() {
  const boss = await getBoss();

  await boss.createQueue('transcribe', {
    retryLimit: 2, retryDelay: 30, retryBackoff: true,
    deadLetterQueue: 'dlq',
    expireInMinutes: 60
  });
  await boss.createQueue('segment',  { retryLimit: 3, retryDelay: 10, retryBackoff: true, deadLetterQueue: 'dlq' });
  await boss.createQueue('edit',     { retryLimit: 2, retryDelay: 30, retryBackoff: true, deadLetterQueue: 'dlq', expireInMinutes: 30 });
  await boss.createQueue('reframe',  { retryLimit: 2, retryDelay: 30, retryBackoff: true, deadLetterQueue: 'dlq', expireInMinutes: 60 });
  await boss.createQueue('finalize', { retryLimit: 3, retryDelay: 10, retryBackoff: true, deadLetterQueue: 'dlq' });
  await boss.createQueue('cleanup',  { retryLimit: 1 });
  await boss.createQueue('reconcile',{ retryLimit: 1 });
  await boss.createQueue('dlq');

  // Scheduled jobs
  await boss.schedule('reconcile', '*/10 * * * *');
  await boss.schedule('cleanup',   '0 4 * * *');   // daily at 04:00 UTC

  return boss;
}

export async function shutdownBoss() {
  if (_boss) {
    await _boss.stop({ graceful: true, wait: false });
    _boss = null;
  }
}
