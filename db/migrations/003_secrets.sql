CREATE TABLE user_secrets (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- AES-256-GCM blob: 12-byte IV || ciphertext || 16-byte GCM tag
  anthropic_key  BYTEA NOT NULL,
  key_version    INT  NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
