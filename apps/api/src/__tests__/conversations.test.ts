import '../load-env.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import postgres from 'postgres';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { authenticator } from 'otplib';
import { AppModule } from '../app.module.js';
import { resetRateLimits } from '../rate-limit.js';
import { closeDb } from '@livechat/db';
import { conversationService } from '../conversations.service.js';

/**
 * Phase 2 — Conversations REST suite (blueprint §6 inbox + §7 widget init).
 *
 * Boots the REAL Nest app (guards, filter, controllers) against the TEST
 * database — same harness as http.test.ts. Fixtures are seeded through the
 * bootstrap superuser (RLS-safe pattern from tenant-isolation.test.ts) and
 * removed in after().
 *
 * Covers: list + keyset pagination, status/assignee filters, cross-tenant 404
 * equivalence, assignment membership validation, mass-assignment rejection,
 * message history paging (before-cursor), agent send + idempotency, closed
 * conversation rules, visitor_init resume/reopen, domain allowlist, and the
 * visitor/agent token audience separation on HTTP.
 */

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;
process.env.EMAIL_PROVIDER = 'console';

const BOOT_URL = process.env.BOOTSTRAP_DATABASE_URL!.replace(/\/[^/]+$/, '/livechat_test');
let boot: ReturnType<typeof postgres>;
let app: NestExpressApplication;
let base = '';

interface Account {
  email: string;
  accessToken: string;
  workspaceId: string;
  userId: string;
}
let owner: Account;
let ownerPublicKey = '';
const createdEmails: string[] = [];

// Seed fixtures (created in before(), removed in after()).
let visitorId = '';
const openConvs: string[] = []; // 5 conversations, distinct lastMessageAt (newest first)
let closedConv = '';
let msgConv = ''; // conversation holding the 5-message history for paging
let foreignWs = '';
let foreignConv = '';

const uniq = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

interface HttpResult {
  status: number;
  json: any;
}

