-- Keep the monthly AI rollup usable for both fresh and pre-0010 databases.
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS month TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS prompt_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS completion_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS total_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE ai_usage ALTER COLUMN status SET DEFAULT 'success';

CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_ws_month_unique
  ON ai_usage(workspace_id, month);

GRANT SELECT, INSERT, UPDATE ON ai_usage TO app_user;
