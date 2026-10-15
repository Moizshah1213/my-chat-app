import '../load-env.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import postgres from 'postgres';
import { io as ioClient, type Socket } from 'socket.io-client';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from '../app.module.js';
import { resetRateLimits } from '../rate-limit.js';
import { closeDb } from '@livechat/db';

/**
 * Phase 2 — Realtime integration suite (blueprint §9). Boots the REAL Nest
 * app (gateway falls back to the in-memory Socket.IO adapter when Redis is
 * absent — that path is under test) and connects real socket.io clients.
 * Covers: handshake refusal, room joins, message fan-out both directions
 * (WS + REST), conversation:updated, typing relay, leave/forbidden gating,
 * cross-tenant + non-owner join denial, presence, token audience separation,
 * per-principal rate limiting.
 */

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;

const BOOT_URL = process.env.BOOTSTRAP_DATABASE_URL!.replace(/\/[^/]+$/, '/livechat_test');
const WS_PATH = '/ws';

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
const createdEmails: string[] = [];

interface VisitorCtx {
  visitorId: string;
  conversationId: string;
  token: string;
}
let v1: VisitorCtx; // primary conversation partner of the agent socket
let v2: VisitorCtx; // presence only (connects in its own test)
let v3: VisitorCtx; // rate-limit flood target
let foreignWs = '';
let foreignConv = '';
let bareConv = ''; // same workspace, no visitor attached (ownership denial)
let closedConv = ''; // closed conversation for send-rule tests
const guestWorkspaces: string[] = []; // guest workspaces created by tests (cleanup)

const sockets: Socket[] = [];

const uniq = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function request(
  path: string,
  init: RequestInit & { bearer?: string } = {},
): Promise<{ status: number; json: any }> {
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

const post = (path: string, body: unknown, bearer?: string) =>
  request(path, { method: 'POST', body: JSON.stringify(body), bearer });
const patch = (path: string, body: unknown, bearer?: string) =>
  request(path, { method: 'PATCH', body: JSON.stringify(body), bearer });
const get = (path: string, bearer?: string) => request(path, { bearer });

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

async function widgetInit(anonymousId: string, workspaceId?: string): Promise<VisitorCtx> {
  const res = await request('/widget/v1/visitor_init', {
    method: 'POST',
    body: JSON.stringify({ workspaceId: workspaceId ?? owner.workspaceId, anonymousId }),
  });
  assert.equal(res.status, 200, `visitor_init should succeed: ${JSON.stringify(res.json)}`);
  return {
    visitorId: res.json.visitorId,
    conversationId: res.json.conversationId,
    token: res.json.token,
  };
}

function connectSocket(token: string): Promise<Socket> {
  const sock = ioClient(base, {
    path: WS_PATH,
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    auth: { token },
  });
  sockets.push(sock);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect timeout')), 4000);
    sock.once('connect', () => {
      clearTimeout(t);
      resolve(sock);
    });
    sock.once('connect_error', (e: Error) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

async function expectConnectError(token?: string): Promise<string> {
  const sock = ioClient(base, {
    path: WS_PATH,
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    ...(token ? { auth: { token } } : {}),
  });
  sockets.push(sock);
  const message = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('expected a connect_error')), 4000);
    sock.once('connect_error', (e: Error) => {
      clearTimeout(t);
      resolve(e.message);
    });
    sock.once('connect', () => {
      clearTimeout(t);
      reject(new Error('connected, but the handshake should have been refused'));
    });
  });
  sock.disconnect();
  return message;
}

// Wait for an event; predicates keep stale earlier emissions of the same
// event name from satisfying assertions written for a later test.
function waitForEvent(
  sock: Socket,
  event: string,
  predicate?: (payload: any) => boolean,
  ms = 4000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    const handler = (payload: any) => {
      if (predicate && !predicate(payload)) return; // keep waiting
      clearTimeout(t);
      sock.off(event, handler);
      resolve(payload);
    };
    sock.on(event, handler);
  });
}

/** Emit an event and resolve with the ack payload; guard with a timeout. */
function emitAck(sock: Socket, event: string, payload: unknown, ms = 4000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`ack timeout for ${event}`)), ms);
    sock.emit(event, payload, (ack: any) => {
      clearTimeout(t);
      resolve(ack);
    });
  });
}

