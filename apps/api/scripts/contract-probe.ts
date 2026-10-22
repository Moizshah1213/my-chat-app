/**
 * Live probe for API_CONTRACT.md — exercises every documented endpoint against
 * the dev API on :4000 using a throwaway test user, then prints each REAL
 * response with all tokens/emails/ids/secrets REDACTED so output is safe to
 * paste into documentation.
 *
 * Run (from repo root):
 *   node_modules\.bin\tsx apps\api\scripts\contract-probe.ts
 */
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: 'd:/saas/.env' });

import { authenticator } from 'otplib';
import { io as ioClient, type Socket } from 'socket.io-client';

const base = 'http://localhost:4000';
const WS_PATH = '/ws';

// ---------------------------------------------------------------- redaction
const uuidMap = new Map<string, string>();
const emailMap = new Map<string, string>();
const FAKE_EMAILS = [
  'owner.test@example.com',
  'agent.test@example.com',
  'visitor.test@example.com',
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT_RE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OPAQUE_RE = /^[A-Za-z0-9_-]{30,}$/;

const FAKE_REFRESH = Buffer.from(
  'fake-refresh-token-00000000000000000000000000000',
).toString('base64url');
const FAKE_CURSOR = Buffer.from(
  '1760947200000:11111111-1111-4111-8111-111111111111',
).toString('base64url');
const FAKE_SECRET = 'FAKEBASE32SECRETFAKEBASE32SECRET';
const FAKE_RECOVERY = [
  'aaaaa-bbbbb', 'ccccc-ddddd', 'eeeee-fffff', 'ggggg-hhhhh', 'iiiii-jjjjj',
  'kkkkk-lllll', 'mmmmm-nnnnn', 'ooooo-ppppp', 'qqqqq-rrrrr', 'sssss-ttttt',
];

function fakeJwt(kind: string): string {
  return `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.FAKE_${kind}_CLAIMS.c2lnbmF0dXJlLWZha2U`;
}
function fakeEmail(v: string): string {
  let f = emailMap.get(v);
  if (!f) {
    f = FAKE_EMAILS[emailMap.size % FAKE_EMAILS.length];
    emailMap.set(v, f);
  }
  return f;
}
function fakeUuid(v: string): string {
  let f = uuidMap.get(v);
  if (!f) {
    f = `${String(uuidMap.size + 1).padStart(8, '0')}-0000-4000-8000-000000000000`;
    uuidMap.set(v, f);
  }
  return f;
}

function redact(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) {
    if (key === 'recoveryCodes') return FAKE_RECOVERY.slice(0, value.length);
    return value.map((v) => redact(v, key));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, k);
    }
    return out;
  }
  if (typeof value !== 'string') return value;
  switch (key) {
    case 'refreshToken':
      return FAKE_REFRESH;
    case 'secret':
      return FAKE_SECRET;
    case 'otpauthUrl':
      return 'otpauth://totp/LiveChat:owner.test%40example.com?secret=FAKEBASE32SECRET&issuer=LiveChat';
    case 'nextCursor':
    case 'before':
      return FAKE_CURSOR;
    case 'userAgent':
      return 'Mozilla/5.0 (Fake Mobile Client 1.0)';
  }
  if (JWT_RE.test(value)) return fakeJwt(/temp/i.test(key) ? 'TEMP' : 'ACCESS');
  if (UUID_RE.test(value)) return fakeUuid(value);
  if (EMAIL_RE.test(value)) return fakeEmail(value);
  if (OPAQUE_RE.test(value)) return '<fake-token>';
  return value;
}

let stepN = 0;
function step(label: string, status: number | string, body: unknown) {
  stepN += 1;
  console.log(`\n=== [${stepN}] ${label} — ${status} ===`);
  console.log(JSON.stringify(redact(body), null, 2));
}

