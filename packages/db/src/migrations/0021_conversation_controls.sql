ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE TABLE IF NOT EXISTS conversation_notification_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  paused boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_notification_preferences_unique
    UNIQUE (workspace_id, conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS conversation_notification_preferences_ws_user_idx
  ON conversation_notification_preferences (workspace_id, user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON conversation_notification_preferences TO app_user;
ALTER TABLE conversation_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_notification_preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON conversation_notification_preferences;
CREATE POLICY tenant_isolation ON conversation_notification_preferences
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
