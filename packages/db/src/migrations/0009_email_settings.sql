-- Phase D: Email provider settings (workspace-scoped)
CREATE TABLE IF NOT EXISTS email_settings (
    workspace_id  UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    provider      TEXT NOT NULL DEFAULT 'smtp',
    host          TEXT,
    port          INTEGER,
    "user"        TEXT,
    password_enc  TEXT,
    from_email    TEXT,
    from_name     TEXT,
    verified_at   TIMESTAMPTZ,
    updated_by    UUID,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS
ALTER TABLE email_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ws_read" ON email_settings;
DROP POLICY IF EXISTS "ws_write" ON email_settings;
DROP POLICY IF EXISTS "ws_update" ON email_settings;
DROP POLICY IF EXISTS "ws_delete" ON email_settings;
CREATE POLICY "ws_read" ON email_settings FOR SELECT USING (workspace_id = current_setting('app.workspace_id')::UUID);
CREATE POLICY "ws_write" ON email_settings FOR INSERT WITH CHECK (workspace_id = current_setting('app.workspace_id')::UUID);
CREATE POLICY "ws_update" ON email_settings FOR UPDATE USING (workspace_id = current_setting('app.workspace_id')::UUID);
CREATE POLICY "ws_delete" ON email_settings FOR DELETE USING (workspace_id = current_setting('app.workspace_id')::UUID);

CREATE INDEX IF NOT EXISTS email_settings_ws_idx ON email_settings(workspace_id);
