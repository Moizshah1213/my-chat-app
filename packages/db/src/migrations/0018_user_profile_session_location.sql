ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS pending_email citext;

CREATE UNIQUE INDEX IF NOT EXISTS users_pending_email_idx
  ON users (pending_email);

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS location text;
