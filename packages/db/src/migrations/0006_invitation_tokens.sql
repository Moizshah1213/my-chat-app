-- ============================================================================
-- 0006_invitation_tokens.sql — Global (non-tenant) invitation token pointer.
--
-- `invitations` is RLS-protected (tenant-scoped), so the PUBLIC accept
-- endpoint cannot resolve a raw invitation token to its workspace without a
-- tenant context — RLS hides every row. This global pointer table (same
-- pattern as refresh_tokens/email_tokens: hashed token at rest, no RLS)
-- maps token_hash -> (invitation_id, workspace_id). The accept flow reads
-- the pointer first, then enters the tenant context for the real work.
-- The pointer row is deleted when the invitation is consumed (single use).
-- ============================================================================

CREATE TABLE IF NOT EXISTS invitation_tokens (
  token_hash     text PRIMARY KEY,
  invitation_id  uuid NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON invitation_tokens TO app_user;