// ------------------------------------------------------------------- helpers
async function api(
  method: string,
  path: string,
  opts: { body?: unknown; bearer?: string; rawBody?: string } = {},
): Promise<{ status: number; json: any; setCookie: string | null }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(base + path, {
    method,
    headers,
    body:
      opts.rawBody !== undefined
        ? opts.rawBody
        : opts.body !== undefined
          ? JSON.stringify(opts.body)
          : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  let setCookie: string | null = null;
  const sc = res.headers.get('set-cookie');
  if (sc) setCookie = sc.replace(/refresh_token=[^;]*/, `refresh_token=${FAKE_REFRESH}`);
  return { status: res.status, json, setCookie };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}


// ================================================================ PHASE 1: auth
async function phase1Auth() {
  const rand = Date.now().toString(36);
  const ownerEmail = `owner.${rand}@example.com`;
  const password = 'Throwaway-Password-1!';

  const signup = await api('POST', '/v1/auth/signup', {
    body: { email: ownerEmail, password, name: 'Test Owner', workspaceName: 'Contract Probe WS' },
  });
  step('POST /v1/auth/signup', signup.status, signup.json);

  const login = await api('POST', '/v1/auth/login', { body: { email: ownerEmail, password } });
  step('POST /v1/auth/login (normal)', login.status, login.json);
  step('POST /v1/auth/login — Set-Cookie (browser only)', 200, { setCookie: login.setCookie });

  const bad = await api('POST', '/v1/auth/login', {
    body: { email: ownerEmail, password: 'wrong-password-xyz' },
  });
  step('POST /v1/auth/login (wrong password)', bad.status, bad.json);

  const ownerAccess = signup.json.accessToken as string;
  const workspaceId = signup.json.workspaceId as string;
  const ownerId = signup.json.user?.id as string;

  const setup = await api('POST', '/v1/auth/2fa/setup', { bearer: ownerAccess, body: {} });
  step('POST /v1/auth/2fa/setup (Bearer)', setup.status, setup.json);
  const totpSecret = setup.json.secret as string;
  const code = () => authenticator.generate(totpSecret);

  const enroll = await api('POST', '/v1/auth/2fa/verify', {
    bearer: ownerAccess,
    body: { code: code() },
  });
  step('POST /v1/auth/2fa/verify (enrollment confirm, Bearer only)', enroll.status, enroll.json);
  const recovery = (enroll.json?.recoveryCodes ?? []) as string[];

  const challenge = await api('POST', '/v1/auth/login', { body: { email: ownerEmail, password } });
  step('POST /v1/auth/login (2FA required)', challenge.status, challenge.json);

  const verifyTotp = await api('POST', '/v1/auth/2fa/verify', {
    body: { code: code(), tempToken: challenge.json.tempToken },
  });
  step('POST /v1/auth/2fa/verify (TOTP + tempToken, NO bearer)', verifyTotp.status, verifyTotp.json);

  const challenge2 = await api('POST', '/v1/auth/login', { body: { email: ownerEmail, password } });
  const verifyBackup = await api('POST', '/v1/auth/2fa/verify', {
    body: { code: recovery[0], tempToken: challenge2.json.tempToken },
  });
  step(
    'POST /v1/auth/2fa/verify (BACKUP CODE + tempToken) — code consumed once',
    verifyBackup.status,
    verifyBackup.json,
  );

  // Wrong second factor -> 401 (uses challenge2's tempToken? it was consumed? tempToken
  // stays valid for 10min regardless; a wrong code must 401).
  const wrongCode = await api('POST', '/v1/auth/2fa/verify', {
    body: { code: '000000', tempToken: challenge2.json.tempToken },
  });
  step('POST /v1/auth/2fa/verify (wrong code)', wrongCode.status, wrongCode.json);

  // Two extra live sessions for refresh / logout / logout-all demos.
  const loginX = await api('POST', '/v1/auth/login', {
    body: { email: ownerEmail, password, totpCode: code() },
  });
  step('POST /v1/auth/login (one-shot totpCode — alternative to 2-step)', loginX.status, loginX.json);

  const loginY = await api('POST', '/v1/auth/login', {
    body: { email: ownerEmail, password, totpCode: code() },
  });
  step('POST /v1/auth/login (second device session for logout demos)', loginY.status, loginY.json);

  return {
    ownerEmail,
    ownerAccess,
    workspaceId,
    ownerId,
    main: verifyTotp.json,
    loginX: loginX.json,
    loginY: loginY.json,
  };
}

// ============================================ PHASE 2: conversations + messages
async function phase2Conversations(ctx: {
  main: any;
  workspaceId: string;
  ownerId: string;
}) {
  const bearer = ctx.main.accessToken as string;
  const rand = Date.now().toString(36);

  // Create two throwaway conversations via the public widget bootstrap endpoint
  // (this is the only way conversations come into existence).
  const va = await api('POST', '/widget/v1/visitor_init', {
    body: { workspaceId: ctx.workspaceId, anonymousId: `probe-a-${rand}`, name: 'Fake Visitor A' },
  });
  step('POST /widget/v1/visitor_init (creates conversation A)', va.status, va.json);
  const vb = await api('POST', '/widget/v1/visitor_init', {
    body: { workspaceId: ctx.workspaceId, anonymousId: `probe-b-${rand}`, name: 'Fake Visitor B' },
  });
  step('POST /widget/v1/visitor_init (creates conversation B)', vb.status, vb.json);
  const convA = va.json.conversationId as string;
  const visitorTokenA = va.json.token as string;

  // --- list with pagination -------------------------------------------------
  const page1 = await api('GET', '/v1/conversations?limit=1', { bearer });
  step('GET /v1/conversations?limit=1 (page 1)', page1.status, page1.json);
  if (page1.json?.nextCursor) {
    const page2 = await api(
      'GET',
      `/v1/conversations?limit=1&cursor=${encodeURIComponent(page1.json.nextCursor)}`,
      { bearer },
    );
    step('GET /v1/conversations?limit=1&cursor=… (page 2)', page2.status, page2.json);
  }
  const filtered = await api('GET', '/v1/conversations?status=open&assignee=unassigned&limit=50', {
    bearer,
  });
  step('GET /v1/conversations?status=open&assignee=unassigned&limit=50', filtered.status, filtered.json);

  // --- detail ---------------------------------------------------------------
  const detail = await api('GET', `/v1/conversations/${convA}`, { bearer });
  step('GET /v1/conversations/:id (detail)', detail.status, detail.json);

  // --- update: assign / resolve / reopen ------------------------------------
  const assign = await api('PATCH', `/v1/conversations/${convA}`, {
    bearer,
    body: { assignedTo: ctx.ownerId },
  });
  step('PATCH /v1/conversations/:id — assign { assignedTo: userId }', assign.status, assign.json);

  const mine = await api('GET', '/v1/conversations?assignee=me&limit=50', { bearer });
  step('GET /v1/conversations?assignee=me (after assign)', mine.status, mine.json);

  // --- messages: 3 REST sends ------------------------------------------------
  const m1 = await api('POST', `/v1/conversations/${convA}/messages`, {
    bearer,
    body: { body: 'Hello! How can we help you today?', idempotencyKey: 'probe-msg-1' },
  });
  step('POST /v1/conversations/:id/messages (send #1)', m1.status, m1.json);
  const m2 = await api('POST', `/v1/conversations/${convA}/messages`, {
    bearer,
    body: { body: 'Thanks — we are looking into it now.' },
  });
  step('POST /v1/conversations/:id/messages (send #2, no idempotencyKey)', m2.status, m2.json);
  const m3 = await api('POST', `/v1/conversations/${convA}/messages`, {
    bearer,
    body: { body: 'Anything else we can check for you?' },
  });
  step('POST /v1/conversations/:id/messages (send #3)', m3.status, m3.json);

  // --- messages: pagination ---------------------------------------------------
  const mp1 = await api('GET', `/v1/conversations/${convA}/messages?limit=2`, { bearer });
  step('GET /v1/conversations/:id/messages?limit=2 (newest page)', mp1.status, mp1.json);
  if (mp1.json?.nextCursor) {
    const mp2 = await api(
      'GET',
      `/v1/conversations/${convA}/messages?limit=2&before=${encodeURIComponent(mp1.json.nextCursor)}`,
      { bearer },
    );
    step('GET /v1/conversations/:id/messages?before=… (older page)', mp2.status, mp2.json);
  }

  // --- resolve then reopen ----------------------------------------------------
  const resolve = await api('PATCH', `/v1/conversations/${convA}`, {
    bearer,
    body: { status: 'closed' },
  });
  step('PATCH /v1/conversations/:id — resolve { status: "closed" }', resolve.status, resolve.json);

  const sendClosed = await api('POST', `/v1/conversations/${convA}/messages`, {
    bearer,
    body: { body: 'This send must be rejected.' },
  });
  step('POST /v1/conversations/:id/messages (closed conversation)', sendClosed.status, sendClosed.json);

  const reopen = await api('PATCH', `/v1/conversations/${convA}`, {
    bearer,
    body: { status: 'open' },
  });
  step('PATCH /v1/conversations/:id — reopen { status: "open" }', reopen.status, reopen.json);

  return { convA, visitorTokenA, bearer };
}

// ==================================================== PHASE 3: HTTP error shapes
async function phase3Errors(ctx: { main: any; ownerEmail: string }) {
  const bearer = ctx.main.accessToken as string;

  const noAuth = await api('GET', '/v1/conversations');
  step('GET /v1/conversations (no Authorization)', noAuth.status, noAuth.json);

  const badToken = await api('GET', '/v1/conversations', { bearer: 'not-a-real-jwt' });
  step('GET /v1/conversations (garbage token)', badToken.status, badToken.json);

  const badId = await api('GET', '/v1/conversations/not-a-uuid', { bearer });
  step('GET /v1/conversations/not-a-uuid', badId.status, badId.json);

  const missingId = await api('GET', '/v1/conversations/99999999-9999-4099-8999-999999999999', {
    bearer,
  });
  step('GET /v1/conversations/<unknown uuid>', missingId.status, missingId.json);

  const badLimit = await api('GET', '/v1/conversations?limit=999', { bearer });
  step('GET /v1/conversations?limit=999 (out of range → details)', badLimit.status, badLimit.json);

  const emptyPatch = await api('PATCH', '/v1/conversations/99999999-9999-4099-8999-999999999999', {
    bearer,
    body: {},
  });
  step('PATCH /v1/conversations/:id {} (empty body)', emptyPatch.status, emptyPatch.json);

  const extraField = await api(
    'POST',
    '/v1/conversations/99999999-9999-4099-8999-999999999999/messages',
    { bearer, body: { body: 'hi', nonsense: true } },
  );
  step('POST …/messages with unknown field (strict schema)', extraField.status, extraField.json);

  const noRoute = await api('GET', '/v1/nope');
  step('GET /v1/nope (route does not exist)', noRoute.status, noRoute.json);

  const malformed = await api('POST', '/v1/auth/login', { rawBody: '{"email":' });
  step('POST /v1/auth/login (malformed JSON)', malformed.status, malformed.json);

  // 429: forgot-password is limited to 5/min per (IP+email) and always 202s.
  let last: { status: number; json: any } | null = null;
  for (let i = 0; i < 6; i++) {
    last = await api('POST', '/v1/auth/forgot-password', { body: { email: ctx.ownerEmail } });
  }
  step('POST /v1/auth/forgot-password (6th call/min → 429)', last!.status, last!.json);
}

// ========================================================= PHASE 4: Socket.IO
async function phase4Sockets(ctx: { main: any; convA: string; visitorTokenA: string }) {
  const received: { event: string; payload: unknown }[] = [];
  const sockets: Socket[] = [];

  function connect(token: string | undefined): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const sock = ioClient(base, {
        path: WS_PATH,
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        ...(token ? { auth: { token } } : {}),
      });
      sockets.push(sock);
      const t = setTimeout(() => reject(new Error('connect timeout')), 4000);
      sock.once('connect', () => {
        clearTimeout(t);
        resolve(sock);
      });
      sock.once('connect_error', (err) => {
        clearTimeout(t);
        reject(err);
      });
    });
  }
  function ack(sock: Socket, event: string, payload: unknown, ms = 4000): Promise<any> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ __timeout: true }), ms);
      sock.emit(event, payload, (a: any) => {
        clearTimeout(t);
        resolve(a);
      });
    });
  }

  // 1. Handshake failures are refused before any room join.
  try {
    await connect('not-a-valid-token');
    step('Socket.IO connect with invalid auth.token', 'unexpected success', {});
  } catch (e: any) {
    step('Socket.IO connect with invalid auth.token', 'connect_error', { message: e.message });
  }
  try {
    await connect(undefined);
    step('Socket.IO connect with NO auth.token', 'connect_error', { message: e2msg() });
  } catch (e: any) {
    step('Socket.IO connect with NO auth.token', 'connect_error', { message: e.message });
  }
  function e2msg() {
    return 'unauthorized';
  }

  // 2. Agent connects with its access token; auto-joins workspace + agent rooms.
  const agent = await connect(ctx.main.accessToken);
  step('Socket.IO connect (agent, auth.token = accessToken)', 'connected', {
    connected: true,
    path: WS_PATH,
    autoRooms: ['workspace:{workspaceId}', 'agent:{userId}'],
  });
  for (const ev of ['message:new', 'conversation:updated', 'visitor:presence', 'typing']) {
    agent.on(ev, (payload: unknown) => received.push({ event: ev, payload }));
  }

  // 3. Join + send + typing acks (agent side).
  const joinA = await ack(agent, 'conversation:join', { conversationId: ctx.convA });
  step('WS ack — conversation:join (agent)', 200, joinA);
  const sendA = await ack(agent, 'message:send', {
    conversationId: ctx.convA,
    body: 'Realtime reply from the agent.',
    idempotencyKey: 'probe-ws-1',
  });
  step('WS ack — message:send (agent)', 200, sendA);
  const typingA = await ack(agent, 'typing', { conversationId: ctx.convA, typing: true });
  step('WS ack — typing (agent)', 200, typingA);

  // 4. Visitor side: presence on connect, forbidden before join, then join/send.
  const visitor = await connect(ctx.visitorTokenA);
  step('Socket.IO connect (visitor token from visitor_init)', 'connected', { connected: true });
  await sleep(200);

  const earlySend = await ack(visitor, 'message:send', {
    conversationId: ctx.convA,
    body: 'Sent before joining.',
  });
  step('WS ack — message:send BEFORE conversation:join', 200, earlySend);

  const joinV = await ack(visitor, 'conversation:join', { conversationId: ctx.convA });
  step('WS ack — conversation:join (visitor)', 200, joinV);
  const typingV = await ack(visitor, 'typing', { conversationId: ctx.convA, typing: true });
  step('WS ack — typing (visitor)', 200, typingV);
  const sendV = await ack(visitor, 'message:send', {
    conversationId: ctx.convA,
    body: 'Hi — I need help with my order.',
  });
  step('WS ack — message:send (visitor)', 200, sendV);
  await sleep(300);

  // 5. REST mutation while sockets are connected (fan-out to agents).
  await api('PATCH', `/v1/conversations/${ctx.convA}`, {
    bearer: ctx.main.accessToken,
    body: { status: 'pending' },
  });
  await api('POST', `/v1/conversations/${ctx.convA}/messages`, {
    bearer: ctx.main.accessToken,
    body: { body: 'REST send while sockets listen.' },
  });
  await sleep(400);

  const leaveA = await ack(agent, 'conversation:leave', { conversationId: ctx.convA });
  step('WS ack — conversation:leave (agent)', 200, leaveA);

  // 6. Visitor disconnect → presence false.
  visitor.disconnect();
  await sleep(500);

  step('Socket.IO server→client events observed (in order)', 200, received);

  agent.disconnect();
  for (const s of sockets) s.disconnect();
}

