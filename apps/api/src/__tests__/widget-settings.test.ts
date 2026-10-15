import '../load-env.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import postgres from 'postgres';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from '../app.module.js';
import { resetRateLimits } from '../rate-limit.js';
import { closeDb } from '@livechat/db';

/**
 * Phase 3 — Widget settings suite (blueprint §10).
 *
 * Boots the REAL Nest app against the TEST database. Covers the agent-facing
 * GET/PATCH /v1/widget/settings (defaults, round-trip, null-clearing, strict
 * validation / mass-assignment, RBAC, tenant isolation) and the PUBLIC
 * GET /widget/v1/settings?key=pk_… (key resolution, Origin allowlist, public
 * projection — never allowedDomains or aiInstructions) plus visitor_init by
 * public key.
 */

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;

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
let agent: Account;
let foreign: Account;
let publicKey = '';
const createdEmails: string[] = [];

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
const del = (path: string, bearer?: string) => request(path, { method: 'DELETE', bearer });

/** Public settings fetch by widget key; optional Origin for allowlist tests. */
const settingsFetch = (key: string, origin?: string): Promise<HttpResult> =>
  request(`/widget/v1/settings?key=${encodeURIComponent(key)}`, {
    ...(origin ? { headers: { origin } } : {}),
  });

async function signup(label: string): Promise<Account> {
  const email = `${label}-${uniq()}@example.com`;
  createdEmails.push(email);
  const res = await post('/v1/auth/signup', {
    email,
    password: 'correct-horse-battery',
    name: label,
    workspaceName: `${label} WS`,
  });
  assert.equal(res.status, 200, `signup should succeed: ${JSON.stringify(res.json)}`);
  return {
    email,
    accessToken: res.json.accessToken,
    workspaceId: res.json.workspaceId,
    userId: res.json.user.id,
  };
}

/** Invite + accept to create an agent account inside the owner's workspace. */
async function createAgent(label: string): Promise<Account> {
  const inviteEmail = `${label}-inv-${uniq()}@example.com`;
  const inv = await post(
    '/v1/invitations',
    { email: inviteEmail, role: 'agent' },
    owner.accessToken,
  );
  assert.equal(inv.status, 201, `invite should succeed: ${JSON.stringify(inv.json)}`);
  const res = await post('/v1/invitations/accept', {
    token: inv.json.token,
    name: label,
    password: 'correct-horse-battery',
  });
  assert.equal(res.status, 200, `accept should succeed: ${JSON.stringify(res.json)}`);
  createdEmails.push(res.json.user.email);
  return {
    email: res.json.user.email,
    accessToken: res.json.accessToken,
    workspaceId: res.json.workspaceId,
    userId: res.json.user.id,
  };
}

before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must be set');
  boot = postgres(BOOT_URL, { max: 1, onnotice: () => {} });

  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error'] });
  app.use(cookieParser());
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;

  owner = await signup('settings-owner');
  foreign = await signup('settings-foreign');
  agent = await createAgent('settings-agent');

  // One live widget key for the public-endpoint suites.
  const created = await post('/v1/api-keys', { name: 'Widget' }, owner.accessToken);
  assert.equal(created.status, 201, JSON.stringify(created.json));
  publicKey = created.json.publicKey;
});

