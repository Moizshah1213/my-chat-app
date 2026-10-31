-- 0008_ai.sql
CREATE TABLE IF NOT EXISTS ai_settings (
  workspace_id      uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  mode              text NOT NULL DEFAULT 'off' CHECK (mode IN ('off','suggest','auto')),
  provider          text NOT NULL DEFAULT 'openai_compatible',
  base_url          text,
  model             text,
  api_key_enc       text,
  api_key_last4     text,
  instructions      jsonb NOT NULL DEFAULT '{}',
  temperature       numeric(3,2) NOT NULL DEFAULT 0.3 CHECK (temperature BETWEEN 0 AND 1),
  max_output_tokens int NOT NULL DEFAULT 400 CHECK (max_output_tokens BETWEEN 50 AND 2000),
  monthly_token_cap int NOT NULL DEFAULT 200000,
  updated_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid,
  prompt_tokens int,
  completion_tokens int,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai_settings;
CREATE POLICY tenant_isolation ON ai_settings
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai_usage;
CREATE POLICY tenant_isolation ON ai_usage
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON ai_settings TO app_user;
GRANT SELECT, INSERT ON ai_usage TO app_user;
GRANT USAGE, SELECT ON SEQUENCE ai_usage_id_seq TO app_user;
