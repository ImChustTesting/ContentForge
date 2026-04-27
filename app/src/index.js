import express from 'express';
import pinoHttp from 'pino-http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from './lib/db.js';
import { runMigrations } from './lib/migrate.js';
import { sessionMiddleware, requireAuth, getOnlyUser } from './lib/auth.js';
import { getBoss, shutdownBoss } from './lib/queue.js';
import { logger } from './lib/logger.js';
import authRoutes from './routes/auth.js';
import jobsRoutes from './routes/jobs.js';
import clipsRoutes from './routes/clips.js';
import settingsRoutes from './routes/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Required env up front, fail fast.
  for (const k of ['DATABASE_URL', 'SESSION_SECRET', 'ENCRYPTION_KEY']) {
    if (!process.env[k]) throw new Error(`Missing env: ${k}`);
  }

  await runMigrations();
  await getBoss();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.BEHIND_TLS === 'true' ? 1 : 0);

  app.use(pinoHttp({
    logger,
    customLogLevel: (req, res, err) => {
      if (res.statusCode >= 500 || err) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    }
  }));

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json({ limit: '1mb' }));

  app.use('/static', express.static(path.join(__dirname, 'public'), {
    maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0
  }));

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'contentforge-app' }));

  app.use(sessionMiddleware);

  app.get('/', async (_req, res) => {
    const user = await getOnlyUser();
    if (!user) return res.redirect('/setup');
    res.redirect('/jobs');
  });

  app.use(authRoutes);
  app.use(jobsRoutes);
  app.use(clipsRoutes);
  app.use(settingsRoutes);

  app.use((req, res) => {
    res.status(404).type('html').send('<h1>404</h1><p>Not found.</p>');
  });

  app.use((err, req, res, _next) => {
    req.log?.error?.({ err: err.message, stack: err.stack }, 'request failed');
    if (res.headersSent) return;
    res.status(500).type('html').send(
      '<h1>Server error</h1>' +
      '<p>Something broke. Check container logs.</p>' +
      (process.env.NODE_ENV === 'production'
        ? ''
        : `<pre>${escapeHtml(err.stack || err.message)}</pre>`)
    );
  });

  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, () => {
    logger.info({ port }, 'contentforge-app listening');
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    server.close();
    await shutdownBoss().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'startup failed');
  process.exit(1);
});
