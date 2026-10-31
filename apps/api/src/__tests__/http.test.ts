import '../load-env.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import postgres from 'postgres';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { authenticator } from 'otplib';
import { AppModule } from '../app.module.js';
import { authService } from '../auth-service.js';
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
process.env.EMAIL_PROVIDER = 'console';

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
  opts: {
    body?: unknown;
    cookie?: string;
    bearer?: string;
    userAgent?: string;
    origin?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<HttpResult> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.userAgent ? { 'user-agent': opts.userAgent } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...opts.headers,
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

async function remove(path: string, bearer?: string): Promise<HttpResult> {
  const res = await fetch(base + path, {
    method: 'DELETE',
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

async function signup(
  label: string,
  enableTwoFactor = true,
): Promise<{ id: string; email: string; accessToken: string; cookie: string; refreshToken: string; totpSecret?: string }> {
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
      body: { email, password: 'correct-horse-battery', name: label, workspaceName: `${label} WS` },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(res.status, 200, `signup ${label} should succeed: ${JSON.stringify(res.json)}`);
  assert.equal(res.json.requiresEmailVerification, true);
  const verificationToken = loggedTokens[0];
  assert.ok(verificationToken, 'signup sent a verification link');
  const verified = await post('/v1/auth/verify-email', { body: { token: verificationToken } });
  assert.equal(verified.status, 200, 'verification link should verify the account');
  const login = await post('/v1/auth/login', {
    body: { email, password: 'correct-horse-battery' },
  });
  assert.equal(login.status, 200, `verified account should sign in: ${JSON.stringify(login.json)}`);
  const cookie = refreshCookie(login.setCookies);
  assert.ok(cookie, 'login must set the refresh cookie');
  assert.ok(login.json.refreshToken, 'login must return refreshToken in the body');
  let totpSecret: string | undefined;
  if (enableTwoFactor) {
    const setup = await post('/v1/auth/2fa/setup', { bearer: login.json.accessToken });
    assert.equal(setup.status, 200, `2FA setup should succeed: ${JSON.stringify(setup.json)}`);
    totpSecret = setup.json.secret as string;
    const enabled = await post('/v1/auth/2fa/verify', {
      bearer: login.json.accessToken,
      body: { code: authenticator.generate(totpSecret) },
    });
    assert.equal(enabled.status, 200, `2FA enrollment should succeed: ${JSON.stringify(enabled.json)}`);
  }
  return {
    id: login.json.user.id as string,
    email,
    accessToken: login.json.accessToken,
    cookie: `refresh_token=${cookie}`,
    refreshToken: login.json.refreshToken,
    totpSecret,
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
  // Keep helper-created test accounts from consuming the verification budget
  // needed by later cases in this shared-process HTTP suite.
  beforeEach(() => resetRateLimits());

  it('rate limits REST message sends to 30 requests per minute', async () => {
    const user = await signup('http-message-rate-limit');
    const conversationId = '00000000-0000-4000-8000-000000000001';
    const results = await Promise.all(
      Array.from({ length: 31 }, () =>
        post(`/v1/conversations/${conversationId}/messages`, {
          bearer: user.accessToken,
          body: {},
        }),
      ),
    );
    assert.equal(results.filter((result) => result.status === 429).length, 1);
  });

  it('approves dashboard QR sign-in once from an authenticated mobile session', async () => {
    const mobile = await signup('http-qr-login');
    const pollToken = 'A'.repeat(43);
    const started = await post('/v1/auth/qr/start', {
      body: { pollToken },
      origin: 'http://localhost:3000',
    });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    assert.match(started.json.challengeToken, /^[A-Za-z0-9_-]{43}$/);

    const blockedOrigin = await post('/v1/auth/qr/start', {
      body: { pollToken },
      origin: 'https://untrusted.example',
    });
    assert.equal(blockedOrigin.status, 403);

    const inspected = await post('/v1/auth/qr/inspect', {
      body: { challengeToken: started.json.challengeToken },
    });
    assert.equal(inspected.status, 200);
    assert.equal(inspected.json.status, 'pending');
    assert.equal(inspected.json.origin, 'http://localhost:3000');

    const anonymousApproval = await post('/v1/auth/qr/approve', {
      body: { challengeToken: started.json.challengeToken },
    });
    assert.equal(anonymousApproval.status, 401);

    const approval = await post('/v1/auth/qr/approve', {
      bearer: mobile.accessToken,
      body: { challengeToken: started.json.challengeToken },
    });
    assert.equal(approval.status, 200, JSON.stringify(approval.json));

    const wrongPollSecret = await post('/v1/auth/qr/poll', {
      body: { challengeToken: started.json.challengeToken, pollToken: 'B'.repeat(43) },
    });
    assert.equal(wrongPollSecret.status, 401);

    const completed = await post('/v1/auth/qr/poll', {
      body: { challengeToken: started.json.challengeToken, pollToken },
    });
    assert.equal(completed.status, 200, JSON.stringify(completed.json));
    assert.equal(completed.json.status, 'approved');
    assert.equal(completed.json.user.id, mobile.id);
    assert.notEqual(completed.json.accessToken, mobile.accessToken);
    assert.ok(completed.json.refreshToken);
    assert.ok(refreshCookie(completed.setCookies));

    const replay = await post('/v1/auth/qr/poll', {
      body: { challengeToken: started.json.challengeToken, pollToken },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.status, 'consumed');
    assert.equal(replay.json.accessToken, undefined);
  });

  it('registers push tokens only for the authenticated account that owns them', async () => {
    const first = await signup('http-push-token-first');
    const second = await signup('http-push-token-second');
    const token = `ExponentPushToken[${uniq()}]`;

    const registered = await post('/v1/notifications/push-token', {
      bearer: first.accessToken,
      body: { token },
    });
    assert.equal(registered.status, 200, JSON.stringify(registered.json));

    const duplicate = await post('/v1/notifications/push-token', {
      bearer: first.accessToken,
      body: { token },
    });
    assert.equal(duplicate.status, 200, 'registering the same device token is idempotent');

    const stolen = await post('/v1/notifications/push-token', {
      bearer: second.accessToken,
      body: { token },
    });
    assert.equal(stolen.status, 409, 'another account cannot claim an existing device token');

    const invalid = await post('/v1/notifications/push-token', {
      bearer: first.accessToken,
      body: { token: 'not-an-expo-token' },
    });
    assert.equal(invalid.status, 400);
  });

  it('requires email verification before a new account can sign in', async () => {
    const email = `unverified-${uniq()}@example.com`;
    createdEmails.push(email);
    const loggedTokens: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      const line = String(args[0] ?? '');
      if (line.startsWith('[email:verify]')) loggedTokens.push(line.split('-> ')[1]?.trim() ?? '');
      originalLog.apply(console, args as []);
    };
    let registration: HttpResult;
    try {
      registration = await post('/v1/auth/signup', {
        body: { email, password: 'correct-horse-battery', name: 'Unverified', workspaceName: 'Unverified WS' },
      });
    } finally {
      console.log = originalLog;
    }
    assert.equal(registration.status, 200);
    assert.deepEqual(registration.json, { requiresEmailVerification: true, email });
    assert.equal(refreshCookie(registration.setCookies), undefined);

    const blocked = await post('/v1/auth/login', {
      body: { email, password: 'correct-horse-battery' },
    });
    assert.equal(blocked.status, 403);
    assert.match(blocked.json.error.message, /verify your email/i);

    const verified = await post('/v1/auth/verify-email', {
      body: { token: loggedTokens[0] },
    });
    assert.equal(verified.status, 200);
    const login = await post('/v1/auth/login', {
      body: { email, password: 'correct-horse-battery' },
    });
    assert.equal(login.status, 200);
    assert.ok(login.json.accessToken);
  });

  it('records IP and device information when a password login creates a session', async () => {
    const user = await signup('http-session-metadata', false);
    const userAgent = 'QonviloSessionTest/1.0 (Windows; Desktop)';
    const login = await post('/v1/auth/login', {
      body: { email: user.email, password: 'correct-horse-battery' },
      userAgent,
      headers: {
        'x-vercel-ip-city': 'Toronto',
        'x-vercel-ip-country-region': 'Ontario',
        'x-vercel-ip-country': 'CA',
      },
    });
    assert.equal(login.status, 200, JSON.stringify(login.json));

    const sessions = await authService.listSessions(login.json.user.id, login.json.refreshToken);
    const current = sessions.find((session) => session.current);
    assert.ok(current, 'the newly created session is marked current');
    assert.equal(current.userAgent, userAgent);
    assert.ok(current.ip, 'the request IP is stored');
    assert.equal(current.location, 'Toronto, Ontario, CA');

    const skipped2fa = await post('/v1/auth/2fa/skip', { bearer: login.json.accessToken });
    assert.equal(skipped2fa.status, 200);
    const listed = await get('/v1/auth/sessions', skipped2fa.json.accessToken);
    assert.equal(listed.status, 200);
    assert.equal(listed.json.find((session: { current: boolean }) => session.current)?.id, current.id);

    const secondLogin = await post('/v1/auth/login', {
      body: { email: user.email, password: 'correct-horse-battery' },
      userAgent: 'QonviloSecondSession/1.0',
    });
    assert.equal(secondLogin.status, 200);
    const secondSkipped2fa = await post('/v1/auth/2fa/skip', { bearer: secondLogin.json.accessToken });
    assert.equal(secondSkipped2fa.status, 200);
    const activeBeforeLogout = await authService.listSessions(user.id, secondLogin.json.refreshToken);

    const loggedOut = await post('/v1/auth/logout-all', {
      bearer: secondSkipped2fa.json.accessToken,
      body: { refreshToken: secondLogin.json.refreshToken },
    });
    assert.equal(loggedOut.status, 200);
    assert.equal(loggedOut.json.revoked, activeBeforeLogout.length - 1, 'body refresh token preserves the mobile caller session');
    const remaining = await authService.listSessions(user.id, secondLogin.json.refreshToken);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.current, true);
  });

  it('uploads profile photos for the signed-in user and serves them as image bytes', async () => {
    const user = await signup('http-avatar-upload');
    const imageData = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9k=';
    const uploaded = await post('/v1/auth/profile/avatar', {
      bearer: user.accessToken,
      body: { mimeType: 'image/jpeg', imageData },
    });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.json));
    assert.match(uploaded.json.avatarUrl, new RegExp(`^/v1/auth/avatar/${user.id}\\?v=`));

    const photo = await fetch(`${base}${uploaded.json.avatarUrl}`);
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/jpeg');
    assert.equal(
      Buffer.from(await photo.arrayBuffer()).toString('base64'),
      imageData,
    );

    const forbiddenMime = await post('/v1/auth/profile/avatar', {
      bearer: user.accessToken,
      body: { mimeType: 'image/jpeg', imageData: Buffer.from('not an image').toString('base64') },
    });
    assert.equal(forbiddenMime.status, 400);
  });

  it('rejects existing unverified access tokens from protected routes', async () => {
    const email = `legacy-unverified-${uniq()}@example.com`;
    createdEmails.push(email);
    const legacySession = await authService.signup({
      email,
      password: 'correct-horse-battery',
      name: 'Legacy unverified',
      workspaceName: 'Legacy unverified WS',
    });
    const protectedResponse = await get('/v1/workspace', legacySession.accessToken);
    assert.equal(protectedResponse.status, 403);
    assert.match(protectedResponse.json.error.message, /verify your email/i);
  });

  it('forgot-password response does not reveal whether the email exists', async () => {
    const missingEmail = `missing-${uniq()}@example.com`;
    const missing = await post('/v1/auth/forgot-password', {
      body: { email: missingEmail },
    });
    assert.equal(missing.status, 202);
    assert.deepEqual(missing.json, { ok: true });

    const user = await signup('forgot-password');
    const found = await post('/v1/auth/forgot-password', {
      body: { email: user.email },
    });
    assert.equal(found.status, 202);
    assert.deepEqual(found.json, { ok: true });
  });

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

  it('mobile contract: body-borne refreshToken refreshes/rotates without cookies', async () => {
    const u = await signup('http-mob', false);

    // Refresh presents the token in the JSON body — no cookie involved.
    const rf = await post('/v1/auth/refresh', { body: { refreshToken: u.refreshToken } });
    assert.equal(rf.status, 200, `body refresh should succeed: ${JSON.stringify(rf.json)}`);
    assert.ok(rf.json.accessToken, 'new access token issued');
    assert.ok(rf.json.refreshToken, 'rotated token returned in body');
    assert.notEqual(rf.json.refreshToken, u.refreshToken, 'body token rotated');

    // Replaying the OLD body token hits the same reuse detection as cookies.
    const replay = await post('/v1/auth/refresh', { body: { refreshToken: u.refreshToken } });
    assert.equal(replay.status, 401, 'old body token replay rejected');

    // No token at all (no cookie, no body) -> 401, not a crash.
    const none = await post('/v1/auth/refresh');
    assert.equal(none.status, 401);

    // logout accepts the body token too — then the session is dead.
    const login = await post('/v1/auth/login', {
      body: { email: u.email, password: 'correct-horse-battery' },
    });
    assert.equal(login.status, 200, `login ok: ${JSON.stringify(login.json)}`);
    assert.ok(login.json.refreshToken, 'login returns refreshToken in body');
    const lo = await post('/v1/auth/logout', { body: { refreshToken: login.json.refreshToken } });
    assert.equal(lo.status, 200);
    const dead = await post('/v1/auth/refresh', { body: { refreshToken: login.json.refreshToken } });
    assert.equal(dead.status, 401, 'refresh after body-logout rejected');
  });

  it('2FA two-step login: requires2fa+tempToken, then verify completes anonymously', async () => {
    const u = await signup('http-2fa', false);

    // Enroll 2FA (Bearer-authenticated setup + confirm — web flow regression).
    const setup = await post('/v1/auth/2fa/setup', { bearer: u.accessToken });
    assert.equal(setup.status, 200, `setup ok: ${JSON.stringify(setup.json)}`);
    const secret = setup.json.secret as string;
    const enable = await post('/v1/auth/2fa/verify', {
      bearer: u.accessToken,
      body: { code: authenticator.generate(secret) },
    });
    assert.equal(enable.status, 200, `enrollment confirm ok: ${JSON.stringify(enable.json)}`);
    assert.ok(Array.isArray(enable.json.recoveryCodes), 'recovery codes returned once');

    // Step 1: login with password but no code -> challenge + tempToken.
    const need = await post('/v1/auth/login', {
      body: { email: u.email, password: 'correct-horse-battery' },
    });
    assert.equal(need.status, 200);
    assert.equal(need.json.requires2fa, true, '2FA challenge issued');
    assert.ok(need.json.tempToken, 'tempToken bridges to /2fa/verify');
    assert.equal(need.json.accessToken, undefined, 'no session before the second factor');

    // Wrong code fails; a valid TOTP completes WITHOUT any bearer/cookie.
    const bad = await post('/v1/auth/2fa/verify', {
      body: { code: '000000', tempToken: need.json.tempToken },
    });
    assert.equal(bad.status, 401, `wrong code rejected: ${JSON.stringify(bad.json)}`);
    assert.match(bad.json.error.message, /Invalid authentication code/);

    const done = await post('/v1/auth/2fa/verify', {
      body: { code: authenticator.generate(secret), tempToken: need.json.tempToken },
    });
    assert.equal(done.status, 200, `2FA completion ok: ${JSON.stringify(done.json)}`);
    assert.ok(done.json.accessToken, 'session issued');
    assert.ok(done.json.refreshToken, 'body refresh token issued');

    // Garbage tempToken -> 401 (verified before any DB work).
    const junk = await post('/v1/auth/2fa/verify', {
      body: { code: authenticator.generate(secret), tempToken: 'junk'.repeat(8) },
    });
    assert.equal(junk.status, 401);

    // tempToken must never work as an API bearer token (distinct audience).
    const sneaky = await get('/v1/auth/me', need.json.tempToken);
    assert.equal(sneaky.status, 401, 'tempToken rejected as access token');
  });

  it('requires 2FA before workspace access; skip is limited to the active sign-in session', async () => {
    const u = await signup('http-2fa-skip', false);
    const blocked = await get('/v1/auth/sessions', u.accessToken);
    assert.equal(blocked.status, 403);
    assert.match(blocked.json.error.message, /two-factor/i);

    const skipped = await post('/v1/auth/2fa/skip', { bearer: u.accessToken });
    assert.equal(skipped.status, 200, JSON.stringify(skipped.json));
    assert.equal(skipped.json.twoFactorSkipped, true);
    assert.equal((await get('/v1/auth/sessions', skipped.json.accessToken)).status, 200);

    const refreshed = await post('/v1/auth/refresh', {
      body: { refreshToken: u.refreshToken },
    });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.json.twoFactorSkipped, true);
    assert.equal((await get('/v1/auth/sessions', refreshed.json.accessToken)).status, 200);

    await post('/v1/auth/logout', { body: { refreshToken: refreshed.json.refreshToken } });
    const nextLogin = await post('/v1/auth/login', {
      body: { email: u.email, password: 'correct-horse-battery' },
    });
    assert.equal(nextLogin.status, 200);
    assert.equal(nextLogin.json.twoFactorSkipped, undefined);
    assert.equal((await get('/v1/auth/sessions', nextLogin.json.accessToken)).status, 403);
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

  it('member removal revokes workspace sessions and blocks existing access tokens', async () => {
    const owner = await signup('http-remove-owner');
    const member = await signup('http-remove-member');
    const [ownerMembership] = await boot`
      SELECT workspace_id FROM memberships WHERE user_id = ${owner.id}::uuid
    `;
    assert.ok(ownerMembership?.workspace_id, 'owner workspace exists');

    await boot`INSERT INTO memberships (workspace_id, user_id, role)
      VALUES (${ownerMembership.workspace_id}::uuid, ${member.id}::uuid, 'agent')
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'agent'`;
    await boot`UPDATE refresh_tokens SET workspace_id = ${ownerMembership.workspace_id}::uuid
      WHERE user_id = ${member.id}::uuid AND revoked_at IS NULL`;

    const memberSession = await authService.refresh(member.refreshToken);
    assert.equal(memberSession.workspaceId, ownerMembership.workspace_id);
    assert.equal(memberSession.role, 'agent');

    const removed = await remove(`/v1/members/${member.id}`, owner.accessToken);
    assert.equal(removed.status, 200, JSON.stringify(removed.json));

    const denied = await get('/v1/members', memberSession.accessToken);
    assert.equal(denied.status, 403);
    const rejectedRefresh = await post('/v1/auth/refresh', {
      body: { refreshToken: memberSession.refreshToken },
    });
    assert.equal(rejectedRefresh.status, 401);
  });

  it('CapabilityGuard denies the agent (403) but allows workspace:read', async () => {
    const b = await signup('http-agent');
    // Demote the member to agent directly (simulates an accepted agent invite
    // / role change), then re-login so the JWT carries role=agent.
    await boot`UPDATE memberships SET role = 'agent'
               WHERE user_id = (SELECT id FROM users WHERE email = ${b.email}::citext)`;
    const login = await post('/v1/auth/login', {
      body: {
        email: b.email,
        password: 'correct-horse-battery',
        totpCode: authenticator.generate(b.totpSecret!),
      },
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
    const setup = await post('/v1/auth/2fa/setup', { bearer: accept.json.accessToken });
    assert.equal(setup.status, 200, `invitee 2FA setup should succeed: ${JSON.stringify(setup.json)}`);
    const enabled = await post('/v1/auth/2fa/verify', {
      bearer: accept.json.accessToken,
      body: { code: authenticator.generate(setup.json.secret) },
    });
    assert.equal(enabled.status, 200, 'invitee should enable required 2FA before workspace access');

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
      body: {
        email: existing.email,
        password: 'correct-horse-battery',
        totpCode: authenticator.generate(existing.totpSecret!),
      },
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

// ---------------------------------------------------------------------------
// E.2 audit regression — signup/login/2FA/logout-all MUST leave a trail.
// The FK-bug class this guards: the audit row must insert AFTER the workspace
// commit; if anyone moves recordAuditFor back pre-commit the insert fails
// (silently in fire-and-forget) and these assertions stop seeing entries.
// ---------------------------------------------------------------------------

describe('HTTP audit trail (E.2 regression)', () => {
  before(() => resetRateLimits());

  /** recordAuditFor is fire-and-forget — poll briefly until the row lands. */
  async function waitForAudit(accessToken: string, action: string, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let seen: any[] = [];
    while (Date.now() < deadline) {
      const res = await get('/v1/audit-logs?limit=500', accessToken);
      if (res.status === 200 && Array.isArray(res.json)) {
        seen = res.json;
        const hit = seen.find((e) => e.action === action);
        if (hit) return hit;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.fail(
      `audit entry "${action}" never appeared; saw: ${JSON.stringify(seen.map((e) => e.action))}`,
    );
  }

  it('signup leaves auth.signup, workspace-scoped to the new workspace', async () => {
    const { accessToken, email } = await signup('auditsignup');
    const entry = await waitForAudit(accessToken, 'auth.signup');
    assert.equal(entry.target, email, 'audit target is the signed-up email');

    const me = await get('/v1/auth/me', accessToken);
    assert.equal(me.status, 200);
    assert.equal(entry.actorId, me.json.userId, 'audit actor is the new user');
    // The /v1/audit-logs query is RLS-scoped to the token's workspace, so a
    // row visible here necessarily carries workspaceId == token workspace.
  });

  it('login leaves auth.login', async () => {
    const { accessToken, email, totpSecret } = await signup('auditlogin');
    await waitForAudit(accessToken, 'auth.signup');

    const login = await post('/v1/auth/login', {
      body: {
        email,
        password: 'correct-horse-battery',
        totpCode: authenticator.generate(totpSecret!),
      },
    });
    assert.equal(login.status, 200, JSON.stringify(login.json));
    const entry = await waitForAudit(login.json.accessToken, 'auth.login');
    assert.equal(entry.target, email);
    assert.ok(entry.ip, 'login audit captures the caller IP');
  });

  it('2FA enable + disable leave 2fa.enabled / 2fa.disabled', async () => {
    const { accessToken } = await signup('audittwofa', false);
    const setup = await post('/v1/auth/2fa/setup', { bearer: accessToken });
    assert.equal(setup.status, 200, JSON.stringify(setup.json));

    const code = authenticator.generate(setup.json.secret);
    const enable = await post('/v1/auth/2fa/verify', { bearer: accessToken, body: { code } });
    assert.equal(enable.status, 200, JSON.stringify(enable.json));
    await waitForAudit(accessToken, '2fa.enabled');

    // Recovery code is one-time and valid for disable — no same-window TOTP reuse.
    const disable = await post('/v1/auth/2fa/disable', {
      bearer: accessToken,
      body: { password: 'correct-horse-battery', code: enable.json.recoveryCodes[0] },
    });
    assert.equal(disable.status, 200, JSON.stringify(disable.json));
    const skip = await post('/v1/auth/2fa/skip', { bearer: accessToken });
    assert.equal(skip.status, 200, JSON.stringify(skip.json));
    await waitForAudit(accessToken, '2fa.disabled');
  });

  it('logout-all leaves sessions.revoked_all', async () => {
    const { accessToken } = await signup('auditlogout');
    await waitForAudit(accessToken, 'auth.signup');

    const out = await post('/v1/auth/logout-all', { bearer: accessToken });
    assert.equal(out.status, 200, JSON.stringify(out.json));
    const entry = await waitForAudit(accessToken, 'sessions.revoked_all');
    assert.ok('revoked' in (entry.meta ?? {}) || entry, 'entry recorded');
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