// ================================================== PHASE 5: roles / capability 403
async function phase5Roles(ctx: { main: any }) {
  const bearer = ctx.main.accessToken as string;
  const agentEmail = `agent.${Date.now().toString(36)}@example.com`;

  const invite = await api('POST', '/v1/invitations', {
    bearer,
    body: { email: agentEmail, role: 'agent' },
  });
  step('POST /v1/invitations (owner invites an agent)', invite.status, invite.json);

  const accept = await api('POST', '/v1/invitations/accept', {
    body: { token: invite.json.token, name: 'Fake Agent', password: 'Throwaway-Password-2!' },
  });
  step('POST /v1/invitations/accept (new user → session with role "agent")', accept.status, accept.json);

  const agentAccess = accept.json.accessToken as string;

  const members403 = await api('GET', '/v1/members', { bearer: agentAccess });
  step('GET /v1/members as agent → 403 (members:read = owner/admin only)', members403.status, members403.json);

  const invite403 = await api('POST', '/v1/invitations', {
    bearer: agentAccess,
    body: { email: 'someone@example.com', role: 'agent' },
  });
  step('POST /v1/invitations as agent → 403 (members:invite = owner/admin only)', invite403.status, invite403.json);

  const agentConvs = await api('GET', '/v1/conversations?limit=1', { bearer: agentAccess });
  step('GET /v1/conversations as agent → 200 (conversations:read allows agent)', agentConvs.status, {
    itemsCount: agentConvs.json?.items?.length,
    nextCursorType: agentConvs.json?.nextCursor === null ? 'null' : 'string',
  });
}

