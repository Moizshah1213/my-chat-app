import { and, eq, isNull, sql, desc } from 'drizzle-orm';
import {
  conversations,
  messages,
  visitors,
  memberships,
  withTenant,
  currentTx,
} from '@livechat/db';
import {
  badRequest,
  forbidden,
  notFound,
  roleCan,
  DEFAULT_PAGE_SIZE,
  AppError,
  listConversationsSchema,
  listMessagesSchema,
  sendMessageSchema,
  updateConversationSchema,
  type Role,
  type Capability,
  type ListConversationsInput,
  type ListMessagesInput,
  type SendMessageInput,
  type UpdateConversationInput,
} from '@livechat/shared';
import { parse } from './validation.js';
import { emitToConversation, emitToWorkspace } from './realtime.js';

/**
 * ConversationService — agent inbox + messaging (blueprint §6/§9).
 * Every method runs inside withTenant(workspaceId) so RLS enforces tenant
 * isolation; workspaceId ALWAYS comes from the caller's verified token (or,
 * for visitor sends, from the visitor's verified token — never a client id).
 */

const DB_URL = () => process.env.DATABASE_URL!;

function assertCapability(role: Role, capability: Capability) {
  if (!roleCan(role, capability)) throw forbidden('Insufficient role for this action');
}

