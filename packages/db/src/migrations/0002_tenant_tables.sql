-- ============================================================================
-- 0002_tenant_tables.sql — Tenant-scoped tables (workspace_id NOT NULL).
-- RLS policies are applied in 0003_rls.sql so the app_user least-privilege
-- grants and policies live together.
-- ============================================================================

CREATE TABLE IF NOT EXISTS memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  role        text NOT NULL CHECK (role IN ('owner','admin','agent')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS memberships_ws_user_unique ON memberships(workspace_id, user_id);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id);
CREATE INDEX IF NOT EXISTS memberships_ws_idx ON memberships(workspace_id);

CREATE TABLE IF NOT EXISTS invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email       citext NOT NULL,
  role        text NOT NULL CHECK (role IN ('owner','admin','agent')),
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS invitations_hash_idx ON invitations(token_hash);
CREATE INDEX IF NOT EXISTS invitations_ws_idx ON invitations(workspace_id);

CREATE TABLE IF NOT EXISTS widget_settings (
  workspace_id    uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  color           text NOT NULL DEFAULT '#4f46e5',
  logo_url        text,
  position        text NOT NULL DEFAULT 'right',
  greeting        text,
  offline_message text,
  prechat_fields  jsonb NOT NULL DEFAULT '[]',
  working_hours   jsonb NOT NULL DEFAULT '{}',
  ai_enabled      boolean NOT NULL DEFAULT false,
  ai_instructions text,
  allowed_domains text[] NOT NULL DEFAULT '{}',
  language        text NOT NULL DEFAULT 'en'
);

CREATE TABLE IF NOT EXISTS api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name        text NOT NULL,
  public_key  text NOT NULL,
  secret_hash text,
  last_used_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_public_key_unique ON api_keys(public_key);
CREATE INDEX IF NOT EXISTS api_keys_ws_idx ON api_keys(workspace_id);

CREATE TABLE IF NOT EXISTS visitors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  anon_id     text NOT NULL,
  name        text,
  email       citext,
  ip_hash     text,
  country     text,
  user_agent  text,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  meta        jsonb NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS visitors_ws_anon_unique ON visitors(workspace_id, anon_id);
CREATE INDEX IF NOT EXISTS visitors_ws_idx ON visitors(workspace_id);

CREATE TABLE IF NOT EXISTS conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  visitor_id  uuid REFERENCES visitors(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'open',
  assigned_to uuid,
  subject     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,
  last_message_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_ws_status_last_idx
  ON conversations(workspace_id, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS conversations_ws_idx ON conversations(workspace_id);

CREATE TABLE IF NOT EXISTS messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_type text NOT NULL,
  sender_id   uuid,
  body        text NOT NULL,
  body_type   text NOT NULL DEFAULT 'text',
  created_at  timestamptz NOT NULL DEFAULT now(),
  edited_at   timestamptz,
  deleted_at  timestamptz,
  idempotency_key text
);
CREATE INDEX IF NOT EXISTS messages_ws_conv_created_idx
  ON messages(workspace_id, conversation_id, created_at);
CREATE INDEX IF NOT EXISTS messages_ws_idx ON messages(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS messages_ws_idem_unique
  ON messages(workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit_logs (
  id          bigserial PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id    uuid,
  action      text NOT NULL,
  target      text,
  ip          text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  meta        jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_logs_ws_idx ON audit_logs(workspace_id);
