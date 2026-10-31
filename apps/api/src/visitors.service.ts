import { desc, eq, and, isNull } from 'drizzle-orm';
import { visitors, conversations } from '@livechat/db';
import { withTenant, currentTx } from '@livechat/db';
import {
  badRequest,
  forbidden,
  notFound,
  listVisitorsSchema,
  updateVisitorSchema,
  roleCan,
  type Role,
} from '@livechat/shared';
import { parse } from './validation.js';

export interface VisitorView {
  id: string;
  name: string | null;
  displayName: string;
  email: string | null;
  number: number | null;
  country: string | null;
  city: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
  currentUrl: string | null;
  referrer: string | null;
  tags: string[];
  notes: string | null;
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
  const name = row.name ?? null;
  const display = row.displayName ?? name ?? (row.number ? `Guest ${row.number}` : 'Guest');
  return {
    id: row.id,
    name,
    displayName: display,
    email: row.email ?? null,
    number: row.number ?? null,
    country: row.country ?? null,
    city: row.city ?? null,
    browser: row.browser ?? null,
    os: row.os ?? null,
    device: row.device ?? null,
    currentUrl: row.currentUrl ?? null,
    referrer: row.referrer ?? null,
    tags: row.tags ?? [],
    notes: row.notes ?? null,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
    meta: (row.meta ?? {}) as Record<string, unknown>,
  };
}

const DB_URL = () => process.env.DATABASE_URL!;

function assertId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw badRequest('Invalid id');
  }
  return id;
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
          displayName: visitors.displayName,
          email: visitors.email,
          number: visitors.number,
          country: visitors.country,
          city: visitors.city,
          browser: visitors.browser,
          os: visitors.os,
          device: visitors.device,
          currentUrl: visitors.currentUrl,
          referrer: visitors.referrer,
          tags: visitors.tags,
          notes: visitors.notes,
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
          displayName: visitors.displayName,
          email: visitors.email,
          number: visitors.number,
          country: visitors.country,
          city: visitors.city,
          browser: visitors.browser,
          os: visitors.os,
          device: visitors.device,
          currentUrl: visitors.currentUrl,
          referrer: visitors.referrer,
          tags: visitors.tags,
          notes: visitors.notes,
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
        .where(and(
          eq(conversations.workspaceId, workspaceId),
          eq(conversations.visitorId, id),
          isNull(conversations.deletedAt),
        ))
        .orderBy(desc(conversations.lastMessageAt));
      return { ...toVisitorView(row), conversations: convs };
    });
  },
  async update(workspaceId: string, role: Role, id: string, body: unknown): Promise<VisitorView> {
    if (!roleCan(role, 'conversations:read')) throw forbidden('Insufficient role');
    assertId(id);
    const input = parse(updateVisitorSchema, body);
    return withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      const updates: Record<string, unknown> = {};
      if (input.name !== undefined) updates.name = input.name;
      if (input.email !== undefined) updates.email = input.email;
      if (input.displayName !== undefined) updates.displayName = input.displayName;
      if (input.notes !== undefined) updates.notes = input.notes;
      if (input.tags !== undefined) updates.tags = input.tags;
      const [row] = await tx.update(visitors).set(Object.assign({}, updates, { lastSeen: new Date() })).where(eq(visitors.id, id)).returning();
      if (!row) throw notFound('Visitor not found');
      return toVisitorView(row);
    });
  },
};