/** Opaque keyset cursor: base64url of `${epochMillis}:${uuid}`. */
function encodeCursor(ms: number, id: string): string {
  return Buffer.from(`${ms}:${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { ms: number; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const idx = raw.indexOf(':');
  const ms = Number(raw.slice(0, idx));
  const id = raw.slice(idx + 1);
  if (idx < 1 || !Number.isFinite(ms) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw badRequest('Invalid cursor');
  }
  return { ms, id };
}

function assertId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw badRequest('Invalid id');
  }
  return id;
}

export interface ConversationView {
  id: string;
  status: string;
  assignedTo: string | null;
  subject: string | null;
  closedAt: Date | null;
  lastMessageAt: Date;
  createdAt: Date;
  visitor: { id: string | null; name: string | null; email: string | null };
}

export interface MessageView {
  id: string;
  conversationId: string;
  senderType: string;
  senderId: string | null;
  body: string;
  bodyType: string;
  createdAt: Date;
}

const CONVERSATION_SELECT = {
  id: conversations.id,
  status: conversations.status,
  assignedTo: conversations.assignedTo,
  subject: conversations.subject,
  closedAt: conversations.closedAt,
  lastMessageAt: conversations.lastMessageAt,
  createdAt: conversations.createdAt,
  visitorId: visitors.id,
  visitorName: visitors.name,
  visitorEmail: visitors.email,
};

function toConversationView(row: any): ConversationView {
  return {
    id: row.id,
    status: row.status,
    assignedTo: row.assignedTo,
    subject: row.subject,
    closedAt: row.closedAt,
    lastMessageAt: row.lastMessageAt,
    createdAt: row.createdAt,
    visitor: { id: row.visitorId ?? null, name: row.visitorName ?? null, email: row.visitorEmail ?? null },
  };
}

function toMessageView(row: any): MessageView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderType: row.senderType,
    senderId: row.senderId,
    body: row.body,
    bodyType: row.bodyType,
    createdAt: row.createdAt,
  };
}

export const conversationService = {
  /** Inbox listing with status/assignee filters + keyset pagination. */
  async list(workspaceId: string, role: Role, userId: string, query: unknown) {
    assertCapability(role, 'conversations:read');
    const q: ListConversationsInput = parse(listConversationsSchema, query);
    const limit = q.limit ?? DEFAULT_PAGE_SIZE;

    return withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      const conds = [eq(conversations.workspaceId, workspaceId)];
      if (q.status) conds.push(eq(conversations.status, q.status));
      if (q.assignee === 'me') conds.push(eq(conversations.assignedTo, userId));
      if (q.assignee === 'unassigned') conds.push(isNull(conversations.assignedTo));
      if (q.cursor) {
        const { ms, id } = decodeCursor(q.cursor);
        // Keyset: strictly "older" than the cursor row in (lastMessageAt, id) order.
        conds.push(
          sql`(conversations.last_message_at, conversations.id) < (to_timestamp(${ms} / 1000.0), ${id}::uuid)`,
        );
      }

      const rows = await tx
        .select(CONVERSATION_SELECT)
        .from(conversations)
        .leftJoin(visitors, eq(conversations.visitorId, visitors.id))
        .where(and(...conds))
        .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(toConversationView);
      const last = rows[limit - 1];
      return {
        items,
        // Keyset on (lastMessageAt, id) — the sort order of this listing.
        nextCursor: hasMore && last ? encodeCursor(last.lastMessageAt.getTime(), last.id) : null,
      };
    });
  },

  async get(workspaceId: string, role: Role, conversationId: string): Promise<ConversationView> {
    assertCapability(role, 'conversations:read');
    assertId(conversationId);
    return withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      const rows = await tx
        .select(CONVERSATION_SELECT)
        .from(conversations)
        .leftJoin(visitors, eq(conversations.visitorId, visitors.id))
        .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.id, conversationId)))
        .limit(1);
      if (!rows[0]) throw notFound('Conversation not found');
      return toConversationView(rows[0]);
    });
  },

  /**
   * Assign / change status / set subject. Assignee must be a member of THIS
   * workspace (validated server-side — never trust an agent-submitted id).
   * Closing sets closedAt; leaving 'closed' clears it.
   */
  async update(workspaceId: string, role: Role, conversationId: string, body: unknown) {
    assertCapability(role, 'conversations:write');
    assertId(conversationId);
    const input: UpdateConversationInput = parse(updateConversationSchema, body);

    const updated = await withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      const [conv] = await tx
        .select()
        .from(conversations)
        .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.id, conversationId)))
        .limit(1);
      if (!conv) throw notFound('Conversation not found');

      if (input.assignedTo != null) {
        const member = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .where(
            and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, input.assignedTo!)),
          )
          .limit(1);
        if (!member[0]) throw badRequest('Assignee is not a member of this workspace');
      }

      const set: Record<string, unknown> = {};
      if (input.status !== undefined) {
        set.status = input.status;
        set.closedAt = input.status === 'closed' ? new Date() : null;
      }
      if (input.assignedTo !== undefined) set.assignedTo = input.assignedTo;
      if (input.subject !== undefined) set.subject = input.subject;

      const [row] = await tx
        .update(conversations)
        .set(set as typeof conversations.$inferInsert)
        .where(eq(conversations.id, conversationId))
        .returning();
      return row;
    });
    if (!updated) throw notFound('Conversation not found');

    const view: ConversationView = {
      id: updated.id,
      status: updated.status,
      assignedTo: updated.assignedTo,
      subject: updated.subject,
      closedAt: updated.closedAt,
      lastMessageAt: updated.lastMessageAt,
      createdAt: updated.createdAt,
      visitor: { id: null, name: null, email: null },
    };
    // Live inbox updates for every agent viewing this workspace.
    emitToWorkspace(workspaceId, 'conversation:updated', {
      conversationId: view.id,
      status: view.status,
      assignedTo: view.assignedTo,
    });
    emitToConversation(view.id, 'conversation:updated', {
      conversationId: view.id,
      status: view.status,
      assignedTo: view.assignedTo,
    });
    return view;
  },

  /** Message history for one conversation (newest page, older via `before`). */
  async listMessages(
    workspaceId: string,
    role: Role,
    conversationId: string,
    query: unknown,
  ): Promise<{ items: MessageView[]; nextCursor: string | null }> {
    assertCapability(role, 'conversations:read');
    assertId(conversationId);
    const q: ListMessagesInput = parse(listMessagesSchema, query);
    const limit = q.limit ?? DEFAULT_PAGE_SIZE;

    return withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      const [conv] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.id, conversationId)))
        .limit(1);
      if (!conv) throw notFound('Conversation not found');

      const conds = [
        eq(messages.conversationId, conversationId),
        eq(messages.workspaceId, workspaceId),
        isNull(messages.deletedAt),
      ];
      if (q.before) {
        const { ms, id } = decodeCursor(q.before);
        conds.push(
          sql`(messages.created_at, messages.id) < (to_timestamp(${ms} / 1000.0), ${id}::uuid)`,
        );
      }
      const rows = await tx
        .select()
        .from(messages)
        .where(and(...conds))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        // Ascending within the page — chat UIs render oldest -> newest.
        items: [...page].reverse().map(toMessageView),
        nextCursor: hasMore && last ? encodeCursor(last.createdAt.getTime(), last.id) : null,
      };
    });
  },

  /**
   * Agent sends a message (REST fallback; the WS gateway calls the same path).
   * Replying to a closed conversation is rejected — reopen it first.
   */
  async sendMessage(
    workspaceId: string,
    role: Role,
    userId: string,
    conversationId: string,
    body: unknown,
  ): Promise<MessageView> {
    assertCapability(role, 'conversations:write');
    assertId(conversationId);
    const input: SendMessageInput = parse(sendMessageSchema, body);

    const result = await withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      const [conv] = await tx
        .select()
        .from(conversations)
        .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.id, conversationId)))
        .limit(1);
      if (!conv) throw notFound('Conversation not found');
      if (conv.status === 'closed') throw badRequest('Conversation is closed');
      return insertMessage(tx, {
        workspaceId,
        conversationId,
        senderType: 'agent',
        senderId: userId,
        input,
      });
    });

    fanOutMessage(workspaceId, conversationId, result.view);
    return result.view;
  },

  /**
   * Visitor sends a message over their authenticated socket. The visitor MUST
   * own the conversation (checked server-side) and it must be open — a closed
   * conversation gets a NEW conversation via visitor_init, never reopened
   * silently.
   */
  async visitorSend(
    workspaceId: string,
    visitorId: string,
    conversationId: string,
    body: unknown,
  ): Promise<MessageView> {
    assertId(conversationId);
    const input: SendMessageInput = parse(sendMessageSchema, body);

    const result = await withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      const [conv] = await tx
        .select()
        .from(conversations)
        .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.id, conversationId)))
        .limit(1);
      // Same 404 for "missing" and "not yours" — no cross-tenant existence leak.
      if (!conv || conv.visitorId !== visitorId) throw notFound('Conversation not found');
      if (conv.status === 'closed') throw badRequest('Conversation is closed');
      return insertMessage(tx, {
        workspaceId,
        conversationId,
        senderType: 'visitor',
        senderId: visitorId,
        input,
      });
    });

    fanOutMessage(workspaceId, conversationId, result.view);
    return result.view;
  },
};

/** Shared insert path: idempotency + message row + conversation bump. */
async function insertMessage(
  tx: ReturnType<typeof currentTx>,
  args: {
    workspaceId: string;
    conversationId: string;
    senderType: 'agent' | 'visitor';
    senderId: string;
    input: { body: string; idempotencyKey?: string };
  },
): Promise<{ view: MessageView }> {
  if (args.input.idempotencyKey) {
    const existing = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.workspaceId, args.workspaceId),
          eq(messages.idempotencyKey, args.input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing[0]) return { view: toMessageView(existing[0]) };
  }

  const [row] = await tx
    .insert(messages)
    .values({
      workspaceId: args.workspaceId,
      conversationId: args.conversationId,
      senderType: args.senderType,
      senderId: args.senderId,
      body: args.input.body,
      idempotencyKey: args.input.idempotencyKey ?? null,
    })
    .returning();
  if (!row) throw new AppError('internal_error', 'Failed to persist message', 500);
  await tx
    .update(conversations)
    .set({ lastMessageAt: row.createdAt })
    .where(eq(conversations.id, args.conversationId));
  return { view: toMessageView(row) };
}

/** Push a committed message to sockets (conversation room + inbox refresh). */
function fanOutMessage(workspaceId: string, conversationId: string, message: MessageView): void {
  emitToConversation(conversationId, 'message:new', { conversationId, message });
  emitToWorkspace(workspaceId, 'conversation:updated', {
    conversationId,
    lastMessageAt: message.createdAt,
  });
}
