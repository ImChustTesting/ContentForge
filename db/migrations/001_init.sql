-- ContentForge initial migration.
-- pgcrypto for gen_random_uuid().
-- pg-boss creates its own schema on first .start(); we don't manage it here.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
