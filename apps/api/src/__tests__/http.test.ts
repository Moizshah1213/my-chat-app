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
 * HTTP-level tests (blueprint §8.9): boots the REAL Nest app (controllers,
 * global AuthGuard + CapabilityGuard, exception filter) on an ephemeral port
 * and exercises it with fetch against the TEST database.
 *
 * Covers: session lifecycle (cookie refresh rotation, reuse detection,
 * server-side logout revocation) and RBAC (401 unauthenticated, 403 denied,
 * 200 allowed per role).
 */

// Route all app-layer DB access to the TEST database for this process.
// Must happen before any request is served (services read it at call time).
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;

const BOOT_URL = process.env.BOOTSTRAP_DATABASE_URL!.replace(/\/[^/]+$/, '/livechat_test');
let boot: ReturnType<typeof postgres>;
let app: NestExpressApplication;
let base = '';
const createdEmails: string[] = [];

const uniq = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

interface HttpResult {
  status: number;
  json: any;
  setCookies: string[];
}

async function post(
  path: string,
  opts: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<HttpResult> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  const raw = (res.headers as any).getSetCookie?.() ?? [res.headers.get('set-cookie')];
  return { status: res.status, json, setCookies: raw.filter(Boolean) as string[] };
}

async function get(path: string, bearer?: string): Promise<HttpResult> {
  const res = await fetch(base + path, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json, setCookies: [] };
}

/** Extract the refresh_token value from Set-Cookie headers. */
function refreshCookie(setCookies: string[]): string | undefined {
  for (const c of setCookies) {
    const m = /refresh_token=([^;]+)/.exec(c);
    if (m) return m[1];
  }
  return undefined;
}

async function signup(label: string): Promise<{ email: string; accessToken: string; cookie: string }> {
  const email = `${label}-${uniq()}@example.com`;
  createdEmails.push(email);
  const res = await post('/v1/auth/signup', {
    body: { email, password: 'correct-horse-battery', name: label, workspaceName: `${label} WS` },
  });
  assert.equal(res.status, 200, `signup ${label} should succeed: ${JSON.stringify(res.json)}`);
  const cookie = refreshCookie(res.setCookies);
  assert.ok(cookie, 'signup must set the refresh cookie');
  return { email, accessToken: res.json.accessToken, cookie: `refresh_token=${cookie}` };
}

before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must be set');
  boot = postgres(BOOT_URL, { max: 1, onnotice: () => {} });

  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error'] });
  app.use(cookieParser());
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (app) await app.close();
  if (boot) {
    for (const email of createdEmails) {
      await boot`DELETE FROM users WHERE email = ${email}::citext`;
    }
    await boot.end();
  }
  await closeDb();
});

