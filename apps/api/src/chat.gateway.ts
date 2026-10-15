import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { eq, and } from 'drizzle-orm';
import { conversations, withTenant, currentTx } from '@livechat/db';
import { AppError, conversationIdSchema, wsMessageSendSchema, wsTypingSchema, type Role } from '@livechat/shared';
import { ZodError } from 'zod';
import { verifyAccessToken } from './jwt.js';
import { verifyVisitorToken } from './visitor-jwt.js';
import { conversationService } from './conversations.service.js';
import { registerRealtime } from './realtime.js';
import { consumeRateLimit } from './rate-limit.js';

/**
 * Socket.IO gateway (blueprint §9 Realtime Flow).
 *
 * Handshake: the client passes `auth.token` — an AGENT access token (JWT) or a
 * VISITOR token (widget audience; only obtainable via POST /widget/v1/visitor_init).
 * Audiences are disjoint, so either token type can never impersonate the other.
 * Unauthenticated sockets are refused at the middleware stage.
 *
 * Rooms (per blueprint §9):
 *   workspace:{id}    — every agent socket of the workspace (inbox updates)
 *   agent:{userId}    — all sockets of one agent (direct targeting, later)
 *   conversation:{id} — participants of a conversation (messages, typing)
 *   visitor:{id}      — all sockets of one visitor
 *
 * Every client→server event is acknowledged ({ ok } | { ok:false, error }),
 * zod-validated, authorized (agent: workspace via RLS; visitor: ownership),
 * and rate-limited per principal.
 */
type Principal =
  | { kind: 'agent'; workspaceId: string; userId: string; role: Role }
  | { kind: 'visitor'; workspaceId: string; visitorId: string };

const WS_MESSAGE_RATE = { limit: 30, windowMs: 60_000 };

function principal(socket: Socket): Principal | null {
  const auth = (socket.data as any).auth as Principal | undefined;
  return auth ?? null;
}

function errorPayload(e: unknown) {
  if (e instanceof AppError) return { ok: false, error: { code: e.code, message: e.message } };
  if (e instanceof ZodError)
    return { ok: false, error: { code: 'validation_failed', message: 'Validation failed' } };
  return { ok: false, error: { code: 'internal_error', message: 'Internal server error' } };
}

/** Validate that this principal may act on the conversation (RLS scopes the
 *  tenant; visitors must additionally own the conversation). */
async function authorizeConversation(
  auth: Principal,
  conversationId: string,
): Promise<{ status: string }> {
  return withTenant(process.env.DATABASE_URL!, auth.workspaceId, async () => {
    const tx = currentTx();
    const [conv] = await tx
      .select({ id: conversations.id, visitorId: conversations.visitorId, status: conversations.status })
      .from(conversations)
      .where(and(eq(conversations.workspaceId, auth.workspaceId), eq(conversations.id, conversationId)))
      .limit(1);
    if (!conv || (auth.kind === 'visitor' && conv.visitorId !== auth.visitorId)) {
      throw new AppError('not_found', 'Conversation not found', 404);
    }
    return { status: conv.status };
  });
}

