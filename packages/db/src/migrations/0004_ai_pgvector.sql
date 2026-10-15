-- ============================================================================
-- 0004_ai_pgvector.sql — Phase 7 (AI) dependencies.
-- pgvector is optional at this stage; if the extension is available we create it
-- and the knowledge tables. If not, this migration is a no-op and the AI phase
-- can be enabled later by installing pgvector and re-running migrations.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE IF NOT EXISTS knowledge_sources (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      type        text NOT NULL,           -- file | url
      url         text,
      title       text,
      status      text NOT NULL DEFAULT 'pending',
      created_at  timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      source_id   uuid REFERENCES knowledge_sources(id) ON DELETE CASCADE,
      content     text NOT NULL,
      embedding   vector(1536)
    );
    CREATE INDEX IF NOT EXISTS knowledge_chunks_ws_idx ON knowledge_chunks(workspace_id);

    -- RLS for the AI tables (same tenant_isolation policy pattern).
    ALTER TABLE knowledge_sources ENABLE ROW LEVEL SECURITY;
    ALTER TABLE knowledge_sources FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation ON knowledge_sources;
    CREATE POLICY tenant_isolation ON knowledge_sources
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

    ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
    ALTER TABLE knowledge_chunks FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation ON knowledge_chunks;
    CREATE POLICY tenant_isolation ON knowledge_chunks
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

    GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_sources TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_chunks TO app_user;

    RAISE NOTICE 'pgvector: AI tables created';
  ELSE
    RAISE NOTICE 'pgvector not available; skipping AI tables (Phase 7)';
  END IF;
END $$;