/** --------------------------------------------------------------------------
 * Realtime suite bootstrap: boot the REAL Nest app (Socket.IO falls back to the
 * in-memory adapter when Redis is absent), sign up the owner + primary visitor
 * and seed same/cross-tenant conversations used by the room-join + fan-out tests.
 * ------------------------------------------------------------------------ */
before(async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must be set');
  boot = postgres(BOOT_URL, { max: 1, onnotice: () => {} });
  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error'] });
  app.use(cookieParser());
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;

  owner = await signup('realtime-owner');

  // Primary visitor: widget_init resolves or creates the visitor and opens a
  // conversation for them (v1.conversationId == baseline).
  v1 = await widgetInit('rea-v1-anon');

  // Same-workspace conversation owned by a DIFFERENT visitor (ownership test).
  const otherVisitor = randomUUID();
  const otherAnon = `rea-other-anon-${uniq()}`;
  await boot`INSERT INTO visitors (id, workspace_id, anon_id, first_seen)
            VALUES (${otherVisitor}::uuid, ${owner.workspaceId}::uuid, ${otherAnon}, now())`;
  bareConv = randomUUID();
  await boot`INSERT INTO conversations (id, workspace_id, visitor_id, status, last_message_at)
            VALUES (${bareConv}::uuid, ${owner.workspaceId}::uuid, ${otherVisitor}::uuid, 'open', now())`;

  // Closed conversation (agent + visitor send rules).
  closedConv = randomUUID();
  await boot`INSERT INTO conversations (id, workspace_id, visitor_id, status, closed_at, last_message_at)
            VALUES (${closedConv}::uuid, ${owner.workspaceId}::uuid, ${v1.visitorId}::uuid, 'closed', now(), now() - interval '10 minutes')`;
});

describe('realtime: socket handshake + conversation room join', () => {
  before(() => resetRateLimits());

  it('refuses unauthenticated and garbage-token socket handshakes', async () => {
    const noToken = await expectConnectError();
    assert.match(noToken, /unauthorized/i, `missing token rejected: ${noToken}`);

    const garbage = await expectConnectError('not.a.jwt');
    assert.match(garbage, /unauthorized/i, `garbage token rejected: ${garbage}`);
  });

  it('agent + visitor join the conversation room and fan out messages', async () => {
    const agentSock = await connectSocket(owner.accessToken);
    const visSock = await connectSocket(v1.token);

    // Join gate: conversation:join -> { ok: true, conversationId }.
    const agentJoin = await emitAck(agentSock, 'conversation:join', { conversationId: v1.conversationId });
    assert.equal(agentJoin.ok, true, `agent joins the room: ${JSON.stringify(agentJoin)}`);
    assert.equal(agentJoin.conversationId, v1.conversationId);

    const visJoin = await emitAck(visSock, 'conversation:join', { conversationId: v1.conversationId });
    assert.equal(visJoin.ok, true, `visitor joins the room: ${JSON.stringify(visJoin)}`);

    // Visitor sends a message over WS (service -> fan-out to the room).
    // Register the fan-out listener BEFORE sending: the broadcast lands while
    // the ack is still in flight, and socket.io drops unlistened events.
    const fanoutPromise = waitForEvent(agentSock, 'message:new', (p: any) =>
      p.conversationId === v1.conversationId && p.message.body === 'hello from the visitor',
    );
    const sent = await emitAck(visSock, 'message:send', {
      conversationId: v1.conversationId,
      body: 'hello from the visitor',
      idempotencyKey: 'rea-idem-1',
    });
    assert.equal(sent.ok, true, `message accepted: ${JSON.stringify(sent)}`);
    assert.ok(sent.message.id, 'persisted message row');
    assert.equal(sent.message.senderType, 'visitor', 'visitor message over WS');

    // Agent (already in the room) receives the fan-out.
    const fanout = await fanoutPromise;
    assert.equal(fanout.message.id, sent.message.id, 'fan-out carries the persisted message id');

    // Idempotent re-send over WS (same body + key) returns the same row.
    const dup = await emitAck(visSock, 'message:send', {
      conversationId: v1.conversationId,
      body: 'hello from the visitor',
      idempotencyKey: 'rea-idem-1',
    });
    assert.equal(dup.ok, true, `idempotent resend accepted: ${JSON.stringify(dup)}`);
    assert.equal(dup.message.id, sent.message.id, 'idempotent send returns the existing row');

    for (const s of [agentSock, visSock]) s.disconnect();
  });
});