@WebSocketGateway({ path: '/ws', cors: { origin: '*' } })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;

  /** Online visitor socket counts (per node — presence is advisory only). */
  private onlineVisitors = new Map<string, number>();

  afterInit(server: Server) {
    // REST send/assign/close must fan out to sockets too.
    registerRealtime({
      toConversation: (id, event, payload) => server.to(`conversation:${id}`).emit(event, payload),
      toWorkspace: (id, event, payload) => server.to(`workspace:${id}`).emit(event, payload),
    });

    // Handshake auth middleware: reject before any room join happens.
    server.use((socket, next) => {
      const token = (socket.handshake.auth as any)?.token;
      if (typeof token === 'string' && token) {
        try {
          const a = verifyAccessToken(token);
          (socket.data as any).auth = {
            kind: 'agent', workspaceId: a.workspaceId, userId: a.sub, role: a.role,
          } satisfies Principal;
          return next();
        } catch { /* try visitor token next */ }
        try {
          const v = verifyVisitorToken(token);
          (socket.data as any).auth = {
            kind: 'visitor', workspaceId: v.workspaceId, visitorId: v.sub,
          } satisfies Principal;
          return next();
        } catch { /* reject below */ }
      }
      next(new Error('unauthorized'));
    });
  }

  handleConnection(socket: Socket) {
    const auth = principal(socket);
    if (!auth) return; // middleware already refused; defensive
    if (auth.kind === 'agent') {
      socket.join(`workspace:${auth.workspaceId}`);
      socket.join(`agent:${auth.userId}`);
    } else {
      socket.join(`visitor:${auth.visitorId}`);
      const key = `${auth.workspaceId}:${auth.visitorId}`;
      const prev = this.onlineVisitors.get(key) ?? 0;
      this.onlineVisitors.set(key, prev + 1);
      if (prev === 0) {
        socket
          .to(`workspace:${auth.workspaceId}`)
          .emit('visitor:presence', { visitorId: auth.visitorId, online: true });
      }
    }
  }

  handleDisconnect(socket: Socket) {
    const auth = principal(socket);
    if (auth?.kind !== 'visitor') return;
    const key = `${auth.workspaceId}:${auth.visitorId}`;
    const prev = this.onlineVisitors.get(key) ?? 0;
    if (prev <= 1) {
      this.onlineVisitors.delete(key);
      socket
        .to(`workspace:${auth.workspaceId}`)
        .emit('visitor:presence', { visitorId: auth.visitorId, online: false });
    } else {
      this.onlineVisitors.set(key, prev - 1);
    }
  }

  /** Join a conversation room — the gate for message:send and typing. */
  @SubscribeMessage('conversation:join')
  async onJoin(socket: Socket, body: unknown) {
    const auth = principal(socket);
    if (!auth) return { ok: false, error: { code: 'unauthenticated', message: 'unauthenticated' } };
    try {
      const { conversationId } = conversationIdSchema.parse(body);
      await authorizeConversation(auth, conversationId);
      await socket.join(`conversation:${conversationId}`);
      return { ok: true, conversationId };
    } catch (e) {
      return errorPayload(e);
    }
  }

  @SubscribeMessage('conversation:leave')
  async onLeave(socket: Socket, body: unknown) {
    const auth = principal(socket);
    if (!auth) return { ok: false, error: { code: 'unauthenticated', message: 'unauthenticated' } };
    try {
      const { conversationId } = conversationIdSchema.parse(body);
      await socket.leave(`conversation:${conversationId}`);
      return { ok: true };
    } catch (e) {
      return errorPayload(e);
    }
  }

  /** Send a chat message; the service fans out `message:new` to the room. */
  @SubscribeMessage('message:send')
  async onMessage(socket: Socket, body: unknown) {
    const auth = principal(socket);
    if (!auth) return { ok: false, error: { code: 'unauthenticated', message: 'unauthenticated' } };
    try {
      const rate = consumeRateLimit(
        `ws:${auth.kind}:${auth.kind === 'agent' ? auth.userId : auth.visitorId}`,
        WS_MESSAGE_RATE.limit,
        WS_MESSAGE_RATE.windowMs,
      );
      if (!rate.allowed) {
        return {
          ok: false,
          error: {
            code: 'rate_limited',
            message: `Too many messages. Retry in ${rate.retryAfterSeconds}s`,
          },
        };
      }
      const input = wsMessageSendSchema.parse(body);
      if (!socket.rooms.has(`conversation:${input.conversationId}`)) {
        return {
          ok: false,
          error: { code: 'forbidden', message: 'Join the conversation before sending' },
        };
      }
      await authorizeConversation(auth, input.conversationId);
      const message =
        auth.kind === 'agent'
          ? await conversationService.sendMessage(
              auth.workspaceId,
              auth.role,
              auth.userId,
              input.conversationId,
              { body: input.body, idempotencyKey: input.idempotencyKey },
            )
          : await conversationService.visitorSend(
              auth.workspaceId,
              auth.visitorId,
              input.conversationId,
              { body: input.body, idempotencyKey: input.idempotencyKey },
            );
      return { ok: true, message };
    } catch (e) {
      return errorPayload(e);
    }
  }

  /** Typing indicator — relayed, never stored (blueprint §8.2). */
  @SubscribeMessage('typing')
  async onTyping(socket: Socket, body: unknown) {
    const auth = principal(socket);
    if (!auth) return { ok: false, error: { code: 'unauthenticated', message: 'unauthenticated' } };
    try {
      const { conversationId, typing } = wsTypingSchema.parse(body);
      if (!socket.rooms.has(`conversation:${conversationId}`)) {
        return {
          ok: false,
          error: { code: 'forbidden', message: 'Join the conversation before typing' },
        };
      }
      socket.to(`conversation:${conversationId}`).emit('typing', {
        conversationId,
        typing,
        by: auth.kind,
        senderId: auth.kind === 'agent' ? auth.userId : auth.visitorId,
      });
      return { ok: true };
    } catch (e) {
      return errorPayload(e);
    }
  }
}
