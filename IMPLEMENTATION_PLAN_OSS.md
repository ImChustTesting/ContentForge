# PROJECT_NAME — Implementation Plan (OSS)

> Build spec for the open-source self-hosted version of PROJECT_NAME.
> Companion to `PROJECT_MANIFESTO_OSS.md`. The manifesto says **what**; this document says **how**.
> If they ever conflict, the manifesto wins. Fix this doc.
>
> Authored 2026-04-27. Versions pinned for an April 2026 build.

---

## 0. How to read this document

This is a build spec for a single developer working through it sequentially. Sections 1–13 describe the system in detail (repo, infra, schema, code patterns, every pipeline stage with command lines). Section 14 is the phase-by-phase to-do list — the actual day-by-day plan. Section 15 onward is testing, security, performance tuning, and the open implementation questions you'll hit during the build.

When you start a phase in section 14, scan the relevant detail sections (1–13) first, then write the code. Don't try to read the whole document linearly before opening an editor — that's a recipe for never starting.

---

## 1. Repository layout

```
project-name/
├── .github/
│   └── workflows/
│       ├── build.yml          # Multi-arch Docker builds
│       └── test.yml           # Unit + smoke tests
├── app/                       # Express + HTMX dashboard
│   ├── src/
│   │   ├── index.js           # Entry point
│   │   ├── routes/
│   │   │   ├── auth.js        # /login, /logout, /setup
│   │   │   ├── jobs.js        # /api/jobs, /api/jobs/:id
│   │   │   ├── clips.js       # /api/clips/:id/approve, downloads
│   │   │   └── settings.js    # Brand config, key rotation
│   │   ├── views/             # HTMX partials (no React, no build step)
│   │   │   ├── layout.html
│   │   │   ├── setup-wizard.html
│   │   │   ├── jobs-list.html
│   │   │   ├── job-detail.html
│   │   │   └── partials/
│   │   ├── lib/
│   │   │   ├── db.js          # pg pool
│   │   │   ├── encryption.js  # AES-256-GCM helpers
│   │   │   ├── queue.js       # pg-boss client
│   │   │   └── auth.js        # session + bcrypt helpers
│   │   └── public/
│   │       ├── htmx.min.js    # vendored, version-pinned
│   │       └── style.css
│   ├── package.json
│   ├── package-lock.json
│   └── Dockerfile
├── worker/                    # Node + Python pipeline runner
│   ├── src/
│   │   ├── index.js           # Worker entry, subscribes to queues
│   │   ├── stages/
│   │   │   ├── transcribe.js  # shells to whisper.py
│   │   │   ├── segment.js     # calls Anthropic
│   │   │   ├── edit.js        # ffmpeg + auto-editor
│   │   │   ├── reframe.js     # mediapipe.py + ffmpeg
│   │   │   └── finalize.js    # thumbnail + caption pass
│   │   ├── lib/
│   │   │   ├── anthropic.js   # SDK wrapper with retry + tool use
│   │   │   ├── ffmpeg.js      # exec helpers
│   │   │   ├── prefilter.js   # rule-based candidate generator
│   │   │   └── reconciler.js  # stuck-job sweeper
│   │   └── python/
│   │       ├── whisper.py
│   │       ├── mediapipe_track.py
│   │       └── ass_render.py
│   ├── package.json
│   ├── package-lock.json
│   ├── requirements.txt       # Pinned Python deps
│   └── Dockerfile
├── db/
│   └── migrations/
│       ├── 001_init.sql
│       ├── 002_users.sql
│       ├── 003_secrets.sql
│       └── ...
├── docker-compose.yml
├── .env.example
├── .dockerignore
├── .gitignore
├── LICENSE                    # MIT
├── README.md
├── SECURITY.md
├── CONTRIBUTING.md
├── PROJECT_MANIFESTO_OSS.md   # The "what" doc
└── IMPLEMENTATION_PLAN_OSS.md # This doc
```

Two services, two Dockerfiles, one compose file, one Postgres. Migrations are raw SQL files numbered in order. No ORM — `pg` driver and hand-written queries. The simplicity is deliberate.

---

## 2. Tech stack — exact pinned versions (April 2026)

| Component | Version | Why pinned |
|---|---|---|
| Node.js (app + worker) | 20.x LTS (`node:20-bookworm-slim`) | LTS through 2026-04, glibc-based for Python wheels |
| Python | 3.12 | ctranslate2 + mediapipe both have 3.12 wheels |
| Postgres | 16 (`postgres:16-bookworm`) | Stable, current LTS-equivalent |
| ffmpeg | 6.x from Debian bookworm apt | Stable, version-locked to Debian release cycle |
| **Node packages** | | |
| express | ^4.21 | Stable; v5 still has dragons |
| express-session | ^1.18 | Standard session middleware |
| connect-pg-simple | ^9.0 | Postgres-backed sessions |
| bcrypt | ^5.1 | Cost 12 is fine for single-user |
| pg | ^8.13 | Postgres driver |
| pg-boss | ^10.x | **See note below** — research surfaced v12 as current; verify in Phase 0 |
| @anthropic-ai/sdk | latest at build time | Pin exact version after first install |
| busboy | ^1.6 | Streaming uploads |
| zod | ^3.x | Validate Claude tool-use output |
| pino | ^9.x | Structured logging |
| pino-http | ^10.x | Express access logs |
| **Python packages** | | |
| faster-whisper | 1.1.3 | Current stable, CPU int8 path mature |
| ctranslate2 | 4.7.x | Required by faster-whisper |
| mediapipe | 0.10.14 | Native arm64 via XNNPACK in 0.10+ |
| opencv-python-headless | 4.10.x | Headless avoids GUI deps in container |
| pysubs2 | 0.24.x | ASS subtitle generation |
| auto-editor | 27.x | Current stable line |
| numpy | 1.26.x | Compatibility with ctranslate2 4.7 |

**Verify in Phase 0:** pg-boss major version (research returned both v10 and v12.18.1 numbers; the v12 path supports auto-schema creation without superuser, which is a real win — confirm the actual current version on npm at build time and pick the latest stable). Same for `@anthropic-ai/sdk` and the exact Haiku model string (`claude-haiku-4-5-20251001` is current).

---

## 3. docker-compose.yml (full)

