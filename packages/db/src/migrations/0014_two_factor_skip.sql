ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS two_factor_skipped boolean NOT NULL DEFAULT false;
