import { desc, eq, and } from 'drizzle-orm';
import { visitors, conversations } from '@livechat/db';
import { withTenant, currentTx } from '@livechat/db';
import {
  badRequest,
  forbidden,
  notFound,
  listVisitorsSchema,
  roleCan,
  type Role,
} from '@livechat/shared';
import { parse } from './validation.js';

/**
 * VisitorService — the "Visitors list & details" surface (blueprint §12).
 * Read-only views over visitors + their conversations, tenant-scoped via RLS;
 * capability mirrors conversations:read (visitors ARE the conversation peers).
 */

const DB_URL = () => process.env.DATABASE_URL!;

function assertId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw badRequest('Invalid id');
  }
  return id;
}

export interface VisitorView {
  id: string;
  name: string | null;
  email: string | null;
  firstSeen: Date;
  lastSeen: Date;
  meta: Record<string, unknown>;
}

export interface VisitorDetailView extends VisitorView {
  conversations: {
    id: string;
    status: string;
    subject: string | null;
    assignedTo: string | null;
    lastMessageAt: Date;
    createdAt: Date;
  }[];
}

function toVisitorView(row: any): VisitorView {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
    meta: (row.meta ?? {}) as Record<string, unknown>,
  };
}

export const visitorService = {
  async list(workspaceId: string, role: Role, query: unknown): Promise<VisitorView[]> {
    if (!roleCan(role, 'conversations:read')) throw forbidden('Insufficient role for this action');
    const input = parse(listVisitorsSchema, query ?? {});
    return withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      const rows = await tx
        .select({
          id: visitors.id,
          name: visitors.name,
          email: visitors.email,
          firstSeen: visitors.firstSeen,
          lastSeen: visitors.lastSeen,
          meta: visitors.meta,
        })
        .from(visitors)
        .orderBy(desc(visitors.lastSeen))
        .limit(input.limit ?? 50);
      return rows.map(toVisitorView);
    });
  },

  async get(workspaceId: string, role: Role, id: string): Promise<VisitorDetailView> {
    if (!roleCan(role, 'conversations:read')) throw forbidden('Insufficient role for this action');
    assertId(id);
    return withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      const [row] = await tx
        .select({
          id: visitors.id,
          name: visitors.name,
          email: visitors.email,
          firstSeen: visitors.firstSeen,
          lastSeen: visitors.lastSeen,
          meta: visitors.meta,
        })
        .from(visitors)
        .where(and(eq(visitors.workspaceId, workspaceId), eq(visitors.id, id)))
        .limit(1);
      if (!row) throw notFound('Visitor not found');
      const convs = await tx
        .select({
          id: conversations.id,
          status: conversations.status,
          subject: conversations.subject,
          assignedTo: conversations.assignedTo,
          lastMessageAt: conversations.lastMessageAt,
          createdAt: conversations.createdAt,
        })
        .from(conversations)
        .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.visitorId, id)))
        .orderBy(desc(conversations.lastMessageAt));
      return { ...toVisitorView(row), conversations: convs };
    });
  },
};
