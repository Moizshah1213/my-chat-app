CREATE TABLE IF NOT EXISTS conversation_read_cursors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_read_cursors_unique
    UNIQUE (workspace_id, conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS conversation_read_cursors_ws_user_idx
  ON conversation_read_cursors (workspace_id, user_id);

INSERT INTO conversation_read_cursors (workspace_id, conversation_id, user_id, last_read_at)
SELECT c.workspace_id, c.id, m.user_id, COALESCE(MAX(msg.created_at), c.created_at)
FROM conversations c
JOIN memberships m ON m.workspace_id = c.workspace_id
LEFT JOIN messages msg
  ON msg.workspace_id = c.workspace_id
  AND msg.conversation_id = c.id
  AND msg.sender_type = 'visitor'
  AND msg.deleted_at IS NULL
WHERE c.deleted_at IS NULL
GROUP BY c.workspace_id, c.id, m.user_id
ON CONFLICT (workspace_id, conversation_id, user_id) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON conversation_read_cursors TO app_user;
ALTER TABLE conversation_read_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_read_cursors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON conversation_read_cursors;
CREATE POLICY tenant_isolation ON conversation_read_cursors
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
