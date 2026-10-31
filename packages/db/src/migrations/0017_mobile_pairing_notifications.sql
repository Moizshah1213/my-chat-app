CREATE TABLE IF NOT EXISTS qr_login_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_hash text NOT NULL UNIQUE,
  poll_token_hash text NOT NULL,
  origin text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'consumed')),
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  role text,
  two_factor_skipped boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS qr_login_challenges_expiry_idx
  ON qr_login_challenges (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON qr_login_challenges TO app_user;

CREATE TABLE IF NOT EXISTS mobile_push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mobile_push_tokens_workspace_user_idx
  ON mobile_push_tokens (workspace_id, user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON mobile_push_tokens TO app_user;
ALTER TABLE mobile_push_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_push_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mobile_push_tokens;
CREATE POLICY tenant_isolation ON mobile_push_tokens
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