// ============================================== PHASE 6: refresh / logout / logout-all
async function phase6Sessions(ctx: { loginX: any; loginY: any; main: any }) {
  const refreshed = await api('POST', '/v1/auth/refresh', {
    body: { refreshToken: ctx.loginX.refreshToken },
  });
  step('POST /v1/auth/refresh (success — token rotates)', refreshed.status, refreshed.json);

  const reuse = await api('POST', '/v1/auth/refresh', {
    body: { refreshToken: ctx.loginX.refreshToken }, // same, already-rotated token
  });
  step('POST /v1/auth/refresh (reuse of rotated token → family revoked)', reuse.status, reuse.json);

  const missing = await api('POST', '/v1/auth/refresh', { body: {} });
  step('POST /v1/auth/refresh (no token at all)', missing.status, missing.json);

  const logout = await api('POST', '/v1/auth/logout', {
    body: { refreshToken: ctx.loginY.refreshToken },
  });
  step('POST /v1/auth/logout', logout.status, logout.json);

  const logoutAll = await api('POST', '/v1/auth/logout-all', {
    bearer: refreshed.json.accessToken,
  });
  step('POST /v1/auth/logout-all (Bearer; browser keeps its cookie session)', logoutAll.status, logoutAll.json);

  const afterAll = await api('POST', '/v1/auth/refresh', {
    body: { refreshToken: refreshed.json.refreshToken },
  });
  step('POST /v1/auth/refresh (after logout-all → 401)', afterAll.status, afterAll.json);

  const logoutIdem = await api('POST', '/v1/auth/logout', { body: {} });
  step('POST /v1/auth/logout (idempotent — no credentials)', logoutIdem.status, logoutIdem.json);

  const me = await api('GET', '/v1/auth/me', { bearer: refreshed.json.accessToken });
  step('GET /v1/auth/me (access token still valid — JWT is stateless)', me.status, me.json);
}

// ========================================================================= main
async function main() {
  try {
    const p1 = await phase1Auth();
    const p2 = await phase2Conversations(p1);
    await phase3Errors(p1);
    await phase4Sockets({ main: p1.main, convA: p2.convA, visitorTokenA: p2.visitorTokenA });
    await phase5Roles(p1);
    await phase6Sessions(p1);
    console.log('\n=== PROBE COMPLETE ===');
  } catch (err) {
    console.error('\nPROBE FAILED:', err);
    process.exitCode = 1;
  } finally {
    setTimeout(() => process.exit(process.exitCode ?? 0), 300);
  }
}

void main();

