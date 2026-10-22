import { desc } from 'drizzle-orm';
import { auditLogs } from '@livechat/db';
import { withTenant, currentTx } from '@livechat/db';
import { forbidden, roleCan, type Role } from '@livechat/shared';

/**
 * Audit log (blueprint §7.4/§8). Append-only trail of privileged actions,
 * tenant-scoped via RLS. Recording is fire-and-forget from controllers (after
 * the mutation commits) and never throws into the request path.
 */

export interface AuditInput {
  actorId?: string | null;
  action: string;
  target?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown>;
}

export interface AuditEntryView {
  id: number;
  actorId: string | null;
  action: string;
  target: string | null;
  ip: string | null;
  createdAt: Date;
  meta: Record<string, unknown>;
}

/** Record one audit entry for a workspace. Never throws. */
export async function recordAuditFor(workspaceId: string, entry: AuditInput): Promise<void> {
  if (!workspaceId) return;
  try {
    await withTenant(process.env.DATABASE_URL!, workspaceId, async () => {
      const tx = currentTx();
      await tx.insert(auditLogs).values({
        workspaceId,
        actorId: entry.actorId ?? null,
        action: entry.action,
        target: entry.target ?? null,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
        meta: entry.meta ?? {},
      });
    });
  } catch (err) {
    // E.1: failures must never vanish silently — always log action + stack.
    const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[audit] failed to record entry action=${entry.action} workspace=${workspaceId}`, stack);
  }
}

/**
 * Explicit non-throwing wrapper for callers that prefer a named helper
 * (E.1). Identical semantics to `void recordAuditFor(...)`: the promise
 * resolves even on failure, so it can never reject into the request path.
 */
export async function safeRecord(workspaceId: string, entry: AuditInput): Promise<void> {
  await recordAuditFor(workspaceId, entry);
}

export const auditService = {
  /** Recent activity for the workspace (owner/admin only). */
  async list(workspaceId: string, role: Role, limit = 100): Promise<AuditEntryView[]> {
    if (!roleCan(role, 'audit:read')) throw forbidden('Insufficient role for this action');
    return withTenant(process.env.DATABASE_URL!, workspaceId, async () => {
      const tx = currentTx();
      const rows = await tx
        .select()
        .from(auditLogs)
        .orderBy(desc(auditLogs.id))
        .limit(Math.min(Math.max(limit, 1), 500));
      return rows.map((r) => ({
        id: r.id,
        actorId: r.actorId,
        action: r.action,
        target: r.target,
        ip: r.ip,
        createdAt: r.createdAt,
        meta: (r.meta ?? {}) as Record<string, unknown>,
      }));
    });
  },
};