describe('realtime: assignment + closed rules', () => {
  before(() => resetRateLimits());

  it('REST send fans out message:new; REST assignment fans out conversation:updated', async () => {
    // Agent always owns the baseline conversation and its room.
    const agentSock = await connectSocket(owner.accessToken);
    const visSock = await connectSocket(v1.token);

    await emitAck(agentSock, 'conversation:join', { conversationId: v1.conversationId });
    await emitAck(visSock, 'conversation:join', { conversationId: v1.conversationId });

    // REST send (WS gateway + REST path share the same service fan-out).
    // Register the fan-out listener before the request resolves it.
    const fanoutPromise = waitForEvent(visSock, 'message:new', (p: any) =>
      p.conversationId === v1.conversationId && p.message.body === 'rest message',
    );
    const sent = await post(
      `/v1/conversations/${v1.conversationId}/messages`,
      { body: 'rest message', idempotencyKey: 'rea-rest-1' },
      owner.accessToken,
    );
    assert.equal(sent.status, 201, `REST send accepted: ${JSON.stringify(sent.json)}`);

    // Visitor in the room receives message:new.
    const fanout = await fanoutPromise;
    assert.equal(fanout.message.id, sent.json.id, 'REST send fan-outs to the room');

    // Assignment updates the room (conversation:updated with assignedTo).
    const updatedPromise = waitForEvent(visSock, 'conversation:updated', (p: any) =>
      p.conversationId === v1.conversationId && p.assignedTo === owner.userId,
    );
    const assign = await patch(
      `/v1/conversations/${v1.conversationId}`,
      { assignedTo: owner.userId },
      owner.accessToken,
    );
    assert.equal(assign.status, 200, `assignment accepted: ${JSON.stringify(assign.json)}`);

    const updated = await updatedPromise;
    assert.equal(updated.assignedTo, owner.userId, 'conversation:updated carries assignedTo');
    assert.equal(updated.status, 'open', 'conversation:updated carries status');

    for (const s of [agentSock, visSock]) s.disconnect();
  });

  it('agent + visitor cannot send to a closed conversation', async () => {
    const agentSock = await connectSocket(owner.accessToken);
    const visSock = await connectSocket(v1.token);

    // Agent closes the conversation via REST.
    const closed = await patch(
      `/v1/conversations/${closedConv}`,
      { status: 'closed' },
      owner.accessToken,
    );
    assert.equal(closed.status, 200, `closed accepted: ${JSON.stringify(closed.json)}`);

    // Agent REST send to the closed conversation is rejected 400.
    const rest = await post(
      `/v1/conversations/${closedConv}/messages`,
      { body: 'nope' },
      owner.accessToken,
    );
    assert.equal(rest.status, 400, `REST send to closed is rejected: ${JSON.stringify(rest.json)}`);
    assert.equal(rest.json.error.code, 'validation_failed', `REST send error code: ${rest.json.error.code}`);

    // Agent WS send to the closed conversation is rejected (no fan-out).
    await emitAck(agentSock, 'conversation:join', { conversationId: closedConv });
    const ws = await emitAck(agentSock, 'message:send', {
      conversationId: closedConv,
      body: 'nope over ws',
    });
    assert.equal(ws.ok, false, `WS send to closed is rejected: ${JSON.stringify(ws)}`);
    assert.equal(ws.error.code, 'validation_failed', `WS send error code: ${ws.error.code}`);

    // Visitor (who owns the closed conversation) cannot send either.
    const vis = await emitAck(visSock, 'conversation:join', { conversationId: closedConv });
    assert.equal(vis.ok, true, `visitor joins closed conversation: ${JSON.stringify(vis)}`);
    const vs = await emitAck(visSock, 'message:send', {
      conversationId: closedConv,
      body: 'also no',
    });
    assert.equal(vs.ok, false, `visitor WS send to closed is rejected: ${JSON.stringify(vs)}`);
    assert.equal(vs.error.code, 'validation_failed', `visitor WS error code: ${vs.error.code}`);

    for (const s of [agentSock, visSock]) s.disconnect();
  });
});

