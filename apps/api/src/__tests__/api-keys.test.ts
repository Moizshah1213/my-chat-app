import '../load-env.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import postgres from 'postgres';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from '../app.module.js';
import { resetRateLimits } from '../rate-limit.js';
import { closeDb } from '@livechat/db';

/**
 * Phase 3 — API keys suite (blueprint §7.3).
 *
 * Boots the REAL Nest app (guards, filter, controllers) against the TEST
 * database. Covers key minting (pk_ format, secret never returned), listing,
 * RBAC (owner/admin only), revocation (idempotent, last-used tracking),
 * cross-tenant isolation, and the public key-resolution path used by the
 * widget endpoints (visitor_init, settings fetch).
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
const del = (path: string, bearer?: string) => request(path, { method: 'DELETE', bearer });

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

  owner = await signup('apikey-owner');
  foreign = await signup('apikey-foreign');
  agent = await createAgent('apikey-agent');
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

describe('api keys: mint, list, RBAC', () => {
  before(() => resetRateLimits());

  it('POST /v1/api-keys mints a pk_ key and never returns a secret', async () => {
    const res = await post('/v1/api-keys', { name: 'Website' }, owner.accessToken);
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.name, 'Website');

    const key: string = res.json.publicKey;
    assert.match(key, /^pk_/, 'pk_ prefix');
    assert.equal(key.length, 60, 'fixed-length key');
    assert.ok(
      key.includes(owner.workspaceId.replace(/-/g, '')),
      'key embeds the workspace id segment',
    );
    assert.equal('secretHash' in res.json, false, 'secret hash is never returned');

    // Audit trail recorded the creation (fire-and-forget — poll briefly).
    let audited = false;
    for (let i = 0; i < 20 && !audited; i++) {
      const [row] = await boot`SELECT 1 FROM audit_logs
        WHERE workspace_id = ${owner.workspaceId}::uuid AND action = 'apikey.create' LIMIT 1`;
      audited = Boolean(row);
      if (!audited) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(audited, 'apikey.create recorded in the audit log');

    const list = await get('/v1/api-keys', owner.accessToken);
    assert.equal(list.status, 200);
    const entry = list.json.find((k: any) => k.id === res.json.id);
    assert.ok(entry, 'created key is listed');
    assert.equal(entry.publicKey, key);
    assert.equal(entry.revokedAt, null);
    assert.equal(entry.lastUsedAt, null, 'fresh key has no last-used stamp');
    assert.equal('secretHash' in entry, false);
  });

  it('multiple keys can be minted and listed (non-increasing createdAt)', async () => {
    const second = await post('/v1/api-keys', { name: 'Docs site' }, owner.accessToken);
    assert.equal(second.status, 201);

    const list = await get('/v1/api-keys', owner.accessToken);
    assert.equal(list.status, 200);
    assert.ok(list.json.length >= 2, 'both keys listed');
    assert.ok(list.json.some((k: any) => k.id === second.json.id));
    for (let i = 1; i < list.json.length; i++) {
      assert.ok(list.json[i].createdAt <= list.json[i - 1].createdAt, 'newest first');
    }
  });

  it('rejects invalid mint bodies (validation)', async () => {
    const emptyName = await post('/v1/api-keys', { name: '' }, owner.accessToken);
    assert.equal(emptyName.status, 400);
    assert.equal(emptyName.json.error.code, 'validation_failed');

    const unknown = await post(
      '/v1/api-keys',
      { name: 'X', workspaceId: randomUUID() },
      owner.accessToken,
    );
    assert.equal(unknown.status, 400, 'mass-assignment rejected by strict schema');
  });

  it('agents cannot read or manage api keys (403)', async () => {
    const list = await get('/v1/api-keys', agent.accessToken);
    assert.equal(list.status, 403);
    assert.equal(list.json.error.code, 'forbidden');

    const create = await post('/v1/api-keys', { name: 'nope' }, agent.accessToken);
    assert.equal(create.status, 403);

    const revoke = await del(`/v1/api-keys/${randomUUID()}`, agent.accessToken);
    assert.equal(revoke.status, 403);
  });

  it('unauthenticated requests are rejected (401)', async () => {
    assert.equal((await get('/v1/api-keys')).status, 401);
    assert.equal((await post('/v1/api-keys', { name: 'x' })).status, 401);
    assert.equal((await del(`/v1/api-keys/${randomUUID()}`)).status, 401);
  });
});

describe('api keys: revocation, tenant isolation, public resolution', () => {
  before(() => resetRateLimits());

  it('revoke is idempotent and stamps revokedAt; listing reflects it', async () => {
    const created = await post('/v1/api-keys', { name: 'Revoke me' }, owner.accessToken);
    assert.equal(created.status, 201);
    const id = created.json.id;

    const first = await del(`/v1/api-keys/${id}`, owner.accessToken);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.ok(first.json.revokedAt, 'revokedAt stamped');

    const second = await del(`/v1/api-keys/${id}`, owner.accessToken);
    assert.equal(second.status, 200, 're-revoke is an idempotent success');
    assert.equal(second.json.revokedAt, first.json.revokedAt, 'original revokedAt preserved');

    const list = await get('/v1/api-keys', owner.accessToken);
    const entry = list.json.find((k: any) => k.id === id);
    assert.equal(entry.revokedAt, first.json.revokedAt);
  });

  it('revoking an unknown or foreign key is 404 (indistinguishable)', async () => {
    assert.equal((await del(`/v1/api-keys/${randomUUID()}`, owner.accessToken)).status, 404);

    // A key that exists in ANOTHER workspace is invisible from here.
    const foreignKey = await post('/v1/api-keys', { name: 'Foreign' }, foreign.accessToken);
    assert.equal(foreignKey.status, 201);
    const cross = await del(`/v1/api-keys/${foreignKey.json.id}`, owner.accessToken);
    assert.equal(cross.status, 404, 'cross-tenant revoke looks like missing');
    assert.equal(cross.json.error.code, 'not_found');
  });

  it('live key resolves + stamps lastUsedAt via visitor_init; forged/revoked/malformed are rejected', async () => {
    const created = await post('/v1/api-keys', { name: 'Widget' }, owner.accessToken);
    assert.equal(created.status, 201);
    const key = created.json.publicKey;

    const init = await post('/widget/v1/visitor_init', {
      publicKey: key,
      anonymousId: `pk-anon-${uniq()}`,
    });
    assert.equal(init.status, 200, JSON.stringify(init.json));
    assert.ok(init.json.token, 'mints a visitor token');

    const list = await get('/v1/api-keys', owner.accessToken);
    const entry = list.json.find((k: any) => k.id === created.json.id);
    assert.ok(entry.lastUsedAt, 'lastUsedAt stamped on resolution');

    // Forged key: valid workspace segment, garbage random tail.
    const forged = `pk_${owner.workspaceId.replace(/-/g, '')}_forgedrandom123`;
    const forgedInit = await post('/widget/v1/visitor_init', {
      publicKey: forged,
      anonymousId: `pk-forged-${uniq()}`,
    });
    assert.equal(forgedInit.status, 404, 'forged key tail rejected');
    assert.equal(forgedInit.json.error.code, 'not_found');

    // Malformed key (wrong shape) and empty key (schema-level).
    const malformed = await post('/widget/v1/visitor_init', {
      publicKey: 'not-a-key',
      anonymousId: `pk-malformed-${uniq()}`,
    });
    assert.equal(malformed.status, 404, 'malformed key fails resolution');
    const empty = await post('/widget/v1/visitor_init', {
      publicKey: '',
      anonymousId: `pk-empty-${uniq()}`,
    });
    assert.equal(empty.status, 400, 'empty key fails schema validation');

    // Revoked key stops resolving.
    assert.equal((await del(`/v1/api-keys/${created.json.id}`, owner.accessToken)).status, 200);
    const revokedInit = await post('/widget/v1/visitor_init', {
      publicKey: key,
      anonymousId: `pk-revoked-${uniq()}`,
    });
    assert.equal(revokedInit.status, 404, 'revoked key rejected');
  });
});