describe('HTTP session lifecycle', () => {
  // The rate limiter is in-process state shared across the whole file; reset
  // per suite so the ip-keyed signup budget (10/min) never bleeds between them.
  before(() => resetRateLimits());

  it('signup -> refresh rotates the cookie; reusing the old cookie is rejected', async () => {
    const u = await signup('http-rot');

    const rf = await post('/v1/auth/refresh', { cookie: u.cookie });
    assert.equal(rf.status, 200, `refresh should succeed: ${JSON.stringify(rf.json)}`);
    assert.ok(rf.json.accessToken, 'new access token issued');
    const newCookie = refreshCookie(rf.setCookies);
    assert.ok(newCookie, 'refresh sets a rotated cookie');
    assert.notEqual(newCookie, u.cookie.replace('refresh_token=', ''), 'cookie value rotated');

    // Replaying the OLD cookie must hit reuse detection -> 401.
    const replay = await post('/v1/auth/refresh', { cookie: u.cookie });
    assert.equal(replay.status, 401, 'old cookie replay must be rejected');
    assert.match(replay.json.error.message, /reuse detected|Invalid/);
  });

  it('logout revokes the session server-side (cookie alone is not enough)', async () => {
    const u = await signup('http-logout');

    const lo = await post('/v1/auth/logout', { cookie: u.cookie });
    assert.equal(lo.status, 200, 'logout succeeds');

    // Even replaying the same cookie now fails: the family was revoked.
    const rf = await post('/v1/auth/refresh', { cookie: u.cookie });
    assert.equal(rf.status, 401, 'refresh after logout must be rejected');
    assert.match(rf.json.error.code, /invalid_credentials|unauthenticated/);
    assert.match(rf.json.error.message, /reuse detected|Invalid|revoked/);

    // Idempotent: logout without any cookie still returns ok.
    const lo2 = await post('/v1/auth/logout');
    assert.equal(lo2.status, 200, 'logout is idempotent');
    assert.equal(lo2.json.ok, true);
  });

  it('bad credentials return 401 invalid_credentials (no enumeration)', async () => {
    const res = await post('/v1/auth/login', {
      body: { email: `ghost-${uniq()}@example.com`, password: 'definitely-wrong-1' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.json.error.code, 'invalid_credentials');
  });
});

describe('HTTP auth + RBAC enforcement', () => {
  before(() => resetRateLimits());

  it('protected routes return 401 without a token; 200 for the owner', async () => {
    const anon = await get('/v1/members');
    assert.equal(anon.status, 401);
    assert.equal(anon.json.error.code, 'unauthenticated');

    const owner = await signup('http-owner');
    const ok = await get('/v1/members', owner.accessToken);
    assert.equal(ok.status, 200, `owner may read members: ${JSON.stringify(ok.json)}`);
    assert.ok(Array.isArray(ok.json));
    assert.equal(ok.json[0].role, 'owner');
  });

  it('CapabilityGuard denies the agent (403) but allows workspace:read', async () => {
    const b = await signup('http-agent');
    // Demote the member to agent directly (simulates an accepted agent invite
    // / role change), then re-login so the JWT carries role=agent.
    await boot`UPDATE memberships SET role = 'agent'
               WHERE user_id = (SELECT id FROM users WHERE email = ${b.email}::citext)`;
    const login = await post('/v1/auth/login', {
      body: { email: b.email, password: 'correct-horse-battery' },
    });
    assert.equal(login.status, 200);
    assert.equal(login.json.role, 'agent', 'JWT now carries role=agent');
    const agentTok = login.json.accessToken as string;

    // members:read is denied for agents -> 403 with our error shape.
    const denied = await get('/v1/members', agentTok);
    assert.equal(denied.status, 403, `agent must not list members: ${JSON.stringify(denied.json)}`);
    assert.equal(denied.json.error.code, 'forbidden');

    // members:invite likewise denied; no bearer at all -> 401 first.
    const noAuth = await post('/v1/invitations', {
      body: { email: `nope-${uniq()}@example.com`, role: 'agent' },
    });
    assert.equal(noAuth.status, 401);
    const inv = await post('/v1/invitations', {
      bearer: agentTok,
      body: { email: `nope-${uniq()}@example.com`, role: 'agent' },
    });
    assert.equal(inv.status, 403, 'agent must not invite members');
    assert.equal(inv.json.error.code, 'forbidden');

    // workspace:read IS allowed for agents.
    const ws = await get('/v1/workspace', agentTok);
    assert.equal(ws.status, 200, `agent may read workspace: ${JSON.stringify(ws.json)}`);
    assert.equal(ws.json.name, 'http-agent WS');
  });

  it('a token from workspace A never exposes workspace B rows over HTTP', async () => {
    const a = await signup('http-iso-a');
    const b = await signup('http-iso-b');

    const meA = await get('/v1/auth/me', a.accessToken);
    const meB = await get('/v1/auth/me', b.accessToken);
    assert.notEqual(meA.json.workspaceId, meB.json.workspaceId, 'distinct workspaces');

    const membersA = await get('/v1/members', a.accessToken);
    const membersB = await get('/v1/members', b.accessToken);
    assert.equal(membersA.status, 200);
    assert.equal(membersB.status, 200);
    // Each owner sees exactly one member — themselves. No cross-tenant leakage.
    assert.equal(membersA.json.length, 1);
    assert.equal(membersB.json.length, 1);
    assert.equal(membersA.json[0].userId, meA.json.userId, 'A sees only A');
    assert.equal(membersB.json[0].userId, meB.json.userId, 'B sees only B');
    assert.notEqual(membersA.json[0].userId, membersB.json[0].userId, 'no cross-tenant members');
  });
});

describe('HTTP invitation accept flow', () => {
  before(() => resetRateLimits());

  it('public preview + public accept creates the account and joins the workspace', async () => {
    const owner = await signup('inv-owner');
    const invitee = `inv-joiner-${uniq()}@example.com`;
    createdEmails.push(invitee);

    const inv = await post('/v1/invitations', {
      bearer: owner.accessToken,
      body: { email: invitee, role: 'agent' },
    });
    assert.equal(inv.status, 201, `invite created: ${JSON.stringify(inv.json)}`);
    const token = inv.json.token as string;
    assert.ok(token, 'raw invite token returned (dev stand-in for the emailed link)');

    // Public preview: no auth needed, token is the capability.
    const preview = await get(`/v1/invitations/${token}`);
    assert.equal(preview.status, 200, `preview works: ${JSON.stringify(preview.json)}`);
    assert.equal(preview.json.email, invitee);
    assert.equal(preview.json.role, 'agent');
    assert.equal(preview.json.workspaceName, 'inv-owner WS');

    // Public accept WITHOUT an account: name+password create it.
    const accept = await post('/v1/invitations/accept', {
      body: { token, name: 'Joiner', password: 'correct-horse-battery' },
    });
    assert.equal(accept.status, 200, `accept succeeds: ${JSON.stringify(accept.json)}`);
    assert.equal(accept.json.role, 'agent');
    assert.ok(accept.json.accessToken, 'session issued on accept');
    const cookie = refreshCookie(accept.setCookies);
    assert.ok(cookie, 'refresh cookie set on accept');

    // The new agent's session is scoped to the OWNER's workspace.
    const ws = await get('/v1/workspace', accept.json.accessToken);
    assert.equal(ws.status, 200, `agent may read the workspace: ${JSON.stringify(ws.json)}`);
    assert.equal(ws.json.name, 'inv-owner WS');
    // ...and RBAC still applies to the new role.
    const members = await get('/v1/members', accept.json.accessToken);
    assert.equal(members.status, 403, 'agent must not list members');

    // Single use: the token cannot be replayed.
    const replay = await post('/v1/invitations/accept', {
      body: { token, name: 'Again', password: 'correct-horse-battery' },
    });
    assert.equal(replay.status, 404, 'consumed token is dead');
    assert.equal(replay.json.error.code, 'not_found');
  });

  it('existing users accept signed in as themselves; never as someone else', async () => {
    const ownerA = await signup('inv-owner2');
    const existing = await signup('inv-existing'); // has its own workspace already
    const existingLogin = await post('/v1/auth/login', {
      body: { email: existing.email, password: 'correct-horse-battery' },
    });
    assert.equal(existingLogin.status, 200);
    const existingTok = existingLogin.json.accessToken as string;
    const meA = await get('/v1/auth/me', ownerA.accessToken);
    const ownerAWsId = meA.json.workspaceId as string;

    const inv = await post('/v1/invitations', {
      bearer: ownerA.accessToken,
      body: { email: existing.email, role: 'agent' },
    });
    assert.equal(inv.status, 201);
    const token = inv.json.token as string;

    // Anonymous accept of an EXISTING account -> 401 (sign in first).
    const anon = await post('/v1/invitations/accept', { body: { token } });
    assert.equal(anon.status, 401, 'cannot accept an existing account anonymously');
    assert.equal(anon.json.error.code, 'unauthenticated');

    // Signed in as the WRONG user -> 403 (no account takeover via invite token).
    const wrong = await post('/v1/invitations/accept', {
      bearer: ownerA.accessToken,
      body: { token },
    });
    assert.equal(wrong.status, 403, "a token can't attach an invitation to another user's account");
    assert.equal(wrong.json.error.code, 'forbidden');

    // Signed in as the invitee -> joins workspace A as agent.
    const ok = await post('/v1/invitations/accept', { bearer: existingTok, body: { token } });
    assert.equal(ok.status, 200, `invitee accepts: ${JSON.stringify(ok.json)}`);
    assert.equal(ok.json.role, 'agent');
    assert.equal(ok.json.workspaceId, ownerAWsId, 'session scoped to the JOINED workspace');
    const ws = await get('/v1/workspace', ok.json.accessToken);
    assert.equal(ws.json.name, 'inv-owner2 WS', 'agent session reads the joined workspace');
  });

  it('verify-email rejects garbage tokens; resend-verification never enumerates', async () => {
    const bad = await post('/v1/auth/verify-email', { body: { token: 'a'.repeat(43) } });
    assert.equal(bad.status, 400, `garbage token rejected: ${JSON.stringify(bad.json)}`);
    assert.equal(bad.json.error.code, 'validation_failed');

    const resend = await post('/v1/auth/resend-verification', {
      body: { email: `nobody-${uniq()}@example.com` },
    });
    assert.equal(resend.status, 202, 'resend never enumerates accounts');
    assert.equal(resend.json.ok, true);
  });
});

describe('HTTP rate limiting', () => {
  before(() => resetRateLimits());

  it('login is limited per (IP+email): 429 after 10 failures, other emails unaffected', async () => {
    const email = `ratelimit-${uniq()}@example.com`;

    for (let i = 0; i < 10; i++) {
      const res = await post('/v1/auth/login', {
        body: { email, password: `wrong-password-${i}` },
      });
      assert.equal(res.status, 401, `attempt ${i + 1} should be invalid_credentials`);
      assert.equal(res.json.error.code, 'invalid_credentials');
    }

    const limited = await post('/v1/auth/login', {
      body: { email, password: 'wrong-again' },
    });
    assert.equal(limited.status, 429, `11th attempt must be throttled: ${JSON.stringify(limited.json)}`);
    assert.equal(limited.json.error.code, 'rate_limited');

    // The bucket is keyed by (IP, route, email): a different account is NOT blocked.
    const other = await post('/v1/auth/login', {
      body: { email: `other-${uniq()}@example.com`, password: 'still-wrong-1' },
    });
    assert.equal(other.status, 401, 'other emails still get real auth, not a blanket 429');
    assert.equal(other.json.error.code, 'invalid_credentials');
  });

  it('forgot-password is limited per (IP+email) after 5 requests', async () => {
    const email = `fp-${uniq()}@example.com`;
    for (let i = 0; i < 5; i++) {
      const res = await post('/v1/auth/forgot-password', { body: { email } });
      assert.equal(res.status, 202, `request ${i + 1} accepted`);
    }
    const limited = await post('/v1/auth/forgot-password', { body: { email } });
    assert.equal(limited.status, 429, '6th forgot-password throttled');
    assert.equal(limited.json.error.code, 'rate_limited');
  });
});
