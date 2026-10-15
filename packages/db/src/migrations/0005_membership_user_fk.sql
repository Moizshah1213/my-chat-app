-- ============================================================================
-- 0005_membership_user_fk.sql — memberships.user_id must reference users(id).
--
-- 0002 originally omitted this FK (and schema.ts mirrored that omission), so
-- deleting a user left ghost membership rows pointing at nonexistent users.
-- Clean up any orphans first so the constraint can validate existing rows,
-- then add it with ON DELETE CASCADE (matches refresh_tokens/email_tokens).
-- ============================================================================

DELETE FROM memberships m
WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = m.user_id);

ALTER TABLE memberships
  ADD CONSTRAINT memberships_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
