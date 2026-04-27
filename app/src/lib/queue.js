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

export async function shutdownBoss() {
  if (_boss) {
    await _boss.stop({ graceful: true, wait: false });
    _boss = null;
  }
}
