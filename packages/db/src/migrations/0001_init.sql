-- ============================================================================
-- 0001_init.sql — Global tables, auth support, and required extensions.
-- Run as the migration owner role (app_migrator), which OWNS the schema.
-- The runtime role (app_user) is created by infra/bootstrap.ts with least
-- privilege and NOBYPASSRLS.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email
-- NOTE: pgvector (extension "vector") is created in 0004_ai.sql, guarded so the
-- core schema applies even where pgvector is not installed (Phase 7 dependency).

-- Global: users -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext NOT NULL UNIQUE,
  password_hash     text NOT NULL,
  email_verified_at timestamptz,
  totp_secret_enc   text,
  totp_enabled      boolean NOT NULL DEFAULT false,
  recovery_codes_hash text,
  name              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_login_at     timestamptz,
  failed_logins     integer NOT NULL DEFAULT 0,
  locked_until      timestamptz
);

-- Global: workspaces --------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        varchar(63) NOT NULL UNIQUE,
  plan        text NOT NULL DEFAULT 'free',
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

-- Auth support: refresh tokens (rotation + reuse detection) ----------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  family_id   uuid NOT NULL,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid,
  ip          text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_hash_idx ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens(user_id);

-- Auth support: email tokens (verify / reset) ------------------------------
CREATE TABLE IF NOT EXISTS email_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS email_tokens_hash_idx ON email_tokens(token_hash);
CREATE INDEX IF NOT EXISTS email_tokens_user_idx ON email_tokens(user_id);
