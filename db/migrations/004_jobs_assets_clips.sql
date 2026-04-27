CREATE TYPE job_status AS ENUM (
  'queued',
  'transcribing',
  'segmenting',
  'awaiting_approval',
  'editing',
  'reframing',
  'finalizing',
  'ready',
  'failed',
  'cancelled'
);

CREATE TYPE clip_mode AS ENUM ('TRACK', 'GENERAL');

CREATE TABLE jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  status        job_status NOT NULL DEFAULT 'queued',
  speaker_count SMALLINT NOT NULL CHECK (speaker_count IN (1, 2)),
  camera_count  SMALLINT NOT NULL CHECK (camera_count IN (1, 2)),
  attempts      INT NOT NULL DEFAULT 0,
  last_error    TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX jobs_user_status_idx ON jobs (user_id, status);
CREATE INDEX jobs_updated_at_idx  ON jobs (updated_at DESC);

CREATE TABLE assets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID REFERENCES jobs(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,            -- 'source' | 'edited' | 'clip' | 'srt' | 'thumb' | 'cues'
  path          TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL DEFAULT 0,
  pinned        BOOLEAN NOT NULL DEFAULT FALSE,
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX assets_job_kind_idx ON assets (job_id, kind);

CREATE TABLE clips (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  clip_index        INT NOT NULL,
  start_ms          INT NOT NULL,
  end_ms            INT NOT NULL,
  mode              clip_mode NOT NULL,
  approved          BOOLEAN NOT NULL DEFAULT FALSE,
  draft_title       TEXT,
  draft_caption     TEXT,
  reason            TEXT,
  final_caption_ig  TEXT,
  final_caption_li  TEXT,
  hashtags          TEXT[],
  mp4_asset_id      UUID REFERENCES assets(id),
  thumb_asset_id    UUID REFERENCES assets(id),
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending|editing|reframing|finalizing|ready|failed
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, clip_index)
);

CREATE INDEX clips_job_idx ON clips (job_id);

CREATE TABLE executions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  clip_id       UUID REFERENCES clips(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL,
  status        TEXT NOT NULL,                -- 'started' | 'ok' | 'error'
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  duration_ms   INT,
  error_message TEXT,
  result        JSONB
);

CREATE INDEX executions_job_idx       ON executions (job_id, started_at);
CREATE INDEX executions_stage_idx     ON executions (stage, started_at);
