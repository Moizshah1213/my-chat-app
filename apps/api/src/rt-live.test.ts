import { io } from 'socket.io-client';
import { createRequire } from 'module';
const require = createRequire('/d:/saas/apps/api/package.json');

const BASE = 'http://localhost:4000';

async function http(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

// 1) Signup → admin token + workspace
let r = await http('POST', '/v1/auth/signup', { email: 'rtest' + Date.now() + '@example.com', password: 'test-password', name: 'RT Agent', workspaceName: 'RT WS' });
const adminToken = r.body.accessToken;
console.log('[1] signup', r.status, r.body.userId, r.body.workspaceId);

// 2) Mint an agent key
r = await http('POST', '/v1/api-keys', { name: 'RT Agent key' }, adminToken);
const agentPublicKey = r.body.publicKey;
const agentSecret = r.body.secret;
console.log('[2] agent key minted', r.status, agentPublicKey);

// 3) Visitor init (mimics the widget) → token + conversationId (+ visitorId)
const anonymousId = 'rt-' + Date.now();
r = await http('POST', '/widget/v1/visitor_init', { publicKey: agentPublicKey, anonymousId }, undefined);
const visToken = r.body.token;
const conversationId = r.body.conversationId;
const visitorId = r.body.visitorId;
console.log('[3] visitor_init', r.status, 'conversationId', conversationId, 'visitorId', visitorId);

// 4) Agent socket binds to the conversation, sends a message
const agentSocket = io(BASE, { path: '/ws', transports: ['websocket'], auth: { token: adminToken } });
agentSocket.on('connect', async () => {
  await sleep(300);
  console.log('[agent socket] connected, joining conversation:','conversation:'+conversationId);
  agentSocket.emit('conversation:join', { conversationId }, (ack: any) => console.log('[agent] conversation:join ack', JSON.stringify(ack)));
  await sleep(200);
  agentSocket.emit('message:send', { conversationId, body: 'hello from agent (real-time)', idempotencyKey: 'agent-' + Date.now() }, (ack: any) => console.log('[agent] message:send ack', JSON.stringify(ack)));
});
agentSocket.on('message:new', (m) => console.log('[agent] received message:new (echo/fan-out):', JSON.stringify(m)));
agentSocket.on('connect_error', (e) => console.log('[agent] connect_error', e.message));
agentSocket.on('error', (e) => console.log('[agent] error', e.message));

// 5) Visitor socket + listen for messages
const visSocket = io(BASE, { path: '/ws', transports: ['websocket'], auth: { token: visToken } });
visSocket.on('connect', () => console.log('[visitor socket] connected'));
visSocket.on('connect_error', (e) => console.log('[visitor] connect_error:', e.message));
visSocket.on('error', (e) => console.log('[visitor] error:', e.message));
visSocket.on('message:new', (m) => console.log('[visitor] received message:new:', JSON.stringify(m)));
visSocket.on('disconnect', (s) => console.log('[visitor] disconnect:', s));
visSocket.on('connect_timeout', (ms) => console.log('[visitor] connect_timeout', ms));

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// Give event loop time to settle, then tear down
setTimeout(() => {
  visSocket.close();
  agentSocket.close();
  console.log('[done]');
}, 12000);
