# PROJECT_NAME — Project Manifesto (OSS)

> A self-hosted, open-source short-form video pipeline.
> Status: pre-build. This document is the **verifiable scope and shape** of the OSS project.
> The Implementation Plan (to be written) is the build spec.
> Ancestor document: `PROJECT_MANIFESTO.md` — the TPC internal version this is forked from.

---

## 0. One paragraph

PROJECT_NAME turns a raw long-form recording into a small set of polished, vertical, captioned short-form clips — ready for IG Reels and LinkedIn — on the user's own machine, with no SaaS dependency for the editing path. It runs on consumer-grade hardware (no GPU required) using open-source tooling (ffmpeg, faster-whisper, MediaPipe, auto-editor) and Claude Haiku for the language-model work via a user-supplied Anthropic API key. There is exactly **one** human gate — the user reviewing AI-proposed segments — and everything before and after that gate is fully automated. Distribution is a single `docker compose up`. License is MIT. No hosted tier exists, will exist, or is planned. This is open source as a labor of love and as a working tool.

---

## 1. Why this exists

There are two kinds of short-form video tools today, and neither is the right fit for someone who wants control over their own footage and editorial process.

The SaaS tier — Opus Clip, Vizard, Submagic, Descript — works well, picks decent clips, and lets you click "publish" without thinking. It also requires you to upload your raw footage to someone else's servers, accept whatever clip quality the model hands you, and pay a monthly subscription that prices out hobbyists, students, and creators in regions where ten dollars is real money.

The OSS tier — ClipsAI, ClippedAI, mutonby/openshorts, AI-Youtube-Shorts-Generator — exists and is mostly maintained, but it scatters across half-finished projects, GPU assumptions, weak human-in-the-loop UX, and a default of OpenAI for the language model. None of them install with a single `docker compose up` on a 2022 laptop and produce a polished result.

PROJECT_NAME exists to close that gap. The vision is one repository that a stranger can clone, run with one command, point at an MP4, and walk away with three publish-ready clips an hour later — having paid nothing beyond their own Anthropic tokens (~$0.10 per source video) and revealed nothing of their footage to any third party except Anthropic's API, which only ever sees the transcript.

---

## 2. The vision (the felt experience)

A user clones the repo, copies `.env.example` to `.env`, runs `docker compose up`, and opens `http://localhost:3000`.

The first-run wizard asks them to create an admin password, paste their Anthropic API key, and click a "test connection" button that makes a real Claude call and prints the response. Three minutes from `docker pull` to dashboard.

They drag a 12-minute talk into the upload zone. About a minute later, the dashboard shows seven proposed segments. Each one has a start time, an end time, the transcript of that range, and a one-sentence reason from the AI ("Strong opening hook — names the problem in seven words and pivots to a contrarian frame").

They skim the seven, agree with three, reject four, hit **Approve**.

About fifteen minutes later, three vertical 9:16 MP4s are sitting in the dashboard. Each has a face-tracked center, audio cleaned to broadcast loudness, captions burned in, a thumbnail at the visual midpoint, and a draft caption with five hashtags.

They download the three MP4s, post each to IG Reels and LinkedIn by hand, and are done.

Total user time: roughly five minutes of attention spread across eighteen minutes of wall-clock. The machine did the rest, on the user's own laptop, and Anthropic saw only the transcript.

That is the bar. The system is successful when a stranger with no prior context can take a published-quality short to upload with that level of touch, on their own hardware, with one command to install.

---

## 3. Scope: what PROJECT_NAME does (v1)

### 3.1 Ingest
Accepts MP4, MOV, MKV, WebM up to 30 minutes and 2 GB. Stored on the local filesystem (mounted Docker volume) by default. MinIO is supported as an optional service for users who want S3-compatible storage; the default install never touches S3 or any external storage provider.

### 3.2 Transcribe
Extracts mono 16 kHz audio with ffmpeg, runs faster-whisper int8 on CPU to produce an SRT subtitle file with word-level timestamps. SRT persists as a project asset.

### 3.3 Segment
The transcript is parsed into cues. A rule-based pre-filter generates ~12 candidate ranges using caption density, speaker-change markers, hook-word detection, and a 15–90 second duration window. Those candidates are sent to Claude Haiku with brand context, target clip count (3–10), and instructions to rank and return JSON-structured segment proposals — start/end cue IDs, draft titles, draft captions, and a one-sentence reason for each pick. The system prompt is cached.

