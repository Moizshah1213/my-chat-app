ALTER TABLE widget_settings
  ADD COLUMN IF NOT EXISTS quick_replies jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS prechat_enabled boolean NOT NULL DEFAULT true;