```yaml
services:
  app:
    image: ghcr.io/USER/project-name-app:${VERSION:-latest}
    build:
      context: ./app
      dockerfile: Dockerfile
    ports:
      - "${APP_PORT:-3000}:3000"
    environment:
      DATABASE_URL: postgres://app:${POSTGRES_PASSWORD}@db:5432/projectname
      SESSION_SECRET: ${SESSION_SECRET}
      ENCRYPTION_KEY: ${ENCRYPTION_KEY}
      DATA_DIR: /data
      NODE_ENV: production
    volumes:
      - data:/data
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1))"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 20s

  worker:
    image: ghcr.io/USER/project-name-worker:${VERSION:-latest}
    build:
      context: ./worker
      dockerfile: Dockerfile
    environment:
      DATABASE_URL: postgres://app:${POSTGRES_PASSWORD}@db:5432/projectname
      ENCRYPTION_KEY: ${ENCRYPTION_KEY}
      DATA_DIR: /data
      NODE_ENV: production
      WORKER_CONCURRENCY_EDIT: 2
      WORKER_CONCURRENCY_REFRAME: 1
      ENCODE_PRESET: ${ENCODE_PRESET:-veryfast}
    volumes:
      - data:/data
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped
    # nice + ionice via cap_add not available on all hosts;
    # the Dockerfile ENTRYPOINT applies them where supported
    deploy:
      resources:
        limits:
          memory: 4g

  db:
    image: postgres:16-bookworm
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: projectname
    volumes:
      - postgres-data:/var/lib/postgresql/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d projectname"]
      interval: 5s
      timeout: 5s
      retries: 5
      start_period: 10s

volumes:
  data:
    driver: local
  postgres-data:
    driver: local
```

**No nginx, no Redis, no MinIO.** Users who want public access put their own reverse proxy in front. Users who want S3-compatible storage uncomment a MinIO service in a separate `docker-compose.minio.yml` (shipped as an example).

---

## 4. Dockerfiles

### 4.1 `app/Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY package.json ./

USER node
ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
```

Final image target: ~120 MB compressed.

### 4.2 `worker/Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1.7

# ---- Builder: install Python deps and compile what's needed ----
FROM node:20-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.12 python3.12-venv python3.12-dev \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Python venv
RUN python3.12 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Node deps
WORKDIR /worker
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Runtime: slim, with ffmpeg + venv ----
FROM node:20-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3.12 \
    util-linux \
    tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /worker

# Copy venv (all wheels already compiled in builder)
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy node deps + source
COPY --from=builder /worker/node_modules ./node_modules
COPY src ./src
COPY package.json ./

# Pre-download MediaPipe face detector model
RUN python3.12 -c "import mediapipe; print('mediapipe', mediapipe.__version__)"
COPY models/face_detector_short_range.tflite /opt/models/face_detector_short_range.tflite

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PYTHONUNBUFFERED=1

# Apply niceness via wrapper (works on Linux hosts; macOS Docker Desktop ignores)
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["node", "src/index.js"]
```

`entrypoint.sh`:

```bash
#!/bin/bash
# Apply niceness if we have permission (Linux), else just exec
if command -v ionice >/dev/null 2>&1; then
  exec nice -n 19 ionice -c2 -n7 "$@"
else
  exec "$@"
