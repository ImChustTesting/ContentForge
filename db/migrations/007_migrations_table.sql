-- Bookkeeping table for the migration runner. Created last so the runner can
-- safely write to it without bootstrapping logic in code.
CREATE TABLE IF NOT EXISTS migrations (
  filename   TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
