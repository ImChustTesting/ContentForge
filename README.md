# ContentForge

> Self-hosted, open-source short-form video pipeline. Drop in a long recording, get back vertical, captioned, broadcast-loud clips ready for IG Reels and LinkedIn — on your own machine, no SaaS dependency for editing.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-v0.1%20development-orange.svg)](#status)
[![Node](https://img.shields.io/badge/node-20.x-brightgreen.svg)](#tech-stack)
[![Python](https://img.shields.io/badge/python-3.12-brightgreen.svg)](#tech-stack)
[![Docker](https://img.shields.io/badge/docker-required-blue.svg)](https://docs.docker.com/compose/install/)

---

## Table of contents

- [What it does](#what-it-does)
- [What it doesn't do](#what-it-doesnt-do)
- [Why ContentForge exists](#why-contentforge-exists)
- [Quick start](#quick-start)
- [Hardware](#hardware)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Configuration](#configuration)
- [Common operations](#common-operations)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Privacy](#privacy)
- [Security](#security)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgements](#acknowledgements)

---

## What it does

1. **Upload** an MP4 / MOV / MKV / WebM (≤ 30 minutes, ≤ 2 GB).
2. **Transcribe** it with `faster-whisper` on CPU.
3. **Pre-filter** generates ~12 candidate clip ranges using caption density, hook-word detection, and a 15–90 second window.
4. **Rank** with Claude Haiku — proposes the top 3–10 clips, each with a one-sentence reason and a draft title/caption.
5. **Approve** the keepers (the only human step).
6. Per approved clip, in parallel:
   - ffmpeg cuts the range
   - `auto-editor` removes silences and dead space
   - ffmpeg denoises (`afftdn`) and EBU R128 loudness-normalizes (`loudnorm` to -16 LUFS)
   - MediaPipe face-tracks the crop centroid; an EMA smooths the trajectory
   - ffmpeg crops 9:16 around the smoothed centroid (or blurred-background centered crop in two-speakers/one-camera mode)
   - ffmpeg burns in styled captions (ASS) using your brand config
   - ffmpeg pulls a thumbnail from the midpoint
   - Claude writes the final IG + LinkedIn caption variants and 5–8 hashtags
7. **Download** the MP4s and post them by hand.

**Wall-clock for a 10-minute source:** ~25 minutes on a 2022 laptop. **Cost:** $0 to install and host, ~$0.05–0.10 in Anthropic tokens per source video.

---

## What it doesn't do

These are conscious omissions, not missing features. Each has a specific reason in [`PROJECT_MANIFESTO_OSS.md`](PROJECT_MANIFESTO_OSS.md) §4.

- **Auto-publish** to IG / LinkedIn / TikTok. Manual download is the design, not a placeholder for a future feature.
- **GPU acceleration** as default. CPU-only is the contract.
- **Voice cloning, dubbing, multi-track DAW workflow.** Descript territory; entirely different problem.
- **Designed thumbnails** with text overlay. v1 thumbnail is a midpoint frame.
- **Music beds, B-roll, motion graphics, animated text.** Layer those in a real editor after export if needed.
- **Multi-tenant on a single deployment.** Single-user-per-install. If two people want it, run two installs.
- **Hosted tier.** Explicitly never. The point of this project is that you run it yourself.
- **Browser extension or mobile app.** Web dashboard only.
- **Telemetry / analytics / phone-home.** Zero. The tool calls Anthropic for inference; nothing else leaves your box.

---

## Why ContentForge exists

There are two kinds of short-form video tools today, and neither fits someone who wants control over their own footage and editorial process.

- The **SaaS tier** (Opus Clip, Vizard, Submagic, Descript) requires uploading your raw footage to someone else's servers, accepting whatever clip quality the model returns, and paying $16–$30 per month.
- The **OSS tier** (ClipsAI, OpenShorts, AI-Youtube-Shorts-Generator) scatters across half-finished projects, GPU assumptions, weak human-review UX, and a default of OpenAI for the language model. None of them install with one `docker compose up` on a 2022 laptop and produce a polished result.

ContentForge closes that gap: one repo a stranger can clone, run with one command, point at an MP4, and walk away with three publish-ready clips an hour later — having paid nothing beyond their own Anthropic tokens (~$0.10/video) and revealed nothing of their footage to any third party except Anthropic's API, which only ever sees the transcript.

Differentiation in one line: **BYO Claude, human-gate-as-feature, single `docker compose up`, MIT.**

---

## Quick start

You need **Docker** with Compose v2 (the default since Docker Desktop 4.x and Linux 22.04+).

```bash
git clone https://github.com/ImChustTesting/ContentForge.git
cd ContentForge

# Copy the env template and generate the three required secrets
cp .env.example .env
```

Edit `.env` and paste these three values (each generated with `openssl rand -hex 32`):

```bash
POSTGRES_PASSWORD=<openssl rand -hex 16>
SESSION_SECRET=<openssl rand -hex 32>
ENCRYPTION_KEY=<openssl rand -hex 32>     # MUST be 64 hex chars
```

Then:

```bash
docker compose up -d --build
# wait ~3 min on a cold cache; the worker image is the bulk
open http://localhost:3000
```

The first-run wizard asks for an admin password and your Anthropic API key (get one at <https://console.anthropic.com>). A "Test connection" button makes a real Claude call before saving. You're now a few drag-drops away from your first vertical clip.

---

## Hardware

| Tier | CPU / RAM | Notes |
|---|---|---|
| **Verified-good** | M2 (8 GB), Ryzen 5 5600 (16 GB), i7-12700H (16 GB) | Hits the 25-min budget for a 10-min source. |
| **Target floor** | 4+ cores, 8 GB RAM, no GPU, 10 GB free disk | Budget holds with `ENCODE_PRESET=veryfast` (the default). |
| **Best-effort** | Older x86 quad-core | Expect 1.5–2× longer wall-clock. |
| **Below floor** | 2-core CPUs, ARM SBCs (Pi 4, etc.) | Not supported. The pipeline will technically run but blow well past the budget. |

Apple Silicon and amd64 are first-class. Multi-arch images are built from day one in CI.

---

## Architecture

Three containers, one queue, one volume, one Postgres.

```
┌─────────────────────────────────────────────────────────────┐
│                     User's Browser                          │
│              (http://localhost:3000)                        │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTMX / JSON
                           ▼
                ┌─────────────────────┐
                │  app                │
                │  Express + HTMX     │
                │  - Setup wizard     │
                │  - Jobs CRUD        │
                │  - Approval UI      │
                │  - File downloads   │
                └──────┬──────────┬───┘
                       │ enqueue  │ read/write
                       ▼          ▼
                ┌──────────────────────┐
                │  postgres (16)       │
                │  - app data          │
                │  - pg-boss queues    │
                │  - encrypted secrets │
                │  - sessions          │
                └──────────┬───────────┘
                           │ SELECT … FOR UPDATE SKIP LOCKED
                           ▼
            ┌────────────────────────────────────┐
            │  worker                            │
            │  Node + Python venv (in-container) │
            │  niced 19, ionice idle             │
            │  - shells out to:                  │
            │    ffmpeg, faster-whisper,         │
            │    auto-editor, mediapipe          │
            │  - calls api.anthropic.com         │
            └──────────┬─────────────────────────┘
                       │ writes
                       ▼
                ┌─────────────────────┐
                │  data volume        │
                │  /data/uploads      │
                │  /data/clips        │
                │  /data/captions     │
                │  /data/thumbs       │
                └─────────────────────┘
```

- **app** serves the dashboard, handles uploads, enqueues work. ~120 MB image.
- **worker** runs the pipeline. Node orchestrates, Python does whisper + MediaPipe + auto-editor. ~750 MB image (Python venv is most of it).
- **postgres 16** stores app data, encrypted secrets, sessions, and pg-boss queues.
- **data volume** holds source videos, edited clips, final clips, captions, thumbnails. Back it up like any other Docker volume.

Detailed architecture: [`PROJECT_MANIFESTO_OSS.md`](PROJECT_MANIFESTO_OSS.md) §6. Build spec: [`IMPLEMENTATION_PLAN_OSS.md`](IMPLEMENTATION_PLAN_OSS.md).

### Why these choices

- **pg-boss instead of Redis.** You already have Postgres for app data. pg-boss uses `SELECT … FOR UPDATE SKIP LOCKED` for exactly-once delivery, retries with backoff, dead-letter routing. One fewer container in `docker-compose.yml`, one fewer thing to monitor, one fewer thing to keep up to date. Self-hosters thank you.
- **Local volume instead of S3 / MinIO by default.** Local disk requires zero configuration. MinIO is supported as opt-in.
- **Claude Haiku instead of GPT-4o or local Llama.** Haiku produces the highest-quality short JSON outputs at this price point. BYO Anthropic key is unambiguously sanctioned. Picking one provider keeps the code simple. An `LLM_PROVIDER` env var for OpenAI / Ollama is a v0.2 candidate.
- **Express + HTMX instead of Next.js or React.** Server-rendered, no build step, fits in the same container as the API. The dashboard has six screens; HTMX is enough.
- **MIT instead of AGPL.** ffmpeg defaults to LGPL v2.1, which is incompatible with Apache 2.0 unless you compile with `--enable-version3`. MIT sidesteps the issue. Local OSS-clip-tool convention is also MIT.

---

## Tech stack

Pinned versions for an April 2026 build. See [`IMPLEMENTATION_PLAN_OSS.md`](IMPLEMENTATION_PLAN_OSS.md) §2 for the rationale and `.github/workflows/build.yml` for the actual CI build.

| Component | Version |
|---|---|
| Node.js (app + worker) | 20.x LTS (`node:20-bookworm-slim`) |
| Python | 3.12 |
| Postgres | 16 (`postgres:16-bookworm`) |
| ffmpeg | 6.x from Debian bookworm apt |
| **Node packages (app)** | |
| express | ^4.21 |
| express-session, connect-pg-simple | ^1.18 / ^9.0 |
| pg, pg-boss | ^8.13 / ^10.1 |
| @anthropic-ai/sdk | ^0.30 |
| handlebars, busboy, bcrypt, zod, pino | latest stable |
| **Python packages (worker)** | |
| faster-whisper | 1.1.3 |
| ctranslate2 | 4.7.0 |
| mediapipe | 0.10.14 |
| opencv-python-headless | 4.10.0.84 |
| pysubs2 | 1.7.3 |
| auto-editor | 27.0.1 |
| numpy | 1.26.4 |

---

## Configuration

All configuration lives in `.env` (copy from `.env.example`). The three required values must be set before first start; the rest have sensible defaults.

### Required

| Var | Generate with | Notes |
|---|---|---|
| `POSTGRES_PASSWORD` | `openssl rand -hex 16` | Postgres user password. |
| `SESSION_SECRET` | `openssl rand -hex 32` | Express session signing key. |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` | AES-256-GCM master key for the stored Anthropic key. **Must be exactly 64 hex chars.** Do not change after first use without [rotating](SECURITY.md#master-key-rotation). |

### Optional

| Var | Default | Notes |
|---|---|---|
| `APP_PORT` | `3000` | Host port the dashboard binds to. |
| `ENCODE_PRESET` | `veryfast` | x264 preset for the final encode. `medium` improves quality slightly at ~3× the time. |
| `WHISPER_MODEL` | `small` | `base` is faster; `medium` is too slow on 4-core CPUs. |
| `MAX_SOURCE_MINUTES` | `30` | Lift at your own risk; longer sources hit Claude Haiku's context window awkwardly. |
| `WORKER_CONCURRENCY_EDIT` | `2` | edit is mostly disk I/O; safe to raise on fast SSDs. |
| `WORKER_CONCURRENCY_REFRAME` | `1` | reframe is CPU-bound; raise to 2 only on 8+ core machines. |
| `BEHIND_TLS` | `false` | Set `true` if behind a reverse proxy with HTTPS so cookies are marked `Secure`. |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. |

---

## Common operations

### Back up your data

```bash
# Data volume (uploads, clips, captions, thumbs)
docker run --rm -v contentforge_data:/d -v "$PWD":/out alpine \
  tar czf /out/cf-backup-$(date +%F).tgz -C /d .

# Postgres (jobs, clips, encrypted secrets)
docker run --rm -v contentforge_postgres-data:/d -v "$PWD":/out alpine \
  tar czf /out/cf-pg-$(date +%F).tgz -C /d .
```

### Restore from backup

```bash
docker compose down
docker volume rm contentforge_data contentforge_postgres-data
docker volume create contentforge_data
docker volume create contentforge_postgres-data
docker run --rm -v contentforge_data:/d -v "$PWD":/in alpine \
  tar xzf /in/cf-backup-2026-04-27.tgz -C /d
docker run --rm -v contentforge_postgres-data:/d -v "$PWD":/in alpine \
  tar xzf /in/cf-pg-2026-04-27.tgz -C /d
docker compose up -d
```

### Reset the admin password

```bash
docker compose run --rm app node src/scripts/reset-password.js <new-password>
```

### Rotate the master encryption key

See [`SECURITY.md`](SECURITY.md#master-key-rotation).

### Update to a new release

```bash
git pull
docker compose build
docker compose up -d
```

Migrations apply automatically at app boot.

### Tail container logs

```bash
docker compose logs -f app
docker compose logs -f worker
```

### Reset everything (destroys all jobs and clips)

```bash
docker compose down -v   # -v removes volumes
```

---

## Troubleshooting

**The dashboard health check stays unhealthy.**
Check `docker compose logs app`. Most likely: missing `ENCRYPTION_KEY` or `SESSION_SECRET` in `.env`. Both are required and the app fails fast at startup if missing.

**`ENCRYPTION_KEY must be 64 hex characters` at startup.**
Regenerate: `openssl rand -hex 32` and paste into `.env`. The error is unforgiving on purpose — silently accepting a short key would weaken the AEAD. After changing, see [key rotation](SECURITY.md#master-key-rotation) if you already have data encrypted with the old key.

**Claude returns "pre-filter produced 0 candidates".**
The source is too short or too uniform (silence, monotone background noise). Try a source with at least three minutes of clear speech.

**Face-tracked crops drift off-center.**
MediaPipe's face confidence dropped below 0.4 for too long; the worker auto-falls-back to GENERAL mode (blurred-background centered crop) when this happens. If you want pure TRACK output anyway, re-record with better framing or higher contrast on the speaker.

**Postgres restarts on `docker compose up`.**
Check that `POSTGRES_PASSWORD` is set in `.env` and matches the value the database was initialized with. If you've forgotten it, `docker volume rm contentforge_postgres-data` (destructive — wipes all jobs) and start over.

**Captions look mis-timed.**
Known limitation: `auto-editor` removes mid-clip silences, which shifts speech relative to the original SRT timestamps. Captions from the original transcript can drift on long clips. This is a tradeoff for v1 — fix is a v0.2 candidate (re-transcribe the trimmed clip in finalize).

**The worker is using too much CPU.**
By design, all ffmpeg / whisper / mediapipe runs are wrapped in `nice -n 19 ionice -c2 -n7` so other things on your machine have priority. If a clip takes longer than the table claims, that's the tradeoff. To restore default niceness, edit `worker/entrypoint.sh`.

**Anthropic call returns 401 / 403.**
Your saved key was rejected. Visit Settings → Anthropic API key, paste a new one, hit "Test & save." The new key is tested with a real Claude call before being encrypted and saved.

**Build fails fetching the MediaPipe model.**
The worker Dockerfile downloads `face_detector_short_range.tflite` from `storage.googleapis.com`. If your build environment can't reach that host, mirror the file and edit the Dockerfile's `curl` URL.

---

## FAQ

### Why a Bring-Your-Own-Key model instead of using a free LLM?

Three reasons. Quality (Haiku is the best per-dollar model for short structured-JSON tasks). Sanction (BYO Anthropic key is the unambiguous correct path post-OpenClaw-ban). Simplicity (one provider, one set of docs, one auth path). A `LLM_PROVIDER` env var that lets advanced users swap in OpenAI or local Ollama is a reasonable v0.2 addition.

### How much does running this cost?

- **Software:** $0. MIT license, no SaaS dependency.
- **Hosting:** $0. It runs on your machine.
- **Inference:** ~$0.05–0.10 per source video. Two short Claude calls per source plus one per clip, all on Haiku, on your Anthropic bill.
- **Storage:** $0. Your local disk.

For comparison: Opus Clip Pro is $19/month, Vizard Pro is $30/month, Submagic is $16/month. ContentForge pays for itself against any of them in a couple of weeks of heavy use.

### Does my video data leave my machine?

No. The transcript leaves your machine — to `api.anthropic.com`, only when you upload, only for ranking and caption-writing. The video itself never leaves your disk. Verify with `tcpdump` if you don't trust me.

### Can I run this on a Raspberry Pi?

You can run it. You will not enjoy it. The pipeline assumes 4+ x86_64 cores or Apple Silicon performance cores. ARM SBCs are documented as unsupported.

### Why no GPU support?

CPU-only is the contract — many users don't have GPUs, and the moment we accept "GPU is optional" we accept "the README has two install paths and the docs are twice as long." A user with a GPU can swap `faster-whisper` to `device='cuda'` in `whisper.py` and `ENCODE_PRESET` to `medium`; we'll happily merge a documented contribution that does this behind a `USE_GPU=true` env var.

### Can I post directly to Instagram / LinkedIn / TikTok?

No, by design. Each platform requires per-app review (2–4 weeks per platform), per-user OAuth, and brittle webhook handling. That's a SaaS-shaped feature, and ContentForge is explicitly not SaaS-shaped. Out of scope forever.

### Can I run multiple users on one deployment?

Single-user-per-install in v1. The schema permits multi-user (RLS is enabled) but the app layer enforces one row in `users`. If you want multi-tenant, run two installs.

### How long does it actually take?

For a 10-minute talking-head source on a 2022 MacBook Air M2 (8 GB) producing 5 ready clips:
- Transcribe: ~3 min
- Segment (Claude): ~10 s
- Approval gate: human time, variable
- Per clip, in parallel: edit ~30 s, reframe ~45 s, finalize ~5 s
- Final encode: ~2 min per clip (the bottleneck)

End-to-end wall-clock: ~20–25 min. User attention: under 5 min spread across that.

### What happens if my container crashes mid-pipeline?

Every long-running stage goes through `pg-boss`. Container restarts pick up where they left off. A reconciler runs every 10 minutes and re-enqueues any job whose `updated_at` has been frozen for more than 15 minutes mid-stage. After exhausting retries (2–3 per queue), a job hits the `dlq` queue and surfaces a dashboard banner.

### I lost my Anthropic key — can I recover it from the database?

No. The key is encrypted with AES-256-GCM using your `ENCRYPTION_KEY` master key. If you lose the master key (the `.env` file), the stored ciphertext is unrecoverable by design. Just paste a new key in Settings.

### How do I contribute?

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Read it before opening a feature PR — there's a hard scope guard tied to the manifesto.

---

## Privacy

The only outbound network call this software makes is to `api.anthropic.com`, and only the transcript and brand voice are sent — never the video. There is no telemetry. There is no analytics endpoint. There is no phone-home. Verify with `tcpdump` or your firewall if you don't trust me.

The default deployment binds to `127.0.0.1:3000`. If you expose it on a LAN, do so behind your own reverse proxy with TLS and access control, and set `BEHIND_TLS=true` so cookies are marked `Secure`.

---

## Security

Threat model, key handling, audit invitation, and reporting are documented in [`SECURITY.md`](SECURITY.md). The short version:

- Anthropic API keys are encrypted at rest with AES-256-GCM, master key in `ENCRYPTION_KEY` env var, decrypted only in worker process memory at the moment of an outbound call. Never logged.
- Admin password is bcrypt cost 12.
- Sessions are server-side in Postgres, `httpOnly` + `sameSite=lax`, `Secure` when `BEHIND_TLS=true`.
- Containers run as non-root.
- The encryption surface is small and explicitly audit-friendly. PRs and security advisories welcome.

---

## Roadmap

ContentForge is intentionally narrow. v0.1 is the contract; everything past it is contingent on whether the maintainer wants to keep working on it and what users actually ask for.

Likely candidates, in rough priority order (none are commitments):

- Master key rotation script as a first-class feature (currently a documented procedure).
- Alternate LLM providers behind `LLM_PROVIDER` env var (OpenAI, Gemini, local Ollama).
- Studio-Sound-style mastering via RNNoise + better loudnorm two-pass.
- Active-speaker detection for two-speakers/one-camera content (currently falls back to GENERAL mode).
- Caption-style picker UI (currently a settings form).
- `MAX_SOURCE_MINUTES` lift via chunked transcription.
- GPU opt-in for users who have one.
- MinIO-as-storage path that is properly tested.

What will **not** be added: see [What it doesn't do](#what-it-doesnt-do) and [`PROJECT_MANIFESTO_OSS.md`](PROJECT_MANIFESTO_OSS.md) §4.

---

## Status

**v0.1 development.** All code is written, unit tests pass, the Docker images build (in CI). Not yet tested against three diverse hardware targets. Not yet tagged `v0.1.0`.

Watch the [GitHub releases](https://github.com/ImChustTesting/ContentForge/releases) page for the public launch announcement.

---

## Contributing

PRs welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first — there's a scope guard tied to the manifesto, and the maintainer's bandwidth is finite. If you're proposing a feature, check it against [`PROJECT_MANIFESTO_OSS.md`](PROJECT_MANIFESTO_OSS.md) §4 before writing code.

For security issues, file a [security advisory](https://github.com/ImChustTesting/ContentForge/security/advisories/new), not a public issue.

---

## License

[MIT](LICENSE). Use it, fork it, sell forks of it, run it for clients, embed it in something larger — all fine. Just keep the copyright notice.

---

## Acknowledgements

ContentForge stands on the shoulders of:

- [**ffmpeg**](https://ffmpeg.org/) — the actual video and audio engine. We just wave our hands at it.
- [**faster-whisper**](https://github.com/SYSTRAN/faster-whisper) — CTranslate2-backed CPU-first whisper, several times faster than the reference implementation.
- [**MediaPipe**](https://developers.google.com/mediapipe) — Google's CPU face detection. The trajectory smoothing on top is ours; the heavy lifting is theirs.
- [**auto-editor**](https://auto-editor.com/) — silence trimming with a sane default UX.
- [**pysubs2**](https://github.com/tkarabela/pysubs2) — ASS subtitle generation.
- [**HTMX**](https://htmx.org/) — the dashboard would be 5× the code without it.
- [**pg-boss**](https://github.com/timgit/pg-boss) — Postgres-backed job queue that means we don't ship a Redis container.
- [**Anthropic Claude**](https://www.anthropic.com/) — the language model doing the clip-selection work.

And the prior-art OSS clip tools that informed the scope: [ClipsAI](https://github.com/ClipsAI/clipsai), [ClippedAI](https://github.com/ClippedAI/clippedai), [mutonby/openshorts](https://github.com/mutonby/openshorts), [AI-Youtube-Shorts-Generator](https://github.com/SamurAIGPT/AI-Youtube-Shorts-Generator). Their authors did the prospecting; we tried to learn from what worked and what didn't.

---

**Reading order for the curious:** [`PROJECT_MANIFESTO_OSS.md`](PROJECT_MANIFESTO_OSS.md) → [`IMPLEMENTATION_PLAN_OSS.md`](IMPLEMENTATION_PLAN_OSS.md) → [`SECURITY.md`](SECURITY.md) → [`CONTRIBUTING.md`](CONTRIBUTING.md).