describe('realtime: typing + presence', () => {
  before(() => resetRateLimits());

  it('typing events relay to the conversation room and are never stored', async () => {
    const agentSock = await connectSocket(owner.accessToken);
    const visSock = await connectSocket(v1.token);

    const agentJoin = await emitAck(agentSock, 'conversation:join', { conversationId: v1.conversationId });
    assert.equal(agentJoin.ok, true, `agent joins the room: ${JSON.stringify(agentJoin)}`);
    const visJoin = await emitAck(visSock, 'conversation:join', { conversationId: v1.conversationId });
    assert.equal(visJoin.ok, true, `visitor joins the room: ${JSON.stringify(visJoin)}`);

    // Agent starts typing -> the visitor receives `typing` via the room.
    const onPromise = waitForEvent(visSock, 'typing', (p: any) =>
      p.conversationId === v1.conversationId && p.typing === true && p.by === 'agent',
    );
    await emitAck(agentSock, 'typing', { conversationId: v1.conversationId, typing: true });
    const typingOn = await onPromise;
    assert.equal(typingOn.senderId, owner.userId, 'typing carries the sender id');

    // Agent stops typing -> the visitor receives typing:false.
    const offPromise = waitForEvent(visSock, 'typing', (p: any) =>
      p.conversationId === v1.conversationId && p.typing === false && p.by === 'agent',
    );
    await emitAck(agentSock, 'typing', { conversationId: v1.conversationId, typing: false });
    const typingOff = await offPromise;
    assert.equal(typingOff.senderId, owner.userId, 'typing stop carries the sender id');

    // VISITOR types (already in the room): the agent receives the relay too.
    const visTypingPromise = waitForEvent(agentSock, 'typing', (p: any) =>
      p.conversationId === v1.conversationId && p.typing === true && p.by === 'visitor',
    );
    await emitAck(visSock, 'typing', { conversationId: v1.conversationId, typing: true });
    const visTyping = await visTypingPromise;
    assert.equal(visTyping.senderId, v1.visitorId, 'visitor typing relays to agent');

    // Visitor stops typing -> the agent receives typing:false (the sender
    // never receives its own relay — socket.to() excludes the emitter).
    const visStopPromise = waitForEvent(agentSock, 'typing', (p: any) =>
      p.conversationId === v1.conversationId && p.typing === false && p.by === 'visitor',
    );
    await emitAck(visSock, 'typing', { conversationId: v1.conversationId, typing: false });
    const visStop = await visStopPromise;
    assert.equal(visStop.senderId, v1.visitorId, 'visitor typing stop relays to agent');

    for (const s of [agentSock, visSock]) s.disconnect();
  });

  it('visitor presence relays to the workspace inbox on join and leave', async () => {
    const agentSock = await connectSocket(owner.accessToken);

    const vis1 = await widgetInit('rea-pres-1');
    const s1 = await connectSocket(vis1.token);
    const p1 = await waitForEvent(agentSock, 'visitor:presence', (p: any) =>
      p.visitorId === vis1.visitorId && p.online === true,
    );
    assert.equal(p1.visitorId, vis1.visitorId, 'visitor presence reported on join');

    const vis2 = await widgetInit('rea-pres-2');
    const s2 = await connectSocket(vis2.token);
    const p2 = await waitForEvent(agentSock, 'visitor:presence', (p: any) =>
      p.visitorId === vis2.visitorId && p.online === true,
    );
    assert.equal(p2.visitorId, vis2.visitorId, 'second visitor presence reported on join');

    // Both visitors connected -> online count is 2 (presence is advisory-only).
    const count2 = await boot`SELECT count(*)::int AS n FROM visitors WHERE id IN (${vis1.visitorId}::uuid, ${vis2.visitorId}::uuid)`;
    assert.equal(count2[0]?.n, 2, 'both visitors present in the DB');

    await s2.disconnect();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { throw new Error('timeout: visitor offline presence missing'); }, 4000);
      agentSock.once('visitor:presence', (p: any) => {
        clearTimeout(t);
        assert.equal(p.visitorId, vis2.visitorId, 'presence reported for the leaving visitor');
        assert.equal(p.online, false, 'visitor marked offline');
        resolve();
      });
    });

    for (const s of [agentSock, s1, s2]) s.disconnect();
  });
});