async function request(
  path: string,
  init: RequestInit & { bearer?: string } = {},
): Promise<HttpResult> {
  const { bearer, ...rest } = init;
  const res = await fetch(base + path, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(rest.headers ?? {}),
    },
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

const get = (path: string, bearer?: string) => request(path, { bearer });
const post = (path: string, body: unknown, bearer?: string) =>
  request(path, { method: 'POST', body: JSON.stringify(body), bearer });
const patch = (path: string, body: unknown, bearer?: string) =>
  request(path, { method: 'PATCH', body: JSON.stringify(body), bearer });

async function signup(label: string): Promise<Account> {
  const email = `${label}-${uniq()}@example.com`;
  createdEmails.push(email);
  const loggedTokens: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    const line = String(args[0] ?? '');
    if (line.startsWith('[email:verify]')) loggedTokens.push(line.split('-> ')[1]?.trim() ?? '');
    originalLog.apply(console, args as []);
  };
  let res: HttpResult;
  try {
    res = await post('/v1/auth/signup', {
      email,
      password: 'correct-horse-battery',
      name: label,
      workspaceName: `${label} WS`,
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(res.status, 200, `signup should succeed: ${JSON.stringify(res.json)}`);
  assert.equal(res.json.requiresEmailVerification, true);
  const verified = await post('/v1/auth/verify-email', { token: loggedTokens[0] });
  assert.equal(verified.status, 200, 'verification link should verify the account');
  const login = await post('/v1/auth/login', { email, password: 'correct-horse-battery' });
  assert.equal(login.status, 200, 'verified account should sign in');
  const setup = await post('/v1/auth/2fa/setup', {}, login.json.accessToken);
  assert.equal(setup.status, 200);
  const enabled = await post(
    '/v1/auth/2fa/verify',
    { code: authenticator.generate(setup.json.secret) },
    login.json.accessToken,
  );
  assert.equal(enabled.status, 200);
  return {
    email,
    accessToken: login.json.accessToken,
    workspaceId: login.json.workspaceId,
    userId: login.json.user.id,
  };
}

/** Raw widget init (public endpoint; optional Origin for allowlist tests). */
function widgetInit(anonymousId: string, origin?: string): Promise<HttpResult> {
  return request('/widget/v1/visitor_init', {
    method: 'POST',
    body: JSON.stringify({ publicKey: ownerPublicKey, anonymousId }),
    ...(origin ? { headers: { origin } } : {}),
  });
}

before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must be set');
  boot = postgres(BOOT_URL, { max: 1, onnotice: () => {} });

  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error'] });
  app.use(cookieParser());
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;

  owner = await signup('conv-owner');
  const widgetKey = await post('/v1/api-keys', { name: 'Conversation tests' }, owner.accessToken);
  assert.equal(widgetKey.status, 201, `test widget key created: ${JSON.stringify(widgetKey.json)}`);
  ownerPublicKey = widgetKey.json.publicKey;

  // --- Seed fixtures -------------------------------------------------------
  visitorId = randomUUID();
  await boot`INSERT INTO visitors (id, workspace_id, anon_id)
            VALUES (${visitorId}::uuid, ${owner.workspaceId}::uuid, 'conv-seed-anon')`;

  // 5 open conversations with strictly descending last_message_at (i=0 newest).
  for (let i = 0; i < 5; i++) {
    const id = randomUUID();
    openConvs.push(id);
    await boot`INSERT INTO conversations (id, workspace_id, visitor_id, status, last_message_at)
              VALUES (${id}::uuid, ${owner.workspaceId}::uuid, ${visitorId}::uuid, 'open',
                      now() - ${i}::int * interval '1 minute')`;
  }

  closedConv = randomUUID();
  await boot`INSERT INTO conversations (id, workspace_id, visitor_id, status, closed_at, last_message_at)
            VALUES (${closedConv}::uuid, ${owner.workspaceId}::uuid, ${visitorId}::uuid, 'closed',
                    now(), now() - 10 * interval '1 minute')`;

  msgConv = randomUUID();
  await boot`INSERT INTO conversations (id, workspace_id, visitor_id, status, last_message_at)
            VALUES (${msgConv}::uuid, ${owner.workspaceId}::uuid, ${visitorId}::uuid, 'open',
                    now() - 30 * interval '1 minute')`;
  // seed-0 oldest .. seed-4 newest, one minute apart (deterministic ordering).
  for (let i = 0; i < 5; i++) {
    await boot`INSERT INTO messages (id, workspace_id, conversation_id, sender_type, body, created_at)
              VALUES (gen_random_uuid(), ${owner.workspaceId}::uuid, ${msgConv}::uuid, 'agent',
                      ${`seed-${i}`}, now() - ${5 - i}::int * interval '1 minute')`;
  }

  foreignWs = randomUUID();
  foreignConv = randomUUID();
  await boot`INSERT INTO workspaces (id, name, slug)
            VALUES (${foreignWs}::uuid, 'Foreign WS', ${'foreign-' + foreignWs})`;
  await boot`INSERT INTO conversations (id, workspace_id, status)
            VALUES (${foreignConv}::uuid, ${foreignWs}::uuid, 'open')`;
});

after(async () => {
  if (app) await app.close();
  if (boot) {
    const ws = [owner?.workspaceId, foreignWs].filter(Boolean) as string[];
    if (ws.length === 2) {
      await boot`DELETE FROM messages WHERE workspace_id = ANY(${ws}::uuid[])`;
      await boot`DELETE FROM conversations WHERE workspace_id = ANY(${ws}::uuid[])`;
      await boot`DELETE FROM visitors WHERE workspace_id = ANY(${ws}::uuid[])`;
      await boot`DELETE FROM widget_settings WHERE workspace_id = ANY(${ws}::uuid[])`;
      await boot`DELETE FROM workspaces WHERE id = ANY(${ws}::uuid[])`;
    }
    for (const email of createdEmails) {
      await boot`DELETE FROM users WHERE email = ${email}::citext`;
    }
    await boot.end();
  }
  await closeDb();
});

describe('conversations: list, filters, pagination', () => {
  before(() => resetRateLimits());

  it('lists newest-first and pages exhaustively with keyset cursor (no overlap)', async () => {
    const expected = new Set([...openConvs, closedConv, msgConv]);
    const seen: string[] = [];
    const lastSeen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 10; page++) {
      const path = `/v1/conversations?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await get(path, owner.accessToken);
      assert.equal(res.status, 200, `page ${page + 1}: ${JSON.stringify(res.json)}`);
      assert.ok(res.json.items.length <= 2, 'page respects limit');
      for (const item of res.json.items) {
        seen.push(item.id);
        lastSeen.push(item.lastMessageAt);
      }
      cursor = res.json.nextCursor;
      if (!cursor) break;
    }

    assert.equal(seen.length, expected.size, `all ${expected.size} conversations seen: ${seen}`);
    assert.equal(new Set(seen).size, seen.length, 'no duplicates across pages');
    for (const id of expected) assert.ok(seen.includes(id), `conversation ${id} listed`);
    for (let i = 1; i < lastSeen.length; i++) {
      assert.ok(lastSeen[i]! <= lastSeen[i - 1]!, 'non-increasing lastMessageAt order');
    }

    const messagePreview = await get(`/v1/conversations/${msgConv}`, owner.accessToken);
    assert.equal(messagePreview.status, 200);
    assert.equal(messagePreview.json.lastMessagePreview, 'seed-4');
    assert.equal(messagePreview.json.lastMessageSenderType, 'agent');
  });

  it('status filter returns only matching conversations', async () => {
    const res = await get('/v1/conversations?status=closed&limit=50', owner.accessToken);
    assert.equal(res.status, 200);
    assert.ok(res.json.items.length >= 1);
    for (const item of res.json.items) assert.equal(item.status, 'closed');
    assert.ok(res.json.items.some((i: any) => i.id === closedConv), 'seeded closed conv listed');
    assert.equal(res.json.nextCursor, null, 'small result set fits one page');
  });

  it('cross-tenant conversation id is 404 (indistinguishable from missing)', async () => {
    const r1 = await get(`/v1/conversations/${foreignConv}`, owner.accessToken);
    assert.equal(r1.status, 404);
    assert.equal(r1.json.error.code, 'not_found');

    const r2 = await patch(
      `/v1/conversations/${foreignConv}`,
      { status: 'pending' },
      owner.accessToken,
    );
    assert.equal(r2.status, 404, 'cannot update a foreign conversation');
    assert.equal(r2.json.error.code, 'not_found');

    const r3 = await post(
      `/v1/conversations/${foreignConv}/messages`,
      { body: 'peek' },
      owner.accessToken,
    );
    assert.equal(r3.status, 404, 'cannot message a foreign conversation');
    assert.equal(r3.json.error.code, 'not_found');
  });
});

describe('conversations: update (status, assignment, mass-assignment)', () => {
  before(() => resetRateLimits());

  it('closing sets closedAt; leaving closed clears it', async () => {
    const conv = openConvs[0];

    const closed = await patch(`/v1/conversations/${conv}`, { status: 'closed' }, owner.accessToken);
    assert.equal(closed.status, 200, JSON.stringify(closed.json));
    assert.equal(closed.json.status, 'closed');
    assert.ok(closed.json.closedAt, 'closedAt stamped on close');

    const reopened = await patch(`/v1/conversations/${conv}`, { status: 'open' }, owner.accessToken);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.json.status, 'open');
    assert.equal(reopened.json.closedAt, null, 'closedAt cleared on reopen');
  });

  it('assignment requires a workspace member; self-assign + filter work', async () => {
    const conv = openConvs[1];

    const stranger = await patch(
      `/v1/conversations/${conv}`,
      { assignedTo: randomUUID() },
      owner.accessToken,
    );
    assert.equal(stranger.status, 400, 'non-member assignee rejected server-side');
    assert.match(stranger.json.error.message, /not a member/i);

    const self = await patch(
      `/v1/conversations/${conv}`,
      { assignedTo: owner.userId },
      owner.accessToken,
    );
    assert.equal(self.status, 200, JSON.stringify(self.json));
    assert.equal(self.json.assignedTo, owner.userId);

    const mine = await get('/v1/conversations?assignee=me&limit=50', owner.accessToken);
    assert.equal(mine.status, 200);
    assert.ok(mine.json.items.some((i: any) => i.id === conv), 'assigned conv in assignee=me');
    for (const item of mine.json.items) assert.equal(item.assignedTo, owner.userId);

    const un = await patch(`/v1/conversations/${conv}`, { assignedTo: null }, owner.accessToken);
    assert.equal(un.status, 200);
    assert.equal(un.json.assignedTo, null, 'nullable assignment clears assignee');
  });

  it('rejects empty patches and unknown fields (mass assignment)', async () => {
    const conv = openConvs[2];

    const empty = await patch(`/v1/conversations/${conv}`, {}, owner.accessToken);
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error.code, 'validation_failed');

    const smuggled = await patch(
      `/v1/conversations/${conv}`,
      { status: 'open', workspaceId: foreignWs, id: randomUUID() },
      owner.accessToken,
    );
    assert.equal(smuggled.status, 400, `unknown fields rejected: ${JSON.stringify(smuggled.json)}`);
    assert.equal(smuggled.json.error.code, 'validation_failed');
  });
});

describe('conversations: messages (history, send, idempotency, closed rules)', () => {
  before(() => resetRateLimits());

  it('history pages are ascending and the before-cursor walks to the oldest', async () => {
    const bodies: string[] = [];
    let beforeCursor: string | null = null;

    for (let page = 0; page < 10; page++) {
      const path = `/v1/conversations/${msgConv}/messages?limit=2${
        beforeCursor ? `&before=${encodeURIComponent(beforeCursor)}` : ''
      }`;
      const res = await get(path, owner.accessToken);
      assert.equal(res.status, 200, JSON.stringify(res.json));
      bodies.push(...res.json.items.map((m: any) => m.body));
      // Within every page the order must be oldest -> newest.
      const ts = res.json.items.map((m: any) => m.createdAt);
      assert.deepEqual(ts, [...ts].sort(), 'ascending createdAt within page');
      beforeCursor = res.json.nextCursor;
      if (!beforeCursor) break;
    }

    assert.deepEqual(
      bodies,
      ['seed-3', 'seed-4', 'seed-1', 'seed-2', 'seed-0'],
      'pages walk newest window first, then strictly older, no gaps or overlaps',
    );
  });

  it('agent send returns 201 and an idempotencyKey replays without a duplicate row', async () => {
    const conv = openConvs[0];
    const key = `idem-${uniq()}`;

    const first = await post(
      `/v1/conversations/${conv}/messages`,
      { body: 'one', idempotencyKey: key },
      owner.accessToken,
    );
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.equal(first.json.body, 'one');
    assert.equal(first.json.senderType, 'agent');

    const replay = await post(
      `/v1/conversations/${conv}/messages`,
      { body: 'one', idempotencyKey: key },
      owner.accessToken,
    );
    assert.equal(replay.status, 201);
    assert.equal(replay.json.id, first.json.id, 'same key returns the same message id');

    const [cnt] = await boot`SELECT count(*)::int AS n FROM messages WHERE idempotency_key = ${key}`;
    assert.equal(cnt?.n, 1, 'exactly one row for the key');
  });

  it('agents can edit and delete only their own sent messages', async () => {
    const sent = await post(
      `/v1/conversations/${msgConv}/messages`,
      { body: 'original message' },
      owner.accessToken,
    );
    assert.equal(sent.status, 201, JSON.stringify(sent.json));

    const edited = await patch(
      `/v1/conversations/${msgConv}/messages/${sent.json.id}`,
      { body: 'updated message' },
      owner.accessToken,
    );
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    assert.equal(edited.json.body, 'updated message');
    assert.ok(edited.json.editedAt);

    const deleted = await request(
      `/v1/conversations/${msgConv}/messages/${sent.json.id}`,
      { method: 'DELETE', bearer: owner.accessToken },
    );
    assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
    const page = await get(`/v1/conversations/${msgConv}/messages`, owner.accessToken);
    assert.equal(page.status, 200);
    assert.ok(!page.json.items.some((message: any) => message.id === sent.json.id));

    const visitorMessage = await conversationService.visitorSend(
      owner.workspaceId,
      visitorId,
      msgConv,
      { body: 'visitor message' },
    );
    const forbiddenEdit = await patch(
      `/v1/conversations/${msgConv}/messages/${visitorMessage.id}`,
      { body: 'cannot change visitor text' },
      owner.accessToken,
    );
    assert.equal(forbiddenEdit.status, 404, 'visitor messages are not editable by agents');
  });

  it('notification pause is per-agent and can be resumed', async () => {
    const conv = openConvs[3]!;
    const initial = await get(`/v1/conversations/${conv}/notifications`, owner.accessToken);
    assert.equal(initial.status, 200);
    assert.equal(initial.json.paused, false);

    const paused = await patch(`/v1/conversations/${conv}/notifications`, { paused: true }, owner.accessToken);
    assert.equal(paused.status, 200, JSON.stringify(paused.json));
    assert.equal(paused.json.paused, true);
    const preferences = await get('/v1/conversations/notification-preferences', owner.accessToken);
    assert.ok(preferences.json.conversationIds.includes(conv));

    const resumed = await patch(`/v1/conversations/${conv}/notifications`, { paused: false }, owner.accessToken);
    assert.equal(resumed.status, 200);
    assert.equal(resumed.json.paused, false);
    const cleared = await get('/v1/conversations/notification-preferences', owner.accessToken);
    assert.ok(!cleared.json.conversationIds.includes(conv));
  });

  it('deleting a conversation hides it from list and detail routes', async () => {
    const conv = openConvs[3]!;
    const deleted = await request(`/v1/conversations/${conv}`, {
      method: 'DELETE',
      bearer: owner.accessToken,
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.json));

    const detail = await get(`/v1/conversations/${conv}`, owner.accessToken);
    assert.equal(detail.status, 404);
    const list = await get('/v1/conversations?limit=50', owner.accessToken);
    assert.equal(list.status, 200);
    assert.ok(!list.json.items.some((conversation: any) => conversation.id === conv));
  });

  it('sending to a closed conversation is rejected (400) for agents', async () => {
    const conv = openConvs[0];
    const close = await patch(`/v1/conversations/${conv}`, { status: 'closed' }, owner.accessToken);
    assert.equal(close.status, 200);

    const send = await post(`/v1/conversations/${conv}/messages`, { body: 'nope' }, owner.accessToken);
    assert.equal(send.status, 400);
    assert.match(send.json.error.message, /closed/i);

    // Restore so any later suite over the same fixtures sees an open conversation.
    await patch(`/v1/conversations/${conv}`, { status: 'open' }, owner.accessToken);
  });

  it('does not auto-reply after an agent answers the visitor first', async () => {
    const conversationId = openConvs[4]!;
    await boot`
      INSERT INTO ai_settings (workspace_id, mode, provider, base_url, model, api_key_enc)
      VALUES (
        ${owner.workspaceId}::uuid,
        'auto',
        'openai_compatible',
        'https://api.openai.com/v1',
        'test-model',
        'test-encrypted-key'
      )
      ON CONFLICT (workspace_id) DO UPDATE SET
        mode = EXCLUDED.mode,
        provider = EXCLUDED.provider,
        base_url = EXCLUDED.base_url,
        model = EXCLUDED.model,
        api_key_enc = EXCLUDED.api_key_enc
    `;

    const visitorMessage = await conversationService.visitorSend(
      owner.workspaceId,
      visitorId,
      conversationId,
      { body: 'Can you help me with my order?' },
    );
    await conversationService.sendMessage(
      owner.workspaceId,
      'owner',
      owner.userId,
      conversationId,
      { body: 'Sure, I can help with that.' },
    );

    await new Promise((resolve) => setTimeout(resolve, 3_200));
    const aiReplies = await boot`
      SELECT id FROM messages
      WHERE workspace_id = ${owner.workspaceId}::uuid
        AND conversation_id = ${conversationId}::uuid
        AND sender_type = 'ai'
        AND created_at >= ${visitorMessage.createdAt}
    `;
    assert.equal(aiReplies.length, 0, 'AI must defer to the agent response');
  });

  it('visitor_init resumes the open conversation; after close it opens a NEW one', async () => {
    const anon = `conv-anon-${uniq()}`;

    const init1 = await widgetInit(anon);
    assert.equal(init1.status, 200, JSON.stringify(init1.json));
    assert.ok(init1.json.token, 'mints a visitor token');
    const c1 = init1.json.conversationId;

    const init2 = await widgetInit(anon);
    assert.equal(init2.status, 200);
    assert.equal(init2.json.conversationId, c1, 'open conversation resumed');
    assert.equal(init2.json.visitorId, init1.json.visitorId, 'stable visitor identity');

    const close = await patch(`/v1/conversations/${c1}`, { status: 'closed' }, owner.accessToken);
    assert.equal(close.status, 200);

    const init3 = await widgetInit(anon);
    assert.equal(init3.status, 200);
    assert.notEqual(init3.json.conversationId, c1, 'closed conversation is never reopened silently');
  });
});

describe('widget: origin allowlist + token audience separation', () => {
  before(() => resetRateLimits());

  it('visitor_init enforces the configured domain allowlist (exact + wildcard)', async () => {
    await boot`INSERT INTO widget_settings (workspace_id, allowed_domains)
              VALUES (${owner.workspaceId}::uuid, ARRAY['shop.example.com', '*.other.example.com'])
              ON CONFLICT (workspace_id) DO UPDATE SET allowed_domains = EXCLUDED.allowed_domains`;

    const denied = await widgetInit(`allow-${uniq()}`, 'https://evil.example.net');
    assert.equal(denied.status, 403, `foreign origin refused: ${JSON.stringify(denied.json)}`);
    assert.equal(denied.json.error.code, 'forbidden');

    const missingOrigin = await post('/widget/v1/visitor_init', {
      publicKey: ownerPublicKey,
      anonymousId: `allow-no-origin-${uniq()}`,
    });
    assert.equal(missingOrigin.status, 403, 'missing origin is refused when restrictions are configured');

    const exact = await widgetInit(`allow-${uniq()}`, 'https://shop.example.com');
    assert.equal(exact.status, 200, JSON.stringify(exact.json));

    const wild = await widgetInit(`allow-${uniq()}`, 'https://app.other.example.com');
    assert.equal(wild.status, 200, JSON.stringify(wild.json));

    // Unscope the workspace so later suites over the same DB are unaffected.
    await boot`DELETE FROM widget_settings WHERE workspace_id = ${owner.workspaceId}::uuid`;
  });

  it('a visitor token is rejected as an HTTP bearer (audiences are disjoint)', async () => {
    const init = await widgetInit(`aud-${uniq()}`);
    assert.equal(init.status, 200);

    const viaVisitor = await get('/v1/conversations', init.json.token);
    assert.equal(viaVisitor.status, 401, 'visitor token cannot open agent routes');
    assert.equal(viaVisitor.json.error.code, 'unauthenticated');

    const anon = await get('/v1/conversations');
    assert.equal(anon.status, 401, 'no token -> 401');
    assert.equal(anon.json.error.code, 'unauthenticated');
  });
});