The hybrid pre-filter is deliberate. Pure-LLM segment selection on a 30-minute transcript produces a high false-positive rate (the published comparable is Opus Clip's internal LLM-as-judge work, which reports ~35% export rate on top-ranked candidates). Rule-based pre-filtering raises the floor of what Claude is asked to choose between, and turns its job into ranking instead of search.

### 3.4 Approve (the only human gate)
The user sees proposed segments inside a transcript-aware UI, ticks the keepers, hits Approve. Rejected proposals are deleted; accepted ones move to the edit queue. **The approval gate is a feature, not a step to optimize away.** The product's promise is "you stay in control," not "we pick perfectly."

### 3.5 Edit
For each approved clip, in parallel: ffmpeg cuts the range, auto-editor removes silence and dead space, ffmpeg applies a noise reducer (`afftdn`) and EBU R128 loudness normalization (`loudnorm` to -16 LUFS).

### 3.6 Reframe
- **TRACK mode** (one speaker, or two-speaker / two-camera): MediaPipe emits per-frame face centroids; an EMA smooths the trajectory; ffmpeg crops 9:16 around the smoothed centroid. Falls back to a center crop when face confidence drops.
- **GENERAL mode** (two speakers, single camera): blurred-background scale + center 9:16 overlay. We accept this as a v1 limitation. Active-speaker detection is a community-contribution invitation, not a v1 promise.

In both modes, captions burn in via ffmpeg's `ass=` filter using styles from `brand_config`.

### 3.7 Finalize
Pulls a thumbnail at the clip midpoint. A second Claude Haiku pass produces the final caption (IG and LinkedIn variants) plus 5–8 hashtags, given the clip's transcript range and title. Status flips to `ready`.

### 3.8 Distribute (manual, by design)
The user downloads files from the dashboard and posts to platforms by hand. Auto-publish is **explicitly out of scope forever** — not v2, not v3. Reasons in section 4.

---

## 4. Scope: what PROJECT_NAME does NOT do

These are conscious omissions. Each has a specific reason.

| Non-goal | Why omitted |
|---|---|
| Auto-publish to IG / LinkedIn / TikTok | Each platform requires per-app review (2–4 weeks each), per-user OAuth, and brittle webhook handling. Out of scope forever; manual download is fine for a self-hosted tool |
| GPU acceleration as default | We have users who don't have GPUs. CPU-only is the contract. GPU support can be added by users via env flag in faster-whisper / MediaPipe; never required |
| Voice cloning / dubbing | Descript Overdub territory; entirely different problem with entirely different ethics. Out of scope forever |
| Multi-track audio editing / DAW workflow | Descript-as-DAW; out of scope. We cut, we don't edit |
| Studio-Sound-style 1-click mastering | A v2 candidate using RNNoise + better loudnorm, but v1 ships the simple chain |
| Active-speaker detection in GENERAL mode | Reliable CPU-only active-speaker requires a heavier model; deferred to a community contribution |
| Music bed / B-roll / motion graphics / animated text | Users can layer these in a real editor after export if needed |
| Designed thumbnails with text overlay | v1 thumbnail is a midpoint frame; designed cards out of scope |
| Multi-tenant on a single deployment | Single-user-per-install. If two people want it, run two installs |
| Hosted tier | Explicitly never. The point of this project is that you run it yourself |
| Browser extension / mobile app | Web dashboard only; if you want mobile, port-forward your dashboard at your own risk |
| Telemetry / analytics / phone-home | Zero. The tool calls Anthropic for inference; nothing else leaves your box |
| Source upload via cloud storage URLs | Local files only at v1; users who need this can mount a cloud volume themselves |

---

## 5. Constraints (the world PROJECT_NAME lives in)

### 5.1 Hardware
- **Target:** a 2022-or-newer laptop. 4+ CPU cores, 8 GB RAM, no GPU required, 10 GB free disk.
- **Verified-good:** Apple M2 (8 GB), Ryzen 5 5600 (16 GB), Intel i7-12700H (16 GB).
- **Best-effort:** older x86 quad-cores; expect 1.5×–2× longer wall-clock.
- **Below floor:** 2-core CPUs and ARM SBCs. Documented as unsupported.

### 5.2 Software conventions
- **Docker Compose** is the only supported install. No `npm install`, no `pip install`, no system packages. The user never touches a Python venv or an ffmpeg version.
- **No Kubernetes manifest, no Helm chart at v1.** Compose is the install bar; orchestration is the user's call.
- **No PaaS-specific tooling.** Runs on any box that runs Docker.
- **arm64 and amd64** images both shipped from day one. Apple Silicon is a first-class target.

### 5.3 Operational
- The worker container runs at `nice 19` and `ionice idle` so it doesn't starve other services on shared boxes.
- All user data — uploads, transcripts, clips, thumbnails — lives under a single named Docker volume the user can back up with `docker run --rm -v ... tar`.
- Anthropic is the only outbound network call. Documented prominently.

### 5.4 Cost
- **To the user:** $0 to install, $0 to host (their own box), variable cost is their own Anthropic tokens (~$0.05–0.10 per source video).
- **To the maintainer (you):** $0 to run (you're not running anything). Nominal cost is your time on the repo.
- **No paid SaaS dependency.** No GPU rental. No third-party AI provider beyond Anthropic.

---

## 6. Architecture (component view)

```
┌─────────────────────────────────────────────────────────────┐
│                     User's Browser                          │
│              (http://localhost:3000)                        │
└──────────────────────────┬──────────────────────────────────┘
                           │ JSON API + HTMX
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
                │  postgres            │
                │  - app data          │
                │  - pg-boss queues    │
                │  - encrypted secrets │
                └──────────┬───────────┘
                           │ claim
                           ▼
            ┌────────────────────────────────────┐
            │  worker                            │
            │  Node + Python venv (in-container) │
            │  niced 19, ionice idle             │
            │  - shells out to:                  │
            │    ffmpeg, faster-whisper-cli,     │
            │    auto-editor, mediapipe.py       │
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

Three services, one queue, one volume, one Postgres database. That is the entire system surface area.

### 6.1 Why three services, not one
The app process serves dashboard requests and must stay responsive. The worker spawns ffmpeg and faster-whisper, which use 100% of multiple cores for tens of seconds at a time. Putting both in one container means a busy ffmpeg run blocks dashboard responses. Splitting them isolates the pain. Postgres is its own service for the same reason it's always been: it's a database.

### 6.2 Why pg-boss, not Redis or RabbitMQ
pg-boss is a Postgres-backed job queue. It uses `SELECT … FOR UPDATE SKIP LOCKED` for exactly-once delivery, supports retries with exponential backoff, dead-letter routing, scheduled jobs, and per-queue concurrency limits. The user already has Postgres for app data. Adding Redis for queueing means another service in `docker-compose.yml`, another container to monitor, another failure mode to document, another binary to keep up to date. pg-boss handles our scale (one user, low job throughput) without that cost. Self-hosters thank you for not adding services they don't understand.

### 6.3 Why local volume, not S3 / MinIO by default
Local disk requires zero configuration. MinIO requires a credentials setup, a bucket policy, and a mental model. v1's default is "your files are in a Docker volume, back it up like any other Docker volume." MinIO is supported as an opt-in service (uncomment it in `docker-compose.yml`), but the default install has zero cloud surface area.

### 6.4 Why Claude Haiku, not GPT-4o or Gemini Flash or local Llama
Three reasons. First, Claude Haiku produces the highest-quality short JSON outputs at this price point in independent tests; clip selection is exactly that workload. Second, BYO API key for Anthropic is unambiguously sanctioned (and post-OpenClaw-ban in April 2026, direct BYO key is the **only** sanctioned path for third-party apps using a user's account). Third, picking one provider keeps the code simple and the docs short. A `LLM_PROVIDER` env var that lets advanced users swap in OpenAI or a local Ollama endpoint is a reasonable v0.2 addition; v1 ships Claude.

### 6.5 Why Express + HTMX, not Next.js or a separate React app
HTMX renders server-side, doesn't need a build step, and fits in the same container as the API. A separate React frontend means a Node build pipeline, a separate dev workflow, and either a second container or a more complex single container. The dashboard has six screens; HTMX is enough.

### 6.6 Why MIT, not Apache 2.0 or AGPL
MIT is the simplest license that is broadly compatible with everything in the stack. ffmpeg defaults to LGPL v2.1 and is incompatible with Apache 2.0 unless you compile with `--enable-version3` to upgrade to LGPL v3. MIT sidesteps the issue. AGPL would discourage commercial forks but also discourage adoption — and adoption is the whole point of an OSS labor-of-love project. ClipsAI, OpenShorts, and AI-Youtube-Shorts-Generator are all MIT; we follow the local convention.

---

## 7. The pipeline (in detail)

The pipeline is eight stages. The first three run on the source. The fourth is the human gate. The last four run per approved clip, in parallel.

### Stage 1 — Ingest (synchronous, in app process)
- User drops a file in the upload zone.
- Browser POSTs the file to `/api/jobs` (multipart, streams to disk).
- App registers the source in `assets`, links it to the job, and enqueues `transcribe`.

### Stage 2 — Transcribe (worker, queue: `transcribe`)
- Worker reads the source from `/data/uploads/{jobId}.mp4`.
- ffmpeg extracts mono 16 kHz WAV.
- faster-whisper int8 runs on all available cores; expected runtime 2–4× realtime on target hardware (a 10-minute source = 2.5–5 minutes).
- Output SRT writes to `/data/captions/{jobId}/full.srt` and registers as an asset.
- Job status flips to `segmenting`; enqueues `segment`.

### Stage 3 — Segment (worker, queue: `segment`)
- Worker parses the SRT into numbered cues.
- Rule-based pre-filter generates ~12 candidate ranges (caption density, speaker change, hook-word detection, 15–90s window).
- Worker builds a Claude Haiku prompt: brand context, target clip count, candidate ranges with their transcripts. System prompt is cached.
- Claude returns JSON: `{clips: [{startCueId, endCueId, reason, title, draftCaption}]}`.
- Worker validates, converts cue IDs to milliseconds, inserts `clips` rows with `approved=false`.
- Job status flips to `awaiting_approval`. **Worker stops. Wait for human.**

### Stage 4 — Approve (human gate, app process)
- User opens the job in the dashboard, sees proposed clips with timestamps, transcript ranges, and Claude's reasons.
- User ticks the keepers, hits Approve.
- App marks chosen clips `approved=true`, deletes the rest, and enqueues an `edit` job per approved clip.

### Stage 5 — Edit (worker, queue: `edit`, per clip)
- ffmpeg cuts the source to the clip's start/end range.
- auto-editor removes silences and dead space inside that range.
- ffmpeg audio chain: `afftdn` (denoise) then `loudnorm I=-16 LRA=11 TP=-1.5` (EBU R128).
- Output writes to `/data/edited/{jobId}/{clipIndex}.mp4`.
- Enqueues `reframe`.

### Stage 6 — Reframe (worker, queue: `reframe`, per clip)
- Mode selection from `speakerCount` and `cameraCount`:
  - 1 speaker → TRACK
  - 2 speakers, 2 cameras → TRACK (each cut is a single speaker)
  - 2 speakers, 1 camera → GENERAL
- TRACK: `mediapipe.py` emits a per-frame face centroid CSV; an EMA smooths the trajectory; ffmpeg `crop=ih*9/16:ih:x_expr:0` follows the smoothed x. If face confidence drops below 0.4 for over 0.8 s, fall back to a center crop.
- GENERAL: blurred 9:16 background, scaled 16:9 foreground centered.
- Captions burn via `ffmpeg -vf "ass=captions.ass"`, generated from the clip's SRT sub-range using styles from `brand_config`.
- Output: 1080×1920 H.264 medium / AAC 192 k → `/data/clips/{jobId}/{clipIndex}.mp4`.
- Enqueues `finalize`.

### Stage 7 — Finalize (worker, queue: `finalize`, per clip)
- ffmpeg pulls a thumbnail at the clip midpoint → `/data/thumbs/{jobId}/{clipIndex}.jpg`.
- Claude Haiku second pass gets the clip's transcript range and title; returns final caption (IG and LinkedIn variants) and 5–8 hashtags.
- Updates `clips`.
- When all approved clips for a job reach `finalize` complete, job status flips to `ready`.

### Stage 8 — Download (manual, app process)
- User clicks "Download MP4" / "Copy caption" / "Copy hashtags" on each ready clip.
- App serves the MP4 directly from the volume.
- User posts manually to whatever platform they want.

### Failure handling, in every stage
- pg-boss retries with exponential backoff, three attempts on most queues.
- After exhausting retries, the job routes to a `dlq` queue, which surfaces a dashboard banner and writes to logs.
- A reconciler runs every 10 minutes and re-enqueues any job whose `updated_at` has been frozen for more than 15 minutes mid-stage.
- Failures write `jobs.last_error` and `executions.error_message` for forensic reads.

---

## 8. Data model (in plain English)

Eight tables, no prefix needed (this is the only app in its database).

### users
Single-user-per-install in v1, but the table exists and is indexed because (a) the schema cost is trivial and (b) users want a real password they can change. Stores admin email (optional), bcrypt password hash, created-at.

### user_secrets
Encrypted Anthropic API key (and any future BYO keys). One row per user. Key column is `bytea` and stores AES-256-GCM ciphertext; the master key comes from `ENCRYPTION_KEY` in the env. The API key is decrypted in worker memory only at the moment of an API call and never written to logs.

### jobs
One row per source video that has entered the system. Tracks the finite-state-machine status (`queued`, `transcribing`, `segmenting`, `awaiting_approval`, `editing`, `reframing`, `ready`, `failed`, `cancelled`), attempt count, last error, arbitrary metadata.

### assets
Every file owned by the system — sources, edited clips, final clips, SRT captions, thumbnails. Each row points to a path under `/data`, has a `kind` discriminator, a `pinned` flag (so cleanup never sweeps important sources), and a `last_used_at` updated whenever the dashboard serves the file.

### clips
One row per output clip. Links back to a job, holds start / end milliseconds, mode (TRACK / GENERAL), MP4 / SRT / thumbnail asset references, approval state, draft caption, draft title, hashtags.

### executions
A stage audit log. Captures stage start, completion, duration, status, result JSON, error message. Used for forensics and for the worker's reconciler.

### brand_config
Single-row table with caption font, size, color, outline, vertical position percent, and references to optional intro / outro / logo assets.

### sessions
Standard server-side session storage for the dashboard.

RLS is **enabled** even in single-user mode. Cost is small, discipline is cheaper than a retrofit later, and it documents the security boundary.

---

## 9. The first-run UX (the install moment)

The first thirty minutes a stranger spends with the project decide whether they keep it. The first-run flow is the most-tested path in the codebase.

### Step 0 — `docker compose up`
The user has cloned the repo, copied `.env.example` to `.env`, and edited two values: `ENCRYPTION_KEY` (a random 32-byte hex string they generate from a printed `openssl` one-liner) and `POSTGRES_PASSWORD`. Compose pulls images, runs migrations, and starts services.

### Step 1 — Browser to `http://localhost:3000`
Unauthenticated users land on `/setup`.

### Step 2 — Create admin account
A single form: password (twice). Email optional. No verification dance.

### Step 3 — Paste Anthropic key
A field labeled "Anthropic API key," a small "where do I get this?" link to `console.anthropic.com`, and a "Test connection" button. The button makes a real Claude call (`Hello, world.`) and shows either the response or the error verbatim. Save is disabled until the test passes.

### Step 4 — Done
Redirect to the empty jobs list with a single "Upload your first video" button.

### The dashboard, after setup

**Screen 1 — Jobs list.** A table of jobs ordered by `updated_at DESC`. Columns: title, created at, status, progress (e.g. "3/5 clips ready"), action ("Open"). A status filter at the top.

**Screen 2 — Upload.** A single form: title, speaker count (1 or 2), camera count (1 or 2), a drag-drop zone with a progress bar. When the upload completes, the job appears in screen 1 with status `queued`.

**Screen 3 — Job detail (the approval gate).** Shown when status is `awaiting_approval`. The transcript renders as a paragraph with proposed clips highlighted in colored bands. Each band shows start–end timestamp, Claude-generated reason, draft title, and a checkbox. A floating "Approve N selected" button at the bottom commits the choices.

**Screen 4 — Job detail (post-approval).** Shows progress per clip: edit ✓, reframe ✓, finalize ◌ (spinner). Polls every two seconds via HTMX.

**Screen 5 — Ready clips.** Each ready clip is a card: thumbnail, vertical preview player, final caption, hashtags, "Download MP4" / "Copy caption" / "Copy hashtags" buttons.

**Screen 6 — Settings.** Brand config form, Anthropic key replacement (with the same test-connection flow), data-volume usage display, "delete all data" button with a typed-confirmation modal.

---

## 10. Operational characteristics

### 10.1 Performance budget (CPU-only, target hardware)
- 10-min source → 5 ready clips: end-to-end target ≤ 25 minutes wall-clock on M2 MacBook Air (8 GB) or Ryzen 5 5600 (16 GB).
- Of those 25 minutes: ~3 min transcribe, ~10 s segment (Claude), human gate (variable), ~30 s per clip edit, ~45 s per clip reframe, ~5 s per clip finalize, ~2 min per clip ffmpeg encode (the actual bottleneck).
- User attention time: under 5 minutes per source video.

These numbers are honest. The TPC-internal predecessor of this project promised 12 minutes; that was based on a specific server, not consumer hardware. We promise 25 minutes here and beat it where we can.

### 10.2 Resource budget
- app container: < 200 MB RAM, < 5% CPU steady state.
- worker container: bounded to 4 GB RAM, `nice 19` / `ionice idle` so other things on the user's machine have priority. ffmpeg and faster-whisper run as children and inherit niceness.
- postgres container: < 500 MB RAM at our scale.
- Disk: 30-day default TTL on raw sources (configurable), indefinite on final clips / thumbs / SRT.

### 10.3 Reliability
- Anthropic calls wrapped with retry + jittered backoff.
- All long-running work goes through pg-boss; container restarts pick up where they left off.
- Reconciler every 10 minutes catches stuck jobs.
- Container `restart: unless-stopped` policy in compose handles crashes.

### 10.4 Security
- **Anthropic API key:** AES-256-GCM ciphertext in `user_secrets`, master key in `ENCRYPTION_KEY` env var. Never logged. Decrypted only into worker process memory at the moment of an API call. Never sent to any host other than `api.anthropic.com`.
- **Admin password:** bcrypt with cost 12.
- **No external auth surface in v1.** The dashboard binds to `localhost` by default. Users who expose it on a LAN do so behind their own reverse proxy and at their own risk; documented prominently.
- **Outbound network:** the only egress is to `api.anthropic.com`. Telemetry is zero.
- **Inbound webhooks:** none in v1. (No platform integrations means no webhook surface.)

### 10.5 Observability
- pino logs, JSON-structured, written to stdout (the Docker convention).
- Per-stage timings in `executions` for forensic reads.
- A `/metrics` endpoint exposes Prometheus-format counters for users who want to wire it up; not required.

---

## 11. Cost model

| Cost line | v1 | Notes |
|---|---|---|
| Hosting | $0 | User's own machine |
| Storage | $0 | Local Docker volume |
| Database | $0 | Postgres container |
| AI tokens | ~$0.05–0.10 per source video | Claude Haiku, BYO key, two short calls per source plus per-clip caption pass |
| GPU | $0 | None |
| SaaS | $0 | No third-party services |
| Maintainer cost | $0 | The project doesn't run servers |
| **Total per source** | **~$0.05–0.10** | All on the user's Anthropic bill |

For comparison: Opus Clip Pro is $19/month, Vizard Pro is $30/month, Submagic is $16/month, Descript Creator is $24/month. PROJECT_NAME pays for itself against any of them in a couple of weeks even at heavy use.

---

## 12. Phased rollout

A single developer ships public v0.1 in roughly twelve working days. This is double the TPC-internal estimate — the difference is Docker hardening, docs, first-run UX polish, license review, multi-arch builds, and the testing surface that comes with shipping to strangers instead of one team.

| Phase | Duration | Output |
|---|---|---|
| 0 — Repo setup | 1 day | License, README skeleton, `docker-compose.yml`, base Dockerfiles, CI for arm64 + amd64 builds |
| 1 — Skeleton | 1 day | Schema applied, pg-boss bootstrapped, `POST /api/jobs` end-to-end, all three containers running |
| 2 — Transcribe + segment | 2 days | One-minute talking head → transcript → 2 ranked candidate segments via Claude |
| 3 — Approve + edit + reframe | 3 days | Approval UI, edit stage, reframe with TRACK + caption burn-in |
| 4 — Finalize + dashboard polish | 2 days | Thumbnails, final captions, ready-clips screen, brand-config form, cleanup job |
| 5 — First-run wizard + key encryption | 1 day | Setup wizard, AES-256-GCM key storage, "test connection" flow |
| 6 — Docs + screenshots | 1 day | README, architecture doc, troubleshooting, demo GIF |
| 7 — End-to-end test + harden | 1 day | Three real source videos through every stage on M2 + x86; fix what breaks |

**Total: ~12 working days for public v0.1.**

v0.2 (community contributions, telemetry-opt-in, alternate LLM providers, Studio-Sound-style mastering) is open-ended and depends on what users actually ask for.

---

## 13. Success criteria

PROJECT_NAME is successful when, measured across the first 90 days of public availability:

1. **Time-to-first-clip** for a new user is under 30 minutes from `git clone` to a downloaded MP4 they're proud of, on M2 MacBook Air or Ryzen 5 5600.
2. **End-to-end pipeline reliability** ≥ 95% on talking-head content (the dominant use case).
3. **Designer-veto rate on Haiku-ranked clips** ≤ 50% on the same content.
4. **Zero-leak guarantee for Anthropic API keys** — encrypted at rest, never logged, audited by an external reader (`security.md` documents the audit invitation).
5. **Cost stays at user's Anthropic bill only** — no hidden runtime fees, no maintainer-side hosting.
6. **GitHub adoption** — 1k stars within 6 months is a healthy baseline; not the goal, but a useful signal.

If any of these miss, we revisit honestly. The most likely failure mode is criterion #3 missing because Haiku's clip-selection quality on certain content types (panel discussions, technical explainers) is below user expectations. Mitigation, in order: prompt iteration, better pre-filter heuristics, then optional alternate-provider support in v0.2 (Claude Opus, GPT-4o, Gemini Pro Vision).

---

## 14. Risks and mitigations

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Haiku clip quality lags Opus Clip / Vizard | Medium | Medium | Hybrid pre-filter + ranking; approval gate as feature; v0.2 alternate-provider escape hatch |
| ffmpeg encoding times disappoint on older hardware | Medium | Low | Documented hardware floor; user can swap to `superfast` preset via env; graceful "this will take a while" estimates in UI |
| MediaPipe face track fails on unusual framing | Low | Medium | Confidence threshold + center-crop fallback; community-contribution invite for active-speaker detection |
| Disk fills | Low | Medium | TTL cleanup + `pinned` flag + dashboard disk-use widget |
| BYO-key UX friction (users can't get a key, get confused by Anthropic console) | Medium | Medium | "Where do I get this?" link, copy-paste-ready instructions, test-connection button before save |
| Privacy concerns (users worry about uploading sensitive content) | Medium | Medium | Documented: only the transcript leaves the box, only to Anthropic, only when you click. Show estimated tokens before every Claude call |
| Sustainability / maintainer burnout | High | High | Scope deliberately narrow. No hosted tier. Accept "labor of love" status. Document this expectation in CONTRIBUTING.md |
| Active OSS competitors (ClipsAI, ClippedAI, OpenShorts) | High | Medium | Differentiate on: BYO Claude (not OpenAI), human-gate-as-feature, install simplicity, MIT, polish |
| H.264 patent concerns | Low | Low | ffmpeg LGPL build is the standard. End user runs on their own box. No commercial distribution by us. Documented |
| Maintenance drift (ffmpeg / whisper / mediapipe versions break) | Medium | Medium | Lock-file every dependency; CI runs an end-to-end smoke test on every PR; pin Docker base images |
| Anthropic changes the API or BYO-key terms | Low | High | Provider abstraction in code (one interface, swappable) so a Gemini or OpenAI fallback is a small PR away |
| Encryption key rotation never gets implemented | Medium | Low | v1 documents that rotating `ENCRYPTION_KEY` requires a re-encrypt step; v0.2 provides a CLI for it |

---

## 15. Open questions to resolve before kickoff

1. **Project name.** Currently `PROJECT_NAME` throughout. Settle this before the first public commit.
2. **Telemetry.** Default in v1: zero. Open question: do we add an opt-in anonymous "this many sources processed" ping in v0.2 to inform development priorities? Default answer: probably not, but worth a community discussion.
3. **Frontend technology.** HTMX in v1. If a contributor strongly prefers React and is willing to maintain it, the door is open in v0.2.
4. **Day-1 arm64 support.** Yes — Apple Silicon is too common to make second-class. CI builds both architectures from day one.
5. **Caption styling.** Ship 3 default styles in v1 (clean, bold, minimal). Accept community PRs for more.
6. **Alternate LLM providers in v0.2.** Open in principle; the priority depends on who shows up to maintain it.
7. **30-minute hard cap.** Reasonable for v1. A `MAX_SOURCE_MINUTES` env var lets advanced users lift it at their own risk.

---

## 16. Why PROJECT_NAME exists alongside the alternatives

These are the existing options and why PROJECT_NAME has a reason to exist anyway.

### vs. Opus Clip / Vizard / Submagic / Klap (SaaS)
The SaaS tier is convenient and produces decent clips. It also requires uploading raw footage to someone else's servers, paying $16–$30/month, and accepting whatever the model picks. PROJECT_NAME is for users who want their footage to stay on their machine, who want to pay only for the inference they use, and who want the human gate to be a feature rather than a "review screen" to skip.

### vs. Descript (SaaS)
Descript is a much larger product — voice cloning, multi-track DAW, regret-free undo, transcript-as-edit. PROJECT_NAME does none of that and isn't trying to. We cut, we caption, we ship. If you need voice cloning, Descript is the right tool.

### vs. ClipsAI (OSS library)
ClipsAI is a Python library, not a product. It expects you to bring your own UI, queue, storage, and deployment. PROJECT_NAME is the product; ClipsAI's primitives are roughly what's inside our worker. Different layer of the stack.

### vs. ClippedAI (OSS Opus alternative)
Closest direct comparison. ClippedAI is GPT-only, smaller scope, less polish on the human-review side. PROJECT_NAME differentiates on Claude support, hybrid pre-filter ranking, and an opinionated install path.

### vs. mutonby/openshorts (OSS)
OpenShorts is broader — closer to a YouTube-Studio replacement than a clip maker. PROJECT_NAME is narrower and CPU-first by contract. Different product surface even though some primitives overlap.

### vs. AI-Youtube-Shorts-Generator (OSS)
Older project, Python-script-shaped, no first-run UX, no LLM-driven selection. PROJECT_NAME has a higher polish floor.

### vs. running ffmpeg + whisper yourself
That's a viable path for anyone with the patience. PROJECT_NAME is the version with the human gate, the captions, the brand config, the dashboard, and the queue.

The differentiation, in one line: **BYO Claude, human-gate-as-feature, single `docker compose up`, MIT.**

---

## 17. Glossary (for non-engineers)

- **Source video** — the raw long-form recording you upload.
- **Clip** — a short, vertical, captioned MP4 produced from the source.
- **Segment** — a proposed start / end range inside a transcript, before you approve it.
- **Transcript / SRT** — text of the spoken words plus timestamps.
- **TRACK mode** — face-following crop. Used when there is a single speaker, or two speakers each on their own camera.
- **GENERAL mode** — center crop with blurred background. Used when two speakers share one camera and we can't reliably tell which is talking.
- **Reframe** — converting a 16:9 horizontal video into a 9:16 vertical video.
- **Burn-in caption** — captions baked into the video pixels, vs. a separate subtitle track. Burn-in is required for IG Reels.
- **EBU R128 / loudnorm** — a broadcast loudness standard that normalizes perceived volume across clips.
- **BYO key** — Bring Your Own (API) Key. You paste your own Anthropic key into the tool; calls go on your bill, not anyone else's.
- **Envelope encryption** — the encryption scheme used for your API key. Your key is encrypted with a per-install master key; the master key lives in your `.env` file; together they keep your API key safe at rest.
- **pg-boss** — a job queue that lives inside Postgres. We use it instead of Redis.
- **ffmpeg / faster-whisper / auto-editor / MediaPipe** — open-source command-line tools doing the actual video, audio, and ML work.
- **Claude Haiku** — Anthropic's fast/cheap model; we use it for the language-model passes (segment ranking, caption copy).

---

## 18. Document positioning

There are three documents in this project. Read them in order:

1. **`PROJECT_MANIFESTO.md`** — the original TPC-internal version of this project. Kept for historical context. The architectural ideas survived; the constraints didn't. Read as ancestor, not as truth.
2. **`PROJECT_MANIFESTO_OSS.md`** (this document) — the verifiable scope of the open-source project. A user, a contributor, or a stakeholder should be able to read this and either say "yes, this is what I want to use / contribute to" or "no, change X." Nothing here is a build instruction.
3. **`IMPLEMENTATION_PLAN_OSS.md`** (to be written) — the build spec. SQL, file paths, Docker layers, package versions, phased to-do lists. The engineer building PROJECT_NAME works from this.

If the manifesto and the plan ever diverge, **the manifesto is the truth** and the plan gets fixed.

---

*PROJECT_NAME — manifesto v1.0 (OSS), 2026-04-27. Forked from the TPC-internal `PROJECT_MANIFESTO.md` v1.0.*
