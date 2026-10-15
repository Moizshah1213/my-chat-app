import '../load-env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import {
  workspaces,
  conversations,
  messages,
  visitors,
  withoutTenant,
  withTenant,
  currentTx,
  closeDb,
} from '@livechat/db';

/**
 * Tenant isolation test suite (blueprint §8.9).
 *
 * Runs against the TEST database as the LEAST-PRIVILEGE app_user role
 * (NOBYPASSRLS), exercising the real production enforcement path:
 *   - App layer: withTenant sets app.workspace_id in the transaction.
 *   - DB layer:  RLS policies filter/guard every tenant table.
 *
 * Creates two workspaces (A and B) with data, then asserts A can never
 * read/modify/delete B's rows.
 */

const TEST_URL = process.env.TEST_DATABASE_URL!;

function cleanUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.delete('schema');
  return u.toString();
}

// A privileged connection (postgres superuser via BOOTSTRAP url) to SEED
// cross-tenant rows with NO workspace context, then prove app_user can't see them.
const BOOT_URL = cleanUrl(
  process.env.BOOTSTRAP_DATABASE_URL!.replace(/\/[^/]+$/, '/livechat_test'),
);
let boot: ReturnType<typeof postgres>;

let wsA = '';
let wsB = '';
let convA = '';
let convB = '';
let msgB = '';
let visitorB = '';

const newId = () => crypto.randomUUID();

before(async () => {
  assert.ok(TEST_URL, 'TEST_DATABASE_URL must be set');
  boot = postgres(BOOT_URL, { max: 1, onnotice: () => {} });

  wsA = newId();
  wsB = newId();
  visitorB = newId();
  convA = newId();
  convB = newId();
  msgB = newId();

  await boot`INSERT INTO workspaces (id, name, slug) VALUES (${wsA}::uuid, 'Tenant A', ${'a-' + wsA})`;
  await boot`INSERT INTO workspaces (id, name, slug) VALUES (${wsB}::uuid, 'Tenant B', ${'b-' + wsB})`;
  await boot`INSERT INTO visitors (id, workspace_id, anon_id) VALUES (${visitorB}::uuid, ${wsB}::uuid, 'anon-b')`;
  await boot`INSERT INTO conversations (id, workspace_id, status) VALUES (${convA}::uuid, ${wsA}::uuid, 'open')`;
  await boot`INSERT INTO conversations (id, workspace_id, status) VALUES (${convB}::uuid, ${wsB}::uuid, 'open')`;
  await boot`INSERT INTO messages (id, workspace_id, conversation_id, sender_type, body)
            VALUES (${msgB}::uuid, ${wsB}::uuid, ${convB}::uuid, 'agent', 'B secret')`;
});

after(async () => {
  if (boot) {
    await boot`DELETE FROM messages WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
    await boot`DELETE FROM conversations WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
    await boot`DELETE FROM visitors WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)`;
    await boot`DELETE FROM workspaces WHERE id IN (${wsA}::uuid, ${wsB}::uuid)`;
    await boot.end();
  }
  await closeDb();
});

describe('Tenant isolation (RLS enforced as app_user)', () => {
  it('A can read its OWN conversation', async () => {
    const rows = await withTenant(TEST_URL, wsA, async () => {
      const t = currentTx();
      return t.select().from(conversations).where(eq(conversations.id, convA));
    });
    assert.equal(rows.length, 1, 'A should see its own conversation');
    assert.equal(rows[0]?.id, convA);
  });

  it("A CANNOT read B's message (cross-tenant read blocked)", async () => {
    const bRows = await withTenant(TEST_URL, wsA, async () => {
      const t = currentTx();
      return t.select().from(messages).where(eq(messages.id, msgB));
    });
    assert.equal(bRows.length, 0, "A must NOT see B's message (RLS filters it out)");
  });

  it("A CANNOT read B's visitors", async () => {
    const rows = await withTenant(TEST_URL, wsA, async () => {
      const t = currentTx();
      return t.select().from(visitors).where(eq(visitors.id, visitorB));
    });
    assert.equal(rows.length, 0, 'A must not see B visitors');
  });

  it('A sees ONLY its own rows when listing', async () => {
    const rows = await withTenant(TEST_URL, wsA, async () => {
      const t = currentTx();
      return t.select().from(conversations);
    });
    assert.ok(rows.every((r) => r.workspaceId === wsA), 'A list must only contain A rows');
  });

  it("B sees its own message but not A's conversation", async () => {
    const bRows = await withTenant(TEST_URL, wsB, async () => {
      const t = currentTx();
      return t.select().from(messages).where(eq(messages.id, msgB));
    });
    assert.equal(bRows.length, 1, 'B sees its own message');

    const aFromB = await withTenant(TEST_URL, wsB, async () => {
      const t = currentTx();
      return t.select().from(conversations).where(eq(conversations.id, convA));
    });
    assert.equal(aFromB.length, 0, 'B must not see A conversation');
  });

  it('A CANNOT update B row (cross-tenant write blocked)', async () => {
    const result = await withTenant(TEST_URL, wsA, async () => {
      const t = currentTx();
      return t
        .update(messages)
        .set({ body: 'hacked by A' })
        .where(eq(messages.id, msgB))
        .returning();
    });
    assert.equal(result.length, 0, 'A update of B message must affect 0 rows');

    const bRows = await withTenant(TEST_URL, wsB, async () => {
      const t = currentTx();
      return t.select().from(messages).where(eq(messages.id, msgB));
    });
    assert.equal(bRows[0]?.body, 'B secret', "B's message body must be intact");
  });

  it('FAIL CLOSED: without workspace context, tenant tables return no rows', async () => {
    const raw = postgres(cleanUrl(TEST_URL), { max: 1, onnotice: () => {} });
    try {
      const count = await raw.begin(async (tx) => {
        // Deliberately DO NOT call set_config('app.workspace_id', ...).
        const r = await tx`SELECT count(*)::int AS c FROM messages`;
        return (r[0]?.c ?? 0) as number;
      });
      assert.equal(count, 0, 'No workspace context => RLS returns 0 rows (fail closed)');
    } finally {
      await raw.end();
    }
  });

  it('withTenant refuses to run without a workspaceId (app-layer fail closed)', async () => {
    await assert.rejects(
      () => withTenant(TEST_URL, null, async () => 1),
      /workspaceId is required/,
    );
  });

  it('withoutTenant can read global tables (workspaces) across tenants', async () => {
    const rows = await withoutTenant(TEST_URL, async () => {
      const t = currentTx();
      return t.select().from(workspaces).where(eq(workspaces.id, wsA));
    });
    assert.equal(rows.length, 1, 'workspaces is global (no RLS), readable without tenant ctx');
  });
});