after(async () => {
  if (app) await app.close();
  if (boot) {
    const ws = [owner?.workspaceId, foreign?.workspaceId].filter(Boolean) as string[];
    if (ws.length >= 1) {
      await boot`DELETE FROM messages WHERE workspace_id = ANY(${ws}::uuid[])`;
      await boot`DELETE FROM conversations WHERE workspace_id = ANY(${ws}::uuid[])`;
      await boot`DELETE FROM visitors WHERE workspace_id = ANY(${ws}::uuid[])`;
      await boot`DELETE FROM api_keys WHERE workspace_id = ANY(${ws}::uuid[])`;
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

describe('widget settings: agent CRUD, validation, RBAC, isolation', () => {
  before(() => resetRateLimits());

  it('GET returns defaults when no settings row exists yet', async () => {
    const res = await get('/v1/widget/settings', owner.accessToken);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.color, '#4f46e5');
    assert.equal(res.json.position, 'right');
    assert.equal(res.json.language, 'en');
    assert.deepEqual(res.json.allowedDomains, []);
    assert.deepEqual(res.json.prechatFields, []);
    assert.deepEqual(res.json.workingHours, {});
    assert.equal(res.json.aiEnabled, false);
    assert.equal(res.json.greeting, null);
  });

  it('PATCH round-trips every customizable field', async () => {
    const res = await patch(
      '/v1/widget/settings',
      {
        color: '#ff5500',
        position: 'left',
        greeting: 'Hi there!',
        offlineMessage: 'We are away',
        logoUrl: 'https://cdn.example.com/logo.png',
        language: 'fr',
        prechatFields: [{ name: 'email', required: true }],
        workingHours: { mon: '9-17' },
        allowedDomains: ['shop.example.com'],
      },
      owner.accessToken,
    );
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.color, '#ff5500');
    assert.equal(res.json.position, 'left');
    assert.equal(res.json.greeting, 'Hi there!');
    assert.equal(res.json.language, 'fr');
    assert.deepEqual(res.json.prechatFields, [{ name: 'email', required: true }]);
    assert.deepEqual(res.json.workingHours, { mon: '9-17' });
    assert.deepEqual(res.json.allowedDomains, ['shop.example.com']);

    const get_ = await get('/v1/widget/settings', owner.accessToken);
    assert.equal(get_.status, 200);
    assert.equal(get_.json.color, '#ff5500', 'persisted across requests');
    assert.equal(get_.json.greeting, 'Hi there!');
  });

  it('null clears a nullable field; partial patch leaves others untouched', async () => {
    const cleared = await patch('/v1/widget/settings', { greeting: null }, owner.accessToken);
    assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
    assert.equal(cleared.json.greeting, null);
    assert.equal(cleared.json.color, '#ff5500', 'untouched fields preserved');
  });

  it('rejects mass-assignment, bad values, and empty patches', async () => {
    const massAssign = await patch(
      '/v1/widget/settings',
      { color: '#000000', workspaceId: owner.workspaceId },
      owner.accessToken,
    );
    assert.equal(massAssign.status, 400, 'unknown fields rejected by strict schema');
    assert.equal(massAssign.json.error.code, 'validation_failed');

    const badColor = await patch('/v1/widget/settings', { color: 'red' }, owner.accessToken);
    assert.equal(badColor.status, 400, 'color must be #rrggbb');

    const badPosition = await patch(
      '/v1/widget/settings',
      { position: 'top' },
      owner.accessToken,
    );
    assert.equal(badPosition.status, 400, 'position must be left|right');

    const empty = await patch('/v1/widget/settings', {}, owner.accessToken);
    assert.equal(empty.status, 400, 'empty patch requires at least one field');

    // Nothing from the rejected writes leaked.
    const get_ = await get('/v1/widget/settings', owner.accessToken);
    assert.equal(get_.json.color, '#ff5500');
  });

  it('agents cannot read or update settings (403); unauthenticated is 401', async () => {
    assert.equal((await get('/v1/widget/settings', agent.accessToken)).status, 403);
    assert.equal(
      (await patch('/v1/widget/settings', { color: '#000000' }, agent.accessToken)).status,
      403,
    );
    assert.equal((await get('/v1/widget/settings')).status, 401);
    assert.equal((await patch('/v1/widget/settings', { color: '#000000' })).status, 401);
  });

  it('settings are tenant-isolated (foreign workspace sees its own defaults)', async () => {
    const foreignGet = await get('/v1/widget/settings', foreign.accessToken);
    assert.equal(foreignGet.status, 200);
    assert.equal(foreignGet.json.color, '#4f46e5', 'foreign workspace sees defaults');

    const foreignPatch = await patch(
      '/v1/widget/settings',
      { color: '#00ff00' },
      foreign.accessToken,
    );
    assert.equal(foreignPatch.status, 200);

    const ownerGet = await get('/v1/widget/settings', owner.accessToken);
    assert.equal(ownerGet.json.color, '#ff5500', 'owner settings unchanged by foreign writes');
  });
});

describe('widget settings: public fetch by widget key', () => {
  before(async () => {
    resetRateLimits();
    // Start from a clean slate so the defaults assertions hold.
    await boot`DELETE FROM widget_settings WHERE workspace_id = ${owner.workspaceId}::uuid`;
  });

  it('returns defaults + the public projection (no allowlist/ai instructions)', async () => {
    const pub = await settingsFetch(publicKey);
    assert.equal(pub.status, 200, JSON.stringify(pub.json));
    assert.equal(pub.json.color, '#4f46e5');
    assert.equal(pub.json.position, 'right');
    assert.equal(pub.json.language, 'en');
    assert.equal(pub.json.aiEnabled, false);
    assert.deepEqual(pub.json.prechatFields, []);
    assert.equal('allowedDomains' in pub.json, false, 'allowlist never leaked to the widget');
    assert.equal('aiInstructions' in pub.json, false);
  });

  it('reflects customized public fields; still hides sensitive ones', async () => {
    const set = await patch(
      '/v1/widget/settings',
      {
        color: '#123456',
        greeting: 'Hello',
        offlineMessage: 'Away',
        language: 'de',
        aiEnabled: true,
        allowedDomains: ['shop.example.com', '*.other.example.com'],
      },
      owner.accessToken,
    );
    assert.equal(set.status, 200, JSON.stringify(set.json));

    const pub = await settingsFetch(publicKey);
    assert.equal(pub.status, 200, JSON.stringify(pub.json));
    assert.equal(pub.json.color, '#123456');
    assert.equal(pub.json.greeting, 'Hello');
    assert.equal(pub.json.offlineMessage, 'Away');
    assert.equal(pub.json.language, 'de');
    assert.equal(pub.json.aiEnabled, true);
    assert.equal('allowedDomains' in pub.json, false);
    assert.equal('aiInstructions' in pub.json, false);
  });

  it('enforces the Origin allowlist (exact + wildcard); missing Origin bypasses', async () => {
    const denied = await settingsFetch(publicKey, 'https://evil.example.net');
    assert.equal(denied.status, 403, `foreign origin refused: ${JSON.stringify(denied.json)}`);
    assert.equal(denied.json.error.code, 'forbidden');

    const exact = await settingsFetch(publicKey, 'https://shop.example.com');
    assert.equal(exact.status, 200, JSON.stringify(exact.json));

    const wild = await settingsFetch(publicKey, 'https://app.other.example.com');
    assert.equal(wild.status, 200, 'subdomain wildcard matches');

    const noOrigin = await settingsFetch(publicKey);
    assert.equal(noOrigin.status, 200, 'server-side fetch without Origin bypasses the check');

    const badOrigin = await settingsFetch(publicKey, 'not-a-url');
    assert.equal(badOrigin.status, 403, 'unparseable Origin refused');

    // Restore an unrestricted workspace for later suites.
    await boot`DELETE FROM widget_settings WHERE workspace_id = ${owner.workspaceId}::uuid`;
  });

  it('rejects missing, unknown, forged, and revoked keys', async () => {
    const missing = await get('/widget/v1/settings');
    assert.equal(missing.status, 400, 'key query param is required');

    const unknown = await settingsFetch(`pk_${'0'.repeat(32)}_randomtail123`);
    assert.equal(unknown.status, 404, 'unknown key rejected');
    assert.equal(unknown.json.error.code, 'not_found');

    const forged = await settingsFetch(
      `pk_${owner.workspaceId.replace(/-/g, '')}_forgedtail456`,
    );
    assert.equal(forged.status, 404, 'forged key rejected');

    // A dedicated key, minted then revoked.
    const created = await post('/v1/api-keys', { name: 'Doomed' }, owner.accessToken);
    assert.equal(created.status, 201);
    const revoked = await del(`/v1/api-keys/${created.json.id}`, owner.accessToken);
    assert.equal(revoked.status, 200);
    const revokedFetch = await settingsFetch(created.json.publicKey);
    assert.equal(revokedFetch.status, 404, 'revoked key rejected');
  });
});

describe('widget: visitor_init by public key', () => {
  before(() => resetRateLimits());

  it('resolves a live key and mints a visitor token', async () => {
    const res = await post('/widget/v1/visitor_init', {
      publicKey,
      anonymousId: `vk-anon-${uniq()}`,
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.ok(res.json.token, 'mints a visitor token');
    assert.ok(res.json.conversationId, 'opens a conversation');
  });

  it('requires exactly one of workspaceId / publicKey', async () => {
    const both = await post('/widget/v1/visitor_init', {
      publicKey,
      workspaceId: owner.workspaceId,
      anonymousId: `vk-both-${uniq()}`,
    });
    assert.equal(both.status, 400, 'both provided is ambiguous');
    assert.equal(both.json.error.code, 'validation_failed');

    const neither = await post('/widget/v1/visitor_init', {
      anonymousId: `vk-neither-${uniq()}`,
    });
    assert.equal(neither.status, 400, 'neither provided is invalid');
  });

  it('rejects forged and revoked keys', async () => {
    const forged = await post('/widget/v1/visitor_init', {
      publicKey: `pk_${owner.workspaceId.replace(/-/g, '')}_forgedtail789`,
      anonymousId: `vk-forged-${uniq()}`,
    });
    assert.equal(forged.status, 404, 'forged key rejected');

    const created = await post('/v1/api-keys', { name: 'Doomed 2' }, owner.accessToken);
    assert.equal(created.status, 201);
    assert.equal((await del(`/v1/api-keys/${created.json.id}`, owner.accessToken)).status, 200);
    const revoked = await post('/widget/v1/visitor_init', {
      publicKey: created.json.publicKey,
      anonymousId: `vk-revoked-${uniq()}`,
    });
    assert.equal(revoked.status, 404, 'revoked key rejected');
  });
});

describe('visitor attributes (setAttributes) + visitors API', () => {
  before(() => resetRateLimits());

  it('visitor_init merges attributes into visitors.meta; list/detail expose them', async () => {
    const anon = `va-${uniq()}`;
    const init1 = await post('/widget/v1/visitor_init', {
      publicKey,
      anonymousId: anon,
      attributes: { plan: 'pro', seats: 5, beta: true },
    });
    assert.equal(init1.status, 200, `visitor_init ok: ${JSON.stringify(init1.json)}`);
    const { visitorId, conversationId } = init1.json;

    // A "reload" (second init) merges additional attributes.
    const init2 = await post('/widget/v1/visitor_init', {
      publicKey,
      anonymousId: anon,
      attributes: { tier: 'gold' },
    });
    assert.equal(init2.status, 200);
    assert.equal(init2.json.visitorId, visitorId, 'same visitor resumed');

    // Agent reads visitors (blueprint §12).
    const list = await get('/v1/visitors', owner.accessToken);
    assert.equal(list.status, 200, `visitors list: ${JSON.stringify(list.json)}`);
    const found = (list.json as any[]).find((v) => v.id === visitorId);
    assert.ok(found, 'visitor appears in the list');
    assert.equal(found.meta.plan, 'pro', 'string attribute stored');
    assert.equal(found.meta.seats, 5, 'number attribute stored');
    assert.equal(found.meta.beta, true, 'boolean attribute stored');

    const detail = await get(`/v1/visitors/${visitorId}`, owner.accessToken);
    assert.equal(detail.status, 200, `visitor detail: ${JSON.stringify(detail.json)}`);
    assert.equal(detail.json.meta.tier, 'gold', 'attributes merge across inits');
    assert.ok(
      (detail.json.conversations as any[]).some((c) => c.id === conversationId),
      'detail lists the visitor conversation',
    );

    // Non-scalar values are rejected by the strict zod schema.
    const bad = await post('/widget/v1/visitor_init', {
      publicKey,
      anonymousId: anon,
      attributes: { nested: { a: 1 } },
    });
    assert.equal(bad.status, 400, `nested attribute rejected: ${JSON.stringify(bad.json)}`);
    assert.equal(bad.json.error.code, 'validation_failed');

    // Unknown visitors are 404 (scoped lookups, no cross-tenant leak).
    const ghost = await get(
      '/v1/visitors/00000000-0000-4000-8000-000000000000',
      owner.accessToken,
    );
    assert.equal(ghost.status, 404);
  });
});