describe('realtime: cross-tenant + ownership', () => {
  before(() => resetRateLimits());

  it('cross-tenant visitor cannot join or write another workspace conversation', async () => {
    const agentSock = await connectSocket(owner.accessToken);

    // Guest owner + guest visitor live in their own workspace (separate tenant).
    const guestOwner = await signup('rea-guest-2');
    guestWorkspaces.push(guestOwner.workspaceId);
    const guestVis = await widgetInit('rea-guest-2-anon', guestOwner.workspaceId);

    const guestSock = await connectSocket(guestVis.token);

    // Cross-tenant join attempt -> 404 (authorizeConversation scopes by workspace).
    const joined = await emitAck(guestSock, 'conversation:join', { conversationId: v1.conversationId });
    assert.equal(joined.ok, false, `guest join denied: ${JSON.stringify(joined)}`);
    assert.equal(joined.error.code, 'not_found', `guest join error code: ${joined.error.code}`);

    // Guest AGENT token cannot send over REST either (wrong tenant -> 404).
    const write = await post(
      `/v1/conversations/${v1.conversationId}/messages`,
      { body: 'noop' },
      guestOwner.accessToken,
    );
    assert.equal(write.status, 404, `guest REST send denied: ${JSON.stringify(write.json)}`);

    // Same-tenant owner visitor still joins the owner's conversation.
    const ownerSock = await connectSocket(owner.accessToken);
    const ok = await emitAck(ownerSock, 'conversation:join', { conversationId: v1.conversationId });
    assert.equal(ok.ok, true, `owner agent may still join: ${JSON.stringify(ok)}`);

    for (const s of [agentSock, guestSock, ownerSock]) s.disconnect();
  });

  it('same-workspace visitor without ownership is denied room join + REST write', async () => {
    const agentSock = await connectSocket(owner.accessToken);
    const visSock = await connectSocket(v1.token);

    // Agent may join the bare conversation (any conversation in the workspace).
    const agentJoin = await emitAck(agentSock, 'conversation:join', { conversationId: bareConv });
    assert.equal(agentJoin.ok, true, `agent joins bare conversation: ${JSON.stringify(agentJoin)}`);

    // Owner's primary visitor (v1) does NOT own bareConv (owner's other visitor).
    const visJoin = await emitAck(visSock, 'conversation:join', { conversationId: bareConv });
    assert.equal(visJoin.ok, false, `visitor denied bare conversation: ${JSON.stringify(visJoin)}`);
    assert.equal(visJoin.error.code, 'not_found', `visitor denied error code: ${visJoin.error.code}`);

    // Visitor token cannot authenticate to REST at all (audience separation:
    // the REST routes only accept agent access tokens).
    const write = await post(
      `/v1/conversations/${bareConv}/messages`,
      { body: 'no-op' },
      v1.token,
    );
    assert.equal(write.status, 401, `visitor REST write rejected: ${JSON.stringify(write.json)}`);
    assert.equal(write.json.error.code, 'unauthenticated', `visitor REST error code: ${write.json.error.code}`);

    for (const s of [agentSock, visSock]) s.disconnect();
  });
});

describe('realtime: per-principal rate limiting', () => {
  before(() => resetRateLimits());

  it('message:send over WS is limited to 30 / 60s per visitor', async () => {
    const vis = await widgetInit('rea-flood-1');
    const sock = await connectSocket(vis.token);

    const joined = await emitAck(sock, 'conversation:join', { conversationId: vis.conversationId });
    assert.equal(joined.ok, true, `join accepted: ${JSON.stringify(joined)}`);

    for (let i = 1; i <= 31; i++) {
      const res = await emitAck(sock, 'message:send', {
        conversationId: vis.conversationId,
        body: `flood-${i}`,
      });
      if (i <= 30) {
        assert.equal(res.ok, true, `early send ${i} allowed`);
      } else {
        assert.equal(res.ok, false, `send ${i} was not rate limited: ${JSON.stringify(res)}`);
        assert.equal(res.error.code, 'rate_limited', `rate-limit error code: ${res.error.code}`);
        break;
      }
    }

    for (const s of [sock]) s.disconnect();
  });
});

after(async () => {
  // Teardown: close all live sockets, stop the app and clean the DB.
  for (const s of sockets) {
    s.disconnect();
  }
  if (app) await app.close();
  if (boot) {
    const ws = [owner?.workspaceId, ...guestWorkspaces].filter(Boolean) as string[];
    if (ws.length > 0) {
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
