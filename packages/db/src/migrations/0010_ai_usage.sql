-- Phase D: AI token usage rollup (workspace-scoped, scheduled reset)
CREATE TABLE IF NOT EXISTS ai_usage (
    workspace_id       UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    month              TEXT NOT NULL, -- 'YYYY-MM'
    prompt_tokens      BIGINT NOT NULL DEFAULT 0,
    completion_tokens  BIGINT NOT NULL DEFAULT 0,
    total_tokens       BIGINT NOT NULL DEFAULT 0,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add missing columns if table was created by an older migration version
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS month TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS prompt_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS completion_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS total_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ws_read" ON ai_usage;
CREATE POLICY "ws_read" ON ai_usage FOR SELECT USING (workspace_id = current_setting('app.workspace_id')::UUID);

CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_ws_month_unique ON ai_usage(workspace_id, month);