fi
```

Final image target: ~750 MB compressed (Python venv is the bulk).

---

## 5. Database schema

Single migration file per logical change. Numbered, applied in order, never modified after merge.

### 5.1 `db/migrations/001_init.sql`

```sql
-- Enable pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- pg-boss creates its own schema on first .start(); we don't manage it here.
```

### 5.2 `db/migrations/002_users.sql`

```sql
CREATE TABLE users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT UNIQUE,                -- optional, for the wizard
  password_hash TEXT NOT NULL,             -- bcrypt
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Single-user mode: row count is constrained to 1 in v1.
-- Enforced at app layer; schema permits multi-user later.
```

### 5.3 `db/migrations/003_secrets.sql`

```sql
CREATE TABLE user_secrets (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Encrypted key: 12-byte IV || ciphertext || 16-byte GCM tag
  anthropic_key  BYTEA NOT NULL,
  key_version    INT NOT NULL DEFAULT 1,   -- for master-key rotation
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 5.4 `db/migrations/004_jobs_assets_clips.sql`

```sql
CREATE TYPE job_status AS ENUM (
  'queued', 'transcribing', 'segmenting', 'awaiting_approval',
  'editing', 'reframing', 'finalizing', 'ready', 'failed', 'cancelled'
);

CREATE TYPE clip_mode AS ENUM ('TRACK', 'GENERAL');

CREATE TABLE jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  status          job_status NOT NULL DEFAULT 'queued',
  speaker_count   SMALLINT NOT NULL CHECK (speaker_count IN (1, 2)),
  camera_count    SMALLINT NOT NULL CHECK (camera_count IN (1, 2)),
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX jobs_user_status_idx ON jobs (user_id, status);
CREATE INDEX jobs_updated_at_idx ON jobs (updated_at DESC);

CREATE TABLE assets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID REFERENCES jobs(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,             -- 'source','edited','clip','srt','thumb'
  path          TEXT NOT NULL,             -- relative to /data
  size_bytes    BIGINT NOT NULL,
  pinned        BOOLEAN NOT NULL DEFAULT FALSE,
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX assets_job_kind_idx ON assets (job_id, kind);

CREATE TABLE clips (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  clip_index      INT NOT NULL,
  start_ms        INT NOT NULL,
  end_ms          INT NOT NULL,
  mode            clip_mode NOT NULL,
  approved        BOOLEAN NOT NULL DEFAULT FALSE,
  draft_title     TEXT,
  draft_caption   TEXT,
  reason          TEXT,
  final_caption_ig TEXT,
  final_caption_li TEXT,
  hashtags        TEXT[],
  mp4_asset_id    UUID REFERENCES assets(id),
  thumb_asset_id  UUID REFERENCES assets(id),
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, clip_index)
);

CREATE TABLE executions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  clip_id       UUID REFERENCES clips(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL,
  status        TEXT NOT NULL,             -- 'started','ok','error'
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  duration_ms   INT,
  error_message TEXT,
  result        JSONB
);

CREATE INDEX executions_job_idx ON executions (job_id, started_at);
```

### 5.5 `db/migrations/005_brand_config.sql`

```sql
CREATE TABLE brand_config (
  id              SMALLINT PRIMARY KEY DEFAULT 1,
  font_name       TEXT NOT NULL DEFAULT 'Inter',
  font_size       INT NOT NULL DEFAULT 56,
  font_color      TEXT NOT NULL DEFAULT '#FFFFFF',
  outline_color   TEXT NOT NULL DEFAULT '#000000',
  outline_width   INT NOT NULL DEFAULT 3,
  vertical_pct    INT NOT NULL DEFAULT 80,  -- caption baseline as % from top
  intro_asset_id  UUID REFERENCES assets(id),
  outro_asset_id  UUID REFERENCES assets(id),
  CHECK (id = 1)                             -- single-row table
);

INSERT INTO brand_config (id) VALUES (1);
```

### 5.6 `db/migrations/006_session.sql`

```sql
-- connect-pg-simple session table
CREATE TABLE "session" (
  "sid"    VARCHAR NOT NULL COLLATE "default",
  "sess"   JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);
CREATE INDEX "IDX_session_expire" ON "session" ("expire");
```

### 5.7 Migration runner

Plain Node script in `app/src/lib/migrate.js`, reads files in order, tracks applied migrations in a `migrations` table, applied at app boot before serving traffic. ~50 lines of code.

---

## 6. Encryption design

### 6.1 The threat model

A user pastes their Anthropic API key into the setup wizard. The key is worth real money to an attacker — both in spend on the user's account and as exfiltration of capability. The threat model is "an attacker who gets a copy of the Postgres dump or a backup of the data volume should not be able to recover the API key."

### 6.2 The implementation

AES-256-GCM with a master key in env (`ENCRYPTION_KEY`, 32 random bytes hex-encoded). Per-key derivation via PBKDF2 with a per-row salt (the `key_version` doubles as part of the salt context). Auth tag stored with the ciphertext. Decryption only happens in worker process memory at the moment of an Anthropic API call; never logged, never re-emitted.

`app/src/lib/encryption.js` and `worker/src/lib/encryption.js` (same code, copy-pasted because the surface is small):

```javascript
import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;     // 96-bit IV per NIST SP 800-38D
const TAG_LEN = 16;    // 128-bit GCM tag
const KEY_LEN = 32;    // AES-256
const PBKDF2_ITERS = 100_000;

function deriveKey(masterHex, version) {
  if (!masterHex || masterHex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
  }
  const master = Buffer.from(masterHex, 'hex');
  const salt = Buffer.from(`project-name-v${version}`, 'utf8');
  return crypto.pbkdf2Sync(master, salt, PBKDF2_ITERS, KEY_LEN, 'sha256');
}

export function encrypt(plaintext, masterHex, version = 1) {
  const key = deriveKey(masterHex, version);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]);
}

export function decrypt(blob, masterHex, version = 1) {
  const key = deriveKey(masterHex, version);
  const iv = blob.slice(0, IV_LEN);
  const tag = blob.slice(blob.length - TAG_LEN);
  const ct = blob.slice(IV_LEN, blob.length - TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
```

### 6.3 Master key rotation

A user wants to rotate their `ENCRYPTION_KEY`. The flow:

1. Set `ENCRYPTION_KEY_OLD=<previous hex>` and `ENCRYPTION_KEY=<new hex>` in `.env`.
2. Run `docker compose run --rm app node src/scripts/rotate-key.js`.
3. The script reads each row in `user_secrets`, decrypts with `ENCRYPTION_KEY_OLD`, re-encrypts with `ENCRYPTION_KEY`, increments `key_version`, and writes back.
4. User removes `ENCRYPTION_KEY_OLD` from `.env`.

This is a v0.2 ship; v1 documents the rotation procedure but doesn't include the script. (Deliberate scope cut.)

### 6.4 The setup wizard's "Test connection" dance

After paste, before save:

1. App holds the plaintext key in process memory only.
2. App makes a real Claude call: `messages.create({model, max_tokens: 16, messages: [{role:'user', content:'Hello.'}]})`.
3. If 200, encrypt + save to `user_secrets` and show "Connected ✓".
4. If 401/403, return error verbatim and don't save.
5. The plaintext is never logged, never written to disk, never persisted in a session.

---

## 7. App architecture

### 7.1 Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | optional | Redirect to `/setup` if no user, else `/jobs` |
| GET | `/setup` | none | Setup wizard (only when 0 users exist) |
| POST | `/setup` | none | Create admin user + first key |
| GET | `/login` | none | Login form |
| POST | `/login` | none | Authenticate, set session |
| POST | `/logout` | session | Destroy session |
| GET | `/jobs` | session | Jobs list page |
| GET | `/jobs/:id` | session | Job detail (approval gate or progress) |
| POST | `/api/jobs` | session | Create job, returns ID + upload URL |
| POST | `/api/jobs/:id/upload` | session | Multipart upload of source file |
| GET | `/api/jobs/:id` | session | JSON status (HTMX polling target) |
| GET | `/api/jobs/:id/segments` | session | HTML partial: proposed segments |
| POST | `/api/jobs/:id/approve` | session | Commit selected clips |
| GET | `/api/clips/:id/download` | session | Stream MP4 |
| GET | `/api/clips/:id/thumb` | session | Stream thumbnail JPG |
| GET | `/settings` | session | Brand config + key rotation page |
| POST | `/api/settings/brand` | session | Update brand config |
| POST | `/api/settings/key` | session | Replace Anthropic key (with test) |
| GET | `/health` | none | Liveness probe (returns `{ ok: true }`) |

### 7.2 Session middleware

```javascript
// app/src/lib/auth.js
import session from 'express-session';
import ConnectPgSimple from 'connect-pg-simple';
import { pool } from './db.js';

const PgStore = ConnectPgSimple(session);

export const sessionMiddleware = session({
  store: new PgStore({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' && process.env.BEHIND_TLS === 'true',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000  // 7 days
  }
});

export function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    if (req.headers['hx-request']) {
      res.set('HX-Redirect', '/login');
      return res.status(401).end();
    }
    return res.redirect('/login');
  }
  next();
}
```

### 7.3 Login (bcrypt, cost 12)

```javascript
// app/src/routes/auth.js
import bcrypt from 'bcrypt';
import { pool } from '../lib/db.js';

router.post('/login', async (req, res) => {
  const { password } = req.body;
  const { rows } = await pool.query(
    'SELECT id, password_hash FROM users LIMIT 1'
  );
  if (!rows.length) return res.status(401).send('No user yet — visit /setup');
  const ok = await bcrypt.compare(password, rows[0].password_hash);
  if (!ok) return res.status(401).render('login', { error: 'Wrong password.' });
  req.session.userId = rows[0].id;
  res.redirect('/jobs');
});
```

### 7.4 Upload route (Busboy, streamed to disk)

```javascript
// app/src/routes/jobs.js
import busboy from 'busboy';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../lib/db.js';
import { boss } from '../lib/queue.js';

router.post('/api/jobs/:id/upload', requireAuth, async (req, res) => {
  const { id: jobId } = req.params;
  const dir = path.join(process.env.DATA_DIR, 'uploads', jobId);
  await mkdir(dir, { recursive: true });

  const bb = busboy({
    headers: req.headers,
    limits: { fileSize: 2 * 1024 ** 3 }  // 2 GB
  });
  let savedPath = null;

  bb.on('file', (_field, file, info) => {
    const ext = path.extname(info.filename) || '.mp4';
    savedPath = path.join(dir, `source${ext}`);
    file.pipe(createWriteStream(savedPath));
    file.on('limit', () => res.status(413).send('File exceeds 2 GB'));
  });

  bb.on('close', async () => {
    if (!savedPath) return res.status(400).send('No file');
    await pool.query(
      'INSERT INTO assets (job_id, kind, path, size_bytes) VALUES ($1, $2, $3, $4)',
      [jobId, 'source', savedPath, /* size */ 0]
    );
    await boss.send('transcribe', { jobId });
    await pool.query('UPDATE jobs SET status = $1 WHERE id = $2', ['transcribing', jobId]);
    res.set('HX-Redirect', `/jobs/${jobId}`).status(204).end();
  });

  req.pipe(bb);
});
```

---

## 8. Worker architecture

### 8.1 Queue setup

```javascript
// worker/src/lib/queue.js (also imported by app for enqueueing)
import PgBoss from 'pg-boss';

export const boss = new PgBoss({ connectionString: process.env.DATABASE_URL });

export async function bootQueues() {
  await boss.start();

  await boss.createQueue('transcribe', {
    retryLimit: 2, retryDelay: 30, retryBackoff: true,
    deadLetterQueue: 'dlq',
    expireInMinutes: 60
  });
  await boss.createQueue('segment',   { retryLimit: 3, retryDelay: 10, retryBackoff: true, deadLetterQueue: 'dlq' });
  await boss.createQueue('edit',      { retryLimit: 2, retryDelay: 30, retryBackoff: true, deadLetterQueue: 'dlq' });
  await boss.createQueue('reframe',   { retryLimit: 2, retryDelay: 30, retryBackoff: true, deadLetterQueue: 'dlq' });
  await boss.createQueue('finalize',  { retryLimit: 3, retryDelay: 10, retryBackoff: true, deadLetterQueue: 'dlq' });
  await boss.createQueue('dlq');

  // Reconciler runs every 10 min via pg-boss schedule
  await boss.schedule('reconcile', '*/10 * * * *');
  await boss.createQueue('reconcile', { retryLimit: 1 });
}
```

### 8.2 Worker entry

```javascript
// worker/src/index.js
import { boss, bootQueues } from './lib/queue.js';
import { runTranscribe } from './stages/transcribe.js';
import { runSegment }   from './stages/segment.js';
import { runEdit }       from './stages/edit.js';
import { runReframe }    from './stages/reframe.js';
import { runFinalize }   from './stages/finalize.js';
import { runReconciler } from './lib/reconciler.js';

await bootQueues();

const cEdit    = Number(process.env.WORKER_CONCURRENCY_EDIT    || 2);
const cReframe = Number(process.env.WORKER_CONCURRENCY_REFRAME || 1);

await boss.work('transcribe', { batchSize: 1 },          runTranscribe);
await boss.work('segment',    { batchSize: 1 },          runSegment);
await boss.work('edit',       { batchSize: cEdit },      runEdit);
await boss.work('reframe',    { batchSize: cReframe },   runReframe);
await boss.work('finalize',   { batchSize: 2 },          runFinalize);
await boss.work('reconcile',  { batchSize: 1 },          runReconciler);

console.log('worker ready');
```

`batchSize` is pg-boss's term for how many of this queue's jobs the worker can hold concurrently. `reframe` is bounded to 1 because it pegs the CPU; `edit` can run 2 because most of its time is in ffmpeg waiting on disk I/O; `transcribe` is 1 because faster-whisper saturates cores already.

---

## 9. Pipeline stages — concrete invocations

### 9.1 Stage: transcribe

`worker/src/stages/transcribe.js`:

```javascript
import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { pool } from '../lib/db.js';
import { boss } from '../lib/queue.js';

export async function runTranscribe([job]) {
  const { jobId } = job.data;
  const sourcePath = await getSourcePath(jobId);
  const captionsDir = path.join(process.env.DATA_DIR, 'captions', jobId);
  await mkdir(captionsDir, { recursive: true });

  // Step 1: extract mono 16kHz wav with ffmpeg
  const wavPath = path.join(captionsDir, 'audio.wav');
  await execShell('ffmpeg', [
    '-y', '-i', sourcePath,
    '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
    wavPath
  ]);

  // Step 2: run whisper.py
  const srtPath = path.join(captionsDir, 'full.srt');
  const cuesJsonPath = path.join(captionsDir, 'cues.json');
  await execShell('python3', [
    'src/python/whisper.py',
    '--audio', wavPath,
    '--srt-out', srtPath,
    '--json-out', cuesJsonPath,
    '--model', 'small',
    '--compute', 'int8'
  ]);

  await pool.query(`
    INSERT INTO assets (job_id, kind, path, size_bytes)
    VALUES ($1, 'srt', $2, 0)
  `, [jobId, srtPath]);

  await pool.query('UPDATE jobs SET status = $1 WHERE id = $2', ['segmenting', jobId]);
  await boss.send('segment', { jobId });
}
```

`worker/src/python/whisper.py`:

```python
#!/usr/bin/env python3
"""Run faster-whisper on an audio file, output SRT + JSON cues."""
import argparse, json
from faster_whisper import WhisperModel

def fmt_ts(t):
    h = int(t // 3600); m = int((t % 3600) // 60); s = t % 60
    return f"{h:02d}:{m:02d}:{int(s):02d},{int((s % 1) * 1000):03d}"

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--audio', required=True)
    p.add_argument('--srt-out', required=True)
    p.add_argument('--json-out', required=True)
    p.add_argument('--model', default='small')
    p.add_argument('--compute', default='int8')
    args = p.parse_args()

    model = WhisperModel(args.model, device='cpu', compute_type=args.compute)
    segments, info = model.transcribe(
        args.audio,
        language='en',
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={'min_speech_duration_ms': 250}
    )

    cues = []
    with open(args.srt_out, 'w') as srt:
        for i, seg in enumerate(segments, 1):
            srt.write(f"{i}\n{fmt_ts(seg.start)} --> {fmt_ts(seg.end)}\n{seg.text.strip()}\n\n")
            cues.append({
                'id': i,
                'start_ms': int(seg.start * 1000),
                'end_ms': int(seg.end * 1000),
                'text': seg.text.strip(),
                'words': [{'w': w.word, 's': int(w.start*1000), 'e': int(w.end*1000)}
                          for w in (seg.words or [])]
            })

    with open(args.json_out, 'w') as j:
        json.dump({'cues': cues, 'language': info.language}, j)

if __name__ == '__main__':
    main()
```

Model choice: `small` (244M params) on CPU int8. `base` is faster but the segment-selection LLM later depends on transcript quality. `medium` is too slow on a 4-core CPU. Document `WHISPER_MODEL` env var so power users can override.

### 9.2 Stage: segment (rule pre-filter + Claude rank)

`worker/src/lib/prefilter.js`:

```javascript
// Generate ~12 candidate ranges from cue list using rule heuristics.
// Heuristics: length 15–90s, ends on punctuation, contains a "hook word"
// (number, "you", "imagine", "stop", "never", "actually", etc.),
// caption density above median, no long silences inside.

const HOOK_WORDS = /\b(you|stop|never|imagine|actually|secret|truth|wrong|right|listen|here'?s|why|how)\b/i;

export function preFilter(cues, target = 12) {
  const candidates = [];
  for (let i = 0; i < cues.length; i++) {
    for (let j = i + 1; j < cues.length; j++) {
      const span_ms = cues[j].end_ms - cues[i].start_ms;
      if (span_ms < 15_000) continue;
      if (span_ms > 90_000) break;
      const text = cues.slice(i, j + 1).map(c => c.text).join(' ');
      const score =
          (HOOK_WORDS.test(cues[i].text) ? 2 : 0) +
          (text.length / span_ms * 1000);  // caption density
      candidates.push({
        startCueId: cues[i].id, endCueId: cues[j].id,
        start_ms: cues[i].start_ms, end_ms: cues[j].end_ms,
        text, score
      });
    }
  }
  // Keep top N by score, then deduplicate overlapping windows
  candidates.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const c of candidates) {
    if (kept.length >= target) break;
    if (kept.some(k => Math.max(c.start_ms, k.start_ms) < Math.min(c.end_ms, k.end_ms))) continue;
    kept.push(c);
  }
  return kept.sort((a, b) => a.start_ms - b.start_ms);
}
```

`worker/src/lib/anthropic.js`:

```javascript
import Anthropic from '@anthropic-ai/sdk';

export function makeClient(apiKey) {
  return new Anthropic({ apiKey });
}

// Structured output via tool use (Anthropic's actual mechanism).
// Force the model to emit a tool call matching our schema.
export async function rankSegments(client, { systemPrompt, candidates, targetCount }) {
  const tool = {
    name: 'submit_picks',
    description: 'Return the ranked clip selections.',
    input_schema: {
      type: 'object',
      properties: {
        clips: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              startCueId:    { type: 'integer' },
              endCueId:      { type: 'integer' },
              title:         { type: 'string' },
              draftCaption:  { type: 'string' },
              reason:        { type: 'string' }
            },
            required: ['startCueId', 'endCueId', 'title', 'draftCaption', 'reason']
          }
        }
      },
      required: ['clips']
    }
  };

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',  // verify exact string at build time
    max_tokens: 2048,
    system: [{
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral' }   // 5-min cache for repeated calls
    }],
    tools: [tool],
    tool_choice: { type: 'tool', name: 'submit_picks' },
    messages: [{
      role: 'user',
      content: `Pick the top ${targetCount} clips from these candidates:\n` +
               candidates.map(c => `[${c.startCueId}-${c.endCueId}] ${c.text}`).join('\n')
    }]
  });

  // The model is forced to call submit_picks; its content[0] is a tool_use block
  const toolUse = response.content.find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('Model did not call the tool');
  return toolUse.input.clips;
}
```

The system prompt lives in `worker/src/lib/prompts/segment.txt` and includes brand voice (from `brand_config`) plus instructions to favor self-contained, hook-first clips.

`worker/src/stages/segment.js` orchestrates: load cues → pre-filter → load encrypted Anthropic key → decrypt in memory → call `rankSegments` → insert `clips` rows with `approved=false` → set job status to `awaiting_approval`. **Stops here. Waits for the human gate.**

### 9.3 Stage: edit

```javascript
// worker/src/stages/edit.js
import { execShell } from '../lib/exec.js';
import path from 'node:path';

export async function runEdit([job]) {
  const { jobId, clipId } = job.data;
  const clip = await loadClip(clipId);
  const source = await loadSource(jobId);
  const out = path.join(process.env.DATA_DIR, 'edited', jobId, `${clip.clip_index}.mp4`);

  // Step 1: cut to clip range
  const tmpCut = `${out}.cut.mp4`;
  await execShell('ffmpeg', [
    '-y', '-ss', `${clip.start_ms / 1000}`, '-to', `${clip.end_ms / 1000}`,
    '-i', source.path,
    '-c:v', 'libx264', '-preset', process.env.ENCODE_PRESET || 'veryfast',
    '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k',
    tmpCut
  ]);

  // Step 2: auto-editor for silence trim
  const tmpTrim = `${out}.trim.mp4`;
  await execShell('auto-editor', [
    tmpCut,
    '--silent-threshold', '0.04',
    '--silent-duration', '0.4',
    '--export', 'default',
    '--output', tmpTrim
  ]);

  // Step 3: audio chain (denoise + loudnorm)
  await execShell('ffmpeg', [
    '-y', '-i', tmpTrim,
    '-af', 'afftdn=tn=1, loudnorm=I=-16:TP=-1.5:LRA=11',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    out
  ]);

  await cleanup([tmpCut, tmpTrim]);
  await registerAsset(jobId, 'edited', out);
  await boss.send('reframe', { jobId, clipId });
}
```

The `ENCODE_PRESET` env var defaults to `veryfast` for the OSS build (the manifesto's `medium` was the right call for the TPC server, not for consumer hardware). `veryfast` produces 1080p output that's visually indistinguishable from `medium` on short-form content and runs ~3× faster.

### 9.4 Stage: reframe (the slow one)

The reframe stage is the dominant time sink. The mitigation is to run MediaPipe on a downscaled copy (720p is plenty for face centroids) and only re-encode at full resolution after we have the trajectory.

```javascript
// worker/src/stages/reframe.js
export async function runReframe([job]) {
  const { jobId, clipId } = job.data;
  const clip = await loadClip(clipId);
  const edited = await loadAsset(clipId, 'edited');
  const out = path.join(process.env.DATA_DIR, 'clips', jobId, `${clip.clip_index}.mp4`);

  if (clip.mode === 'TRACK') {
    // 1. Downscale to 720p for face detection (fast)
    const small = `${edited.path}.720.mp4`;
    await execShell('ffmpeg', ['-y', '-i', edited.path,
      '-vf', 'scale=-2:720', '-c:a', 'copy', small]);

    // 2. Run MediaPipe → CSV of face centroids
    const csv = `${edited.path}.faces.csv`;
    await execShell('python3', ['src/python/mediapipe_track.py',
      '--video', small, '--out', csv]);

    // 3. Smooth the x trajectory in Node (EMA with span=5)
    const smoothed = await smoothCentroidsToFfmpegExpr(csv, /* span */ 5);

    // 4. Render captions ASS file from SRT range
    const assPath = `${edited.path}.captions.ass`;
    await execShell('python3', ['src/python/ass_render.py',
      '--srt', /* clip's srt range */, '--style-json', /* brand_config */,
      '--out', assPath]);

    // 5. Final encode: crop + caption burn-in, single ffmpeg pass
    await execShell('ffmpeg', ['-y', '-i', edited.path,
      '-vf', `crop=ih*9/16:ih:${smoothed.cropExpr}:0,ass=${assPath}`,
      '-c:v', 'libx264', '-preset', process.env.ENCODE_PRESET || 'veryfast',
      '-crf', '20', '-c:a', 'copy',
      out
    ]);
    await cleanup([small, csv]);
  } else {
    // GENERAL: blurred bg + centered foreground + captions
    await execShell('ffmpeg', ['-y', '-i', edited.path,
      '-filter_complex',
        `[0:v]split=2[bg][fg];` +
        `[bg]scale=1080:1920,boxblur=20:5[bgblur];` +
        `[fg]scale=1080:-2[fgs];` +
        `[bgblur][fgs]overlay=(W-w)/2:(H-h)/2,ass=${assPath}`,
      '-c:v', 'libx264', '-preset', process.env.ENCODE_PRESET || 'veryfast',
      '-crf', '20', '-c:a', 'copy',
      out
    ]);
  }

  await registerAsset(jobId, 'clip', out, { clip_id: clipId });
  await boss.send('finalize', { jobId, clipId });
}
```

`worker/src/python/mediapipe_track.py`:

```python
#!/usr/bin/env python3
"""Per-frame face centroid CSV using MediaPipe Tasks API."""
import argparse, csv, cv2
import mediapipe as mp

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--video', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--model', default='/opt/models/face_detector_short_range.tflite')
    args = p.parse_args()

    BaseOptions = mp.tasks.BaseOptions
    FaceDetector = mp.tasks.vision.FaceDetector
    FaceDetectorOptions = mp.tasks.vision.FaceDetectorOptions
    VisionRunningMode = mp.tasks.vision.RunningMode

    options = FaceDetectorOptions(
        base_options=BaseOptions(model_asset_path=args.model),
        running_mode=VisionRunningMode.IMAGE,
        min_detection_confidence=0.4
    )

    cap = cv2.VideoCapture(args.video)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w_in = cap.get(cv2.CAP_PROP_FRAME_WIDTH)
    h_in = cap.get(cv2.CAP_PROP_FRAME_HEIGHT)

    with FaceDetector.create_from_options(options) as detector, \
         open(args.out, 'w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['frame_idx', 't_ms', 'x_center', 'y_center', 'confidence'])
        idx = 0
        while True:
            ret, frame = cap.read()
            if not ret: break
            t_ms = int((idx / fps) * 1000)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB,
                                data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            res = detector.detect(mp_image)
            if res.detections:
                d = res.detections[0]
                bb = d.bounding_box
                x = bb.origin_x + bb.width / 2
                y = bb.origin_y + bb.height / 2
                c = d.categories[0].score if d.categories else 1.0
                writer.writerow([idx, t_ms, f"{x:.1f}", f"{y:.1f}", f"{c:.3f}"])
            idx += 1
    cap.release()

if __name__ == '__main__':
    main()
```

The smoothing helper translates the CSV into an ffmpeg `crop` x-expression. For a clip under ~60s, embedding the trajectory as a piecewise-linear `if(...)` chain in a single filter is fine. For longer clips, generate a `sendcmd` script. v1 ships the embedded approach because clips are short by definition.

### 9.5 Stage: finalize

```javascript
// worker/src/stages/finalize.js
export async function runFinalize([job]) {
  const { jobId, clipId } = job.data;
  const clip = await loadClip(clipId);
  const mp4 = await loadAsset(clipId, 'clip');
  const thumbPath = path.join(process.env.DATA_DIR, 'thumbs', jobId, `${clip.clip_index}.jpg`);

  // Thumbnail at midpoint
  const mid = (clip.end_ms - clip.start_ms) / 2 / 1000;
  await execShell('ffmpeg', ['-y', '-ss', `${mid}`, '-i', mp4.path,
    '-frames:v', '1', '-q:v', '3', thumbPath]);

  // Caption pass via Claude
  const apiKey = await loadAndDecryptKey(/* user_id */);
  const client = makeClient(apiKey);
  const transcript = await loadTranscriptRange(jobId, clip.start_ms, clip.end_ms);
  const { ig, li, hashtags } = await draftCaption(client, { title: clip.draft_title, transcript });

  await pool.query(`
    UPDATE clips SET
      final_caption_ig = $1, final_caption_li = $2, hashtags = $3,
      thumb_asset_id = (SELECT id FROM assets WHERE path = $4),
      status = 'ready', updated_at = NOW()
    WHERE id = $5
  `, [ig, li, hashtags, thumbPath, clipId]);

  await maybeMarkJobReady(jobId);
}
```

---

## 10. HTMX dashboard patterns

### 10.1 Approval gate (the single most important screen)

`app/src/views/job-detail-approval.html` (rendered by `GET /jobs/:id` when status is `awaiting_approval`):

```html
<div class="transcript">
  {{#each cues}}
    <span data-cue="{{id}}" class="cue">{{text}} </span>
  {{/each}}
</div>

<form id="approve-form"
      hx-post="/api/jobs/{{job.id}}/approve"
      hx-trigger="submit"
      hx-target="#main"
      hx-swap="innerHTML">
  <ul class="proposed-clips">
    {{#each clips}}
      <li class="clip-band" data-start="{{start_ms}}" data-end="{{end_ms}}">
        <label>
          <input type="checkbox" name="clipIds" value="{{id}}" />
          <span class="ts">{{ts start_ms}} – {{ts end_ms}}</span>
          <span class="title">{{draft_title}}</span>
          <p class="reason">{{reason}}</p>
        </label>
      </li>
    {{/each}}
  </ul>
  <button type="submit" id="approve-btn"
          hx-on:htmx:beforeRequest="this.disabled = true">
    Approve <span data-bind="selected-count">0</span> selected
  </button>
</form>

<script>
  // 12 lines of vanilla JS, no framework: keep checkbox count in sync
  const form = document.getElementById('approve-form');
  const counter = document.querySelector('[data-bind="selected-count"]');
  form.addEventListener('change', () => {
    counter.textContent = form.querySelectorAll('input[name="clipIds"]:checked').length;
  });
</script>
```

### 10.2 Post-approval progress

`app/src/views/job-detail-progress.html`:

```html
<div hx-get="/api/jobs/{{id}}/status"
     hx-trigger="load, every 3s"
     hx-swap="outerHTML">
  <h2>Working...</h2>
  <ul class="clip-progress">
    {{#each clips}}
      <li>Clip {{clip_index}}: {{status}}</li>
    {{/each}}
  </ul>
</div>
```

The endpoint returns the same partial on each poll. When all clips are `ready`, it returns a `<div hx-trigger="load">` that swaps the page to the ready-clips view (HTMX's natural full-page-by-fragment pattern).

Polling every 3 seconds is fine for our scale (single user, max ~5 in-flight clips). SSE adds complexity that doesn't pay back here.

---

## 11. First-run wizard

`app/src/routes/auth.js`:

```javascript
router.get('/setup', async (req, res) => {
  const { rows } = await pool.query('SELECT count(*) FROM users');
  if (Number(rows[0].count) > 0) return res.redirect('/login');
  res.render('setup-wizard', { step: 1 });
});

router.post('/setup', async (req, res) => {
  const { rows: existing } = await pool.query('SELECT count(*) FROM users');
  if (Number(existing[0].count) > 0) return res.status(403).send('Already set up');

  const { email, password, anthropicKey } = req.body;

  // 1. Test Anthropic key with a real call
  try {
    const client = new Anthropic({ apiKey: anthropicKey });
    await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Say "ok".' }]
    });
  } catch (err) {
    return res.status(400).render('setup-wizard', {
      step: 2, error: `Key test failed: ${err.message}`
    });
  }

  // 2. Create user, encrypt key, save both atomically
  const hash = await bcrypt.hash(password, 12);
  const blob = encrypt(anthropicKey, process.env.ENCRYPTION_KEY);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [email || null, hash]
    );
    await client.query(
      'INSERT INTO user_secrets (user_id, anthropic_key) VALUES ($1, $2)',
      [rows[0].id, blob]
    );
    await client.query('COMMIT');
    req.session.userId = rows[0].id;
    res.redirect('/jobs');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});
```

The wizard's HTML is one page with three steps progressively revealed via HTMX swaps. ~150 lines total. Step 3 is the test-connection live click (`hx-post="/api/test-key"` returning ok or error; only when ok does the final form submit unlock).

---

## 12. CI/CD — multi-arch builds

`.github/workflows/build.yml`:

```yaml
name: build
on:
  push:
    branches: [main]
    tags: ['v*']
  workflow_dispatch:

env:
  REGISTRY: ghcr.io
  IMAGE_BASE: ${{ github.repository }}

jobs:
  build:
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write }
    strategy:
      matrix:
        component: [app, worker]
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_BASE }}-${{ matrix.component }}
          tags: |
            type=ref,event=branch
            type=semver,pattern={{version}}
            type=sha
      - uses: docker/build-push-action@v7
        with:
          context: ./${{ matrix.component }}
          platforms: linux/amd64,linux/arm64
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha,scope=${{ matrix.component }}
          cache-to: type=gha,scope=${{ matrix.component }},mode=max
```

Two images (`app`, `worker`), two architectures, GHA cache makes the warm build ~5 minutes; cold ~20 minutes thanks to QEMU on arm64. Acceptable.

`.github/workflows/test.yml` runs unit tests on PRs and a single end-to-end smoke test (60-second sample MP4 → finalize a single clip → assert MP4 exists and is non-empty). The smoke test is the most valuable single piece of CI we own; it catches dependency drift.

---

## 13. Environment variables

Complete list. Documented in `.env.example` with comments.

```bash
# --- Required ---
POSTGRES_PASSWORD=         # Random; user generates
SESSION_SECRET=            # Random 32+ bytes; user generates
ENCRYPTION_KEY=            # 64 hex chars (32 bytes); user generates with `openssl rand -hex 32`

# --- Optional ---
APP_PORT=3000              # External port for the dashboard
DATA_DIR=/data             # Inside container; bind to a host path if you want
WORKER_CONCURRENCY_EDIT=2
WORKER_CONCURRENCY_REFRAME=1
ENCODE_PRESET=veryfast     # ffmpeg x264 preset; veryfast | medium | slow
WHISPER_MODEL=small        # base | small | medium
MAX_SOURCE_MINUTES=30
BEHIND_TLS=false           # Set true if behind a reverse proxy with HTTPS
LOG_LEVEL=info             # debug | info | warn | error
```

`.env.example` ships with the three required values blank and a one-liner for each (`# generate with: openssl rand -hex 32`).

---

## 14. Phase-by-phase build plan (12 working days)

Each phase has a single demo-able outcome. Don't move on until the demo works.

### Phase 0 — Repo & infra (1 day)

**Demo:** `docker compose up` starts three services and Postgres reports `pg_isready`. App responds 200 on `/health`.

- `git init`, MIT `LICENSE`, `README.md` skeleton, `.gitignore`, `.dockerignore`
- `docker-compose.yml` with three services
- App and worker Dockerfiles (basic; just say "hello world" from each)
- Postgres image, volumes, healthchecks
- `.env.example` with all required vars
- GitHub Actions skeleton for multi-arch builds (matrix push on tag only)
- Verify pg-boss version on npm, pin exact version
- Verify Anthropic SDK version, pin exact version
- Verify Haiku model string

### Phase 1 — Skeleton end-to-end (1 day)

**Demo:** From a logged-in admin session, a `POST /api/jobs` creates a row, an `upload` endpoint streams a file to disk, and a single fake `transcribe` queue handler logs "I would transcribe X" — with all three services healthy.

- Migrations runner (50 lines)
- All migrations applied at app boot
- `db.js`, `queue.js` (pg-boss), `auth.js` (sessions + bcrypt)
- `setup-wizard.html` and routes
- `login` / `logout` routes
- `POST /api/jobs` and Busboy upload route
- Worker subscribes to `transcribe` queue with stub handler
- HTMX vendored, basic stylesheet, `jobs-list.html`

### Phase 2 — Transcribe + segment (2 days)

**Demo:** A 60-second uploaded MP4 produces a real SRT in the data volume, then five candidate segments (from rule pre-filter), then 2–3 clips proposed by Claude with reasons. Status flips to `awaiting_approval`.

- `whisper.py` script + worker stage
- Pre-filter implementation + unit tests
- `anthropic.js` with tool-use rankSegments
- System prompt for segment ranking
- Integration with `clips` table inserts
- Verify cost: log Anthropic token usage

### Phase 3 — Approval + edit + reframe (3 days)

**Demo:** A user approves 2 of the 3 proposed clips and ten minutes later sees two 9:16 1080×1920 MP4s with face-tracked crops and ASS-burned captions on the dashboard.

- `job-detail-approval.html` with HTMX form
- `POST /api/jobs/:id/approve` with clip selection
- `runEdit`: ffmpeg cut + auto-editor + audio chain
- `mediapipe_track.py` + smoothing + crop expression generation
- `ass_render.py` for caption burn-in
- `runReframe` for TRACK mode
- `runReframe` for GENERAL mode (single-camera dual-speaker)
- Real-time progress polling (`every 3s`)

### Phase 4 — Finalize + dashboard polish + cleanup (2 days)

**Demo:** Full job: 5-min source → 3 ready clips, each with thumbnail, IG caption, LinkedIn caption, and 5–8 hashtags. "Download MP4" button works. "Copy caption" button works.

- `runFinalize`: thumbnail + caption pass
- Caption-pass system prompt (separate from segment system prompt)
- `ready-clips.html` partial
- Asset cleanup job (TTL on `source` kind, 30 days default)
- Brand config form
- Settings page

### Phase 5 — First-run wizard polish + key encryption (1 day)

**Demo:** A stranger with the repo and Docker can go from `git clone` to "first job submitted" in under five minutes following only the README.

- Wizard polish (3-step UI)
- `encryption.js` audited and unit-tested (round-trip property test)
- Test-connection live HTMX flow
- Error handling for bad keys
- README "Quick start" section

### Phase 6 — Docs & screenshots (1 day)

**Demo:** README is a stranger could-actually-follow-this document. SECURITY.md exists. CONTRIBUTING.md exists. A 90-second demo GIF shows the full flow.

- README with screenshots
- SECURITY.md (threat model, key handling, audit invitation)
- CONTRIBUTING.md (code style, PR flow, testing)
- Architecture diagram (re-use the one from the manifesto)
- Recorded demo GIF (asciinema for terminal, OBS for browser)

### Phase 7 — End-to-end test + harden (1 day)

**Demo:** Three real-world source videos (M2 MacBook, Ryzen 5 5600, an older quad-core) all complete the full pipeline end-to-end without manual intervention. CI smoke test passes on both architectures.

- Smoke test in CI (60-second source → finalize → assert)
- Hardware test on three target machines
- Document realistic timings in README
- Hardening pass: every external call has retry + backoff
- Reconciler tested by killing the worker mid-job

### Phase 8 — Public launch (1 day)

**Demo:** v0.1.0 tag pushed, GHCR images live, README has a "What is this?" header, README links work, ShowHN / Reddit / Twitter draft ready.

- Tag v0.1.0
- Verify multi-arch images on GHCR
- Write launch post (HN, r/selfhosted, X)
- Set up GitHub Discussions
- Issue templates

**Total: 12 working days.** That's the v0.1 budget. Anything past v0.1 is community-driven or on your own clock.

---

## 15. Performance — hitting the 25-minute budget

The pipeline research surfaced a sobering reality: a naive 60-second clip on a 4-core CPU takes roughly 5 minutes through reframe + caption burn-in (140s for MediaPipe, ~100s for the final encode). Five clips in serial = 25 minutes of just reframe work, which busts the manifesto's whole-pipeline budget.

**Three mitigations, applied in v1:**

**Downscale before MediaPipe.** Face centroids are stable at 720p; we don't need 1080p detection. The Reframe stage runs MediaPipe on a 720p copy, generates the trajectory, and then re-encodes the original at 1080p with the trajectory. Speedup on MediaPipe: ~2.5×.

**Use `veryfast` x264 preset.** The manifesto's `medium` was right for the TPC server (where final visual quality mattered for client-facing work). For OSS users on consumer hardware, `veryfast` is the right default. Speedup on encoding: ~3×. Quality difference on burned-caption short-form is invisible to viewers.

**Parallel clip processing.** `WORKER_CONCURRENCY_REFRAME=1` is the safe default (one full ffmpeg encode at a time), but on 8+ core machines the user can set it to 2 and roughly double per-job throughput. Documented prominently.

With all three applied: a 10-min source → 5 clips on a 4-core machine should hit ~22–25 minutes wall-clock end-to-end, matching the manifesto's promise. On an 8-core box (M3 Pro, Ryzen 7 7700) with concurrency=2 it drops to ~15 minutes. Document both numbers; promise the 4-core number.

---

## 16. Testing strategy

Three levels.

**Unit tests** on the small pure-logic surfaces: encryption round-trip, pre-filter scoring, smoothing, prompt construction, Zod schema validation. Run on every push via `npm test`. Keep total runtime under 30 seconds.

**Integration tests** on database operations (real Postgres in CI via the `services:` block in GH Actions). Migrations apply cleanly from empty. RLS policies (when added) actually deny.

**End-to-end smoke test** is the one test that matters most. Ship a 60-second MP4 in `worker/test/fixtures/`. CI runs the full pipeline through to a finalize and asserts the resulting MP4 is >100 KB, is 1080×1920, contains burned-in captions (via a frame extract + naive pixel check), and the duration is within 5% of expected. Runs on both amd64 and arm64. This is the canary that catches dependency drift across whisper/mediapipe/ffmpeg/auto-editor.

---

## 17. Security posture

`SECURITY.md` documents this; the implementation needs to back it.

**API keys.** AES-256-GCM, 100k PBKDF2 iters, IV per row, master key in env, never logged, decrypted only in worker memory at the moment of use. A grep for `anthropic_key` in logs should return zero hits.

**Passwords.** bcrypt cost 12. Stored hash only. No password reset flow in v1; if you forget, `docker compose run --rm app node src/scripts/reset-password.js` lets the admin reset locally.

**Sessions.** httpOnly cookies, sameSite=lax, secure-only when `BEHIND_TLS=true`. Session store is Postgres so a `docker compose down` doesn't trash sessions.

**File uploads.** Filename sanitization on Busboy save (replace anything not `[a-zA-Z0-9._-]`). 2 GB hard cap. Source file path is an absolute server-side path, never user-controlled.

**Outbound network.** The worker calls one host: `api.anthropic.com`. Document this. (A future paranoid mode could egress-firewall everything else; out of scope for v1.)

**SQL.** Parameterized queries everywhere. No string interpolation into queries. ESLint rule for `no-template-literal-in-pg-query` is an option.

**Container.** App and worker both run as non-root (`USER node` after the build steps). Volumes are owned by the node user.

---

## 18. Open implementation questions

These are the things that will require real-time judgment when you actually open an editor. Don't pre-answer them; just know they exist.

1. **Exact pg-boss API surface in v12.** The auto-schema-creation behavior is the biggest improvement; the `boss.work()` vs older `boss.subscribe()` API names changed. Verify in Phase 0 and re-check section 8.
2. **Anthropic SDK tool_choice exact syntax.** The pattern in section 9.2 is correct as of the SDKs I'm familiar with, but the exact field names (`tool_choice: { type: 'tool', name: '...' }` vs `tool_choice: { type: 'any' }` vs the `forced` flag) can shift. Read the SDK docs at build time.
3. **MediaPipe Tasks API arm64.** Research said "native arm64 via XNNPACK in 0.10+." Confirm by running the smoke test in arm64 CI before merging Phase 0. If it's broken, fall back to `mediapipe-silicon` for arm64 users (with a docs note).
4. **`auto-editor` output filename behavior.** It defaults to `*_edit.mp4` rather than honoring `--output` in some versions. Verify when wiring up the edit stage; if needed, add a rename step.
5. **Caption font availability in container.** `Inter` may not be installed in `node:20-bookworm-slim`. The Dockerfile needs `fonts-inter` (or any free font). Choose the default font based on what's small and bookworm-available; document how to swap.
6. **Test-connection during setup wizard.** Decide whether failure puts the user back at step 2 (key field) or step 3 (full retry). UX decision; Phase 5.
7. **Reconciler exact behavior.** "Frozen for >15 minutes mid-stage" needs a concrete query. Phase 7.
8. **CI smoke-test fixture.** Find or record a 60-second public-domain talking-head MP4 with clear speech. Maybe a Wikipedia commons clip; the legal status matters because we'll redistribute it as a test fixture.

---

## 19. After v0.1 (not a commitment, just notes)

Things real users will ask for, in rough priority order:

- **Master key rotation script** (from section 6.3).
- **Alternate LLM providers** behind `LLM_PROVIDER` env var (OpenAI, Gemini, Ollama). Provider abstraction in `worker/src/lib/llm.js`.
- **Studio-Sound-style mastering** via RNNoise + better loudnorm two-pass.
- **Active-speaker detection** for GENERAL-mode dual-speaker single-camera content.
- **Caption-style picker UI** (currently SQL-only).
- **MAX_SOURCE_MINUTES lift** with chunked transcription.
- **GPU opt-in** for users who have one (whisper + ffmpeg with `--enable-cuda` or `--enable-vaapi`).
- **MinIO-as-storage** properly documented and tested.
- **Multi-user / RLS-on-by-default** if a real demand emerges.

None of these are promises. v0.1 is the contract; everything after is contingent on you wanting to keep working on it.

---

*PROJECT_NAME — implementation plan v1.0 (OSS), 2026-04-27. Companion to `PROJECT_MANIFESTO_OSS.md` v1.0.*
