/**
 * Live smoke test for the realtime sync fixes (run against the dev API on :4000).
 * Simulates the widget + dashboard clients exactly as they parse events:
 *  1. visitor_init returns an empty `messages` array for a fresh visitor
 *  2. widget WS send  -> agent socket receives message:new { conversationId, message }
 *  3. agent REST send -> visitor socket receives message:new { conversationId, message }
 *  4. widget "reload": visitor_init with the SAME anonymousId returns the same
 *     conversation AND both messages in `messages` (history restore)
 * Cleanup: removes every row the smoke account created.
 */
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: 'd:/saas/.env' });

import assert from 'node:assert/strict';
import postgres from 'postgres';
import { io as ioClient, type Socket } from 'socket.io-client';

const base = 'http://localhost:4000';
const WS_PATH = '/ws';
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

function waitForEvent(
  sock: Socket,
  event: string,
  predicate?: (payload: any) => boolean,
  ms = 5000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    const handler = (payload: any) => {
      if (predicate && !predicate(payload)) return;
      clearTimeout(t);
      sock.off(event, handler);
      resolve(payload);
    };
    sock.on(event, handler);
  });
}

function emitAck(sock: Socket, event: string, payload: unknown, ms = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`ack timeout for ${event}`)), ms);
    sock.emit(event, payload, (ack: any) => {
      clearTimeout(t);
      resolve(ack);
    });
  });
}

const email = `smoke-${uniq()}@example.com`;
let workspaceId = '';

async function cleanup() {
  for (const s of sockets) s.disconnect();
  if (!workspaceId || !process.env.DATABASE_URL) return;
  // Strip drizzle-specific query params (e.g. ?schema=) postgres.js can't set.
  const sql = postgres(process.env.DATABASE_URL.split('?')[0], { max: 1 });
  await sql`DELETE FROM messages WHERE workspace_id = ${workspaceId}::uuid`;
  await sql`DELETE FROM conversations WHERE workspace_id = ${workspaceId}::uuid`;
  await sql`DELETE FROM visitors WHERE workspace_id = ${workspaceId}::uuid`;
  await sql`DELETE FROM widget_settings WHERE workspace_id = ${workspaceId}::uuid`;
  await sql`DELETE FROM workspaces WHERE id = ${workspaceId}::uuid`;
  await sql`DELETE FROM users WHERE email = ${email}::citext`;
  await sql.end();
}


async function main() {
  // 1. Agent account + widget public key.
  const signup = await post('/v1/auth/signup', {
    email,
    password: 'correct-horse-battery',
    name: 'Smoke',
    workspaceName: 'Smoke WS',
  });
  assert.equal(signup.status, 200, `signup: ${JSON.stringify(signup.json)}`);
  const accessToken: string = signup.json.accessToken;
  workspaceId = signup.json.workspaceId;

  const key = await post('/v1/api-keys', { name: 'Smoke widget key' }, accessToken);
  assert.equal(key.status, 201, `api key: ${JSON.stringify(key.json)}`);
  const publicKey: string = key.json.publicKey;

  // 2. Fresh visitor_init — must now include an empty history array.
  const anonymousId = `smoke-anon-${uniq()}`;
  const init1 = await post('/widget/v1/visitor_init', { publicKey, anonymousId });
  assert.equal(init1.status, 200, `visitor_init: ${JSON.stringify(init1.json)}`);
  assert.ok(Array.isArray(init1.json.messages), 'visitor_init returns messages[]');
  assert.equal(init1.json.messages.length, 0, 'fresh conversation has no history');
  const { visitorId, conversationId, token } = init1.json;

  // 3. Both clients connect + join (widget with visitor token, agent with JWT).
  const visSock = await connectSocket(token);
  const agentSock = await connectSocket(accessToken);
  const vJoin = await emitAck(visSock, 'conversation:join', { conversationId });
  assert.equal(vJoin.ok, true, `visitor join: ${JSON.stringify(vJoin)}`);
  const aJoin = await emitAck(agentSock, 'conversation:join', { conversationId });
  assert.equal(aJoin.ok, true, `agent join: ${JSON.stringify(aJoin)}`);

  // 4. Widget sends over WS (as the widget does) -> the agent side must receive
  //    message:new parsed the way the dashboard reads it: payload.message.id.
  const agentWait = waitForEvent(
    agentSock,
    'message:new',
    (p) => p.conversationId === conversationId && p.message?.body === 'smoke-widget-msg',
  );
  const sendAck = await emitAck(visSock, 'message:send', {
    conversationId,
    body: 'smoke-widget-msg',
    idempotencyKey: uniq(),
  });
  assert.equal(sendAck.ok, true, `message:send ack: ${JSON.stringify(sendAck)}`);
  assert.equal(sendAck.message.body, 'smoke-widget-msg', 'ack carries persisted message');
  const agentView = await agentWait;
  assert.equal(typeof agentView.message.id, 'string', 'agent sees message.new.message.id');
  assert.equal(agentView.message.senderType, 'visitor', 'agent sees senderType=visitor');

  // 5. Agent replies via REST (as the dashboard does) -> the widget side must
  //    receive message:new parsed the way the widget reads it: payload.message.
  const visWait = waitForEvent(
    visSock,
    'message:new',
    (p) => p.conversationId === conversationId && p.message?.body === 'smoke-agent-msg',
  );
  const restSend = await post(
    `/v1/conversations/${conversationId}/messages`,
    { body: 'smoke-agent-msg' },
    accessToken,
  );
  assert.equal(restSend.status, 201, `REST send: ${JSON.stringify(restSend.json)}`);
  const visView = await visWait;
  assert.equal(typeof visView.message.id, 'string', 'widget sees message.new.message.id');
  assert.equal(visView.message.senderType, 'agent', 'widget sees senderType=agent');

  // 6. "Close and reopen the widget" = a fresh page load: visitor_init with the
  //    same anonymousId must resume the SAME conversation with FULL history.
  const init2 = await post('/widget/v1/visitor_init', { publicKey, anonymousId });
  assert.equal(init2.status, 200, `re-init: ${JSON.stringify(init2.json)}`);
  assert.equal(init2.json.conversationId, conversationId, 'reload resumes same conversation');
  assert.equal(init2.json.visitorId, visitorId, 'reload resumes same visitor');
  assert.equal(init2.json.messages.length, 2, 'history restored after reload');
  assert.deepEqual(
    init2.json.messages.map((m: any) => m.body),
    ['smoke-widget-msg', 'smoke-agent-msg'],
    'history is complete and oldest→newest',
  );

  console.log('E2E SMOKE PASS: both fan-out directions + history restore verified');
}

main()
  .catch((err) => {
    console.error('E2E SMOKE FAIL:', err);
    process.exitCode = 1;
  })
  .finally(() => cleanup().catch((e) => console.error('cleanup error', e)));
