-- ============================================================================
-- 0003_rls.sql — Row Level Security: the final safety net for tenant isolation.
--
-- Model (blueprint §5):
--   - The app connects as app_user (NOBYPASSRLS, non-superuser, does not own tables).
--   - Each request opens a transaction and runs:
--         SELECT set_config('app.workspace_id', '<wsId>', true);  -- local to txn
--   - Policies compare workspace_id = current_setting('app.workspace_id')::uuid.
--   - FAIL CLOSED: if app.workspace_id is unset or invalid, the cast errors or
--     matches nothing -> no rows. Never returns another tenant's data.
--
-- Idempotent: safe to re-run. Policies are dropped then recreated.
-- ============================================================================

-- --- Least-privilege grants to the runtime role -----------------------------
-- (app_user role is created in infra/bootstrap.ts; here we only grant.)
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
-- Ensure future tables also grant to app_user by default.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- --- RLS on every tenant table ---------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memberships','invitations','widget_settings','api_keys',
    'visitors','conversations','messages','audit_logs'
  ]
  LOOP
    -- Enable + FORCE RLS (FORCE also applies policies to the table owner).
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    -- Drop old policy if present, then recreate (idempotent).
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    -- nullif(...,'') guards against a client that sets the GUC to empty string
    -- (e.g. postgres.js serializing a NULL bind param). Unset, NULL, or '' all
    -- become NULL::uuid => the comparison is NULL => zero rows (fail closed).
    EXECUTE format($pol$
      CREATE POLICY tenant_isolation ON %I
        USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
        WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
    $pol$, t);
  END LOOP;
END $$;

-- ============================================================================
-- Memberships: an additional policy so a signed-in user can discover their OWN
-- memberships (to pick/switch workspace) even outside a workspace context.
-- We set app.user_id during auth. This is additive; the tenant_isolation policy
-- above still scopes cross-tenant visibility. Both policies are OR-ed.
-- ============================================================================
DROP POLICY IF EXISTS self_membership_read ON memberships;
CREATE POLICY self_membership_read ON memberships
  FOR SELECT
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

-- ============================================================================
-- Fail-closed guarantee:
--   current_setting('app.workspace_id', true) returns NULL when unset (the `true`
--   = missing_ok). NULL::uuid is NULL; `workspace_id = NULL` is NULL (not true),
--   so USING evaluates to false and zero rows are returned. Inserts with an
--   unset context fail the WITH CHECK. nullif(...,'') additionally maps an
--   empty-string GUC (some drivers serialize a NULL bind as '') to NULL. This is
--   exactly the "fail closed" test.
-- ============================================================================
