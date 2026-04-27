CREATE TABLE brand_config (
  id              SMALLINT PRIMARY KEY DEFAULT 1,
  font_name       TEXT NOT NULL DEFAULT 'DejaVu Sans',
  font_size       INT  NOT NULL DEFAULT 56,
  font_color      TEXT NOT NULL DEFAULT '#FFFFFF',
  outline_color   TEXT NOT NULL DEFAULT '#000000',
  outline_width   INT  NOT NULL DEFAULT 3,
  vertical_pct    INT  NOT NULL DEFAULT 80,    -- caption baseline as % from top
  intro_asset_id  UUID REFERENCES assets(id),
  outro_asset_id  UUID REFERENCES assets(id),
  brand_voice     TEXT,                        -- free-text shown to Claude in segment + caption prompts
  CHECK (id = 1)
);

INSERT INTO brand_config (id) VALUES (1);
