/**
 * One-off maintenance: remove unit-test/smoke-test artifacts that earlier test
 * runs accidentally left in the DEV database (auth tests used to run against
 * DATABASE_URL=livechat while cleaning up livechat_test).
 *
 * Runs as the bootstrap SUPERUSER on purpose (BYPASSRLS):
 *  - memberships has FORCE ROW LEVEL SECURITY, so as app_user/app_migrator
 *    with no tenant context those subselects see ZERO rows — the ownerless-
 *    workspace sweep would then match EVERY workspace and destroy real data.
 *  - Superuser bypasses RLS, so both the orphan checks are honest.
 *
 * Steps: orphaned users -> orphaned memberships -> ownerless workspaces.
 *
 * Run: pnpm --filter @livechat/api exec tsx scripts/purge-test-rows.ts
 */
import '../src/load-env.js';
import postgres from 'postgres';

const bootUrl = new URL(process.env.BOOTSTRAP_DATABASE_URL!);
bootUrl.pathname = '/livechat'; // target the DEV database as superuser
bootUrl.searchParams.delete('schema');
const sql = postgres(bootUrl.toString(), { max: 1, onnotice: () => {} });

// 1) All test/smoke users were created with @example.com addresses.
const users = await sql`DELETE FROM users WHERE email LIKE '%@example.com' RETURNING email`;
// 2) Memberships whose user no longer exists (0005's FK makes these cascade
//    from now on, but rows from before the FK need a one-off sweep).
const ghosts = await sql`DELETE FROM memberships m
                         WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = m.user_id)
                         RETURNING m.id`;
// 3) Workspaces left with no members at all.
const ws = await sql`DELETE FROM workspaces w
                     WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = w.id)
                     RETURNING name`;

console.log(
  `purged ${users.length} test users, ${ghosts.length} ghost memberships, ` +
    `${ws.length} ownerless workspaces:`,
);
for (const r of ws) console.log(`  - ${r.name}`);

await sql.end();
