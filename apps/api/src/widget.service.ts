import { and, desc, eq, isNull } from 'drizzle-orm';
import { visitors, conversations, messages, widgetSettings, workspaces } from '@livechat/db';
import { withTenant, currentTx } from '@livechat/db';
import { notFound, forbidden, AppError, VISITOR_TOKEN_TTL_SECONDS, type VisitorInitInput } from '@livechat/shared';
import { visitorInitSchema } from '@livechat/shared';
import { parse } from './validation.js';
import { sha256 } from './crypto.js';
import { signVisitorToken } from './visitor-jwt.js';
import { config } from './config.js';
import { apiKeyService } from './api-keys.service.js';
import type { MessageView } from './conversations.service.js';

/** Recent-history window returned with visitor_init (oldest→newest on the wire). */
const INIT_HISTORY_LIMIT = 50;

/**
 * WidgetService — the PUBLIC visitor-facing flow (blueprint §7/§9, step 2):
 *   POST /widget/v1/visitor_init
 *     1. resolve/validate the workspace (workspaceId or widget public key)
 *        + enforce the domain allowlist,
 *     2. find-or-create the visitor (stable anonymousId from the widget),
 *     3. resume the visitor's open conversation or open a new one,
 *     4. mint a short-lived visitor JWT for the WebSocket handshake.
 * Everything runs inside withTenant(workspaceId) so RLS scopes every row.
 */

const DB_URL = () => process.env.DATABASE_URL!;

/** Match Origin host against widget_settings.allowed_domains entries.
 *  Entries: "example.com" (exact) or "*.example.com" (subdomain wildcard). */
function hostAllowed(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase();
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase();
    if (!p) return false;
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      return h.endsWith('.' + base) && h !== base;
    }
    return h === p;
  });
}

export interface VisitorInitResult {
  visitorId: string;
  conversationId: string;
  token: string;
  expiresAt: Date;
  /** Recent conversation history (oldest→newest) so a reloaded widget can
   *  re-open the conversation in place — there is no visitor REST read API. */
  messages: MessageView[];
}

export const widgetService = {
  async visitorInit(
    body: unknown,
    meta: { ip?: string; userAgent?: string; origin?: string },
  ): Promise<VisitorInitResult> {
    const input: VisitorInitInput = parse(visitorInitSchema, body);

    // Resolve the workspace: either the caller passed workspaceId directly
    // (tests/legacy), or a widget public key — resolved + verified (live, not
    // revoked) via apiKeyService, which also stamps last_used_at.
    const workspaceId =
      input.workspaceId ?? (await apiKeyService.resolveWorkspaceByPublicKey(input.publicKey!));

    return withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();

      // Workspace lookup: workspaces has no RLS, but the id comes from an
      // unvalidated public body — verify it exists and is active.
      const [ws] = await tx
        .select({ id: workspaces.id, deletedAt: workspaces.deletedAt })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      if (!ws || ws.deletedAt) throw notFound('Unknown workspace');

      // Domain allowlist (blueprint §7: widget must refuse to run on
      // non-allowed origins when configured). widget_settings rows may not
      // exist yet (all defaults) — then the widget is unrestricted.
      const [settings] = await tx
        .select({ allowedDomains: widgetSettings.allowedDomains })
        .from(widgetSettings)
        .where(eq(widgetSettings.workspaceId, workspaceId));
      const allowed = settings?.allowedDomains ?? [];
      if (allowed.length > 0 && meta.origin) {
        let host = '';
        try {
          host = new URL(meta.origin).hostname;
        } catch {
          throw forbidden('Origin not allowed');
        }
        if (!host || !hostAllowed(host, allowed)) throw forbidden('Origin not allowed');
      }

      // Find-or-create the visitor by stable client anonymousId.
      const ipHash = meta.ip ? sha256(`${config.jwt.secret}:${meta.ip}`) : null;
      let [visitor] = await tx
        .insert(visitors)
        .values({
          workspaceId,
          anonId: input.anonymousId,
          name: input.name,
          email: input.email,
          ipHash,
          userAgent: meta.userAgent ?? null,
          // setAttributes(...) metadata lands in visitors.meta (blueprint §6/§11).
          ...(input.attributes ? { meta: input.attributes } : {}),
        })
        .onConflictDoNothing({ target: [visitors.workspaceId, visitors.anonId] })
        .returning();
      if (!visitor) {
        const existing = await tx
          .select()
          .from(visitors)
          .where(
            and(eq(visitors.workspaceId, workspaceId), eq(visitors.anonId, input.anonymousId)),
          );
        visitor = existing[0];
        if (!visitor) throw notFound('Visitor not found');
        // Merge any setAttributes(...) metadata over what's already stored.
        const mergedMeta = input.attributes
          ? { ...((visitor.meta ?? {}) as Record<string, unknown>), ...input.attributes }
          : ((visitor.meta ?? {}) as Record<string, unknown>);
        await tx
          .update(visitors)
          .set({
            lastSeen: new Date(),
            ipHash,
            userAgent: meta.userAgent ?? visitor.userAgent,
            meta: mergedMeta,
          })
          .where(eq(visitors.id, visitor.id));
      }

      // Resume the visitor's open conversation, else open a new one.
      const open = await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.workspaceId, workspaceId),
            eq(conversations.visitorId, visitor.id),
            eq(conversations.status, 'open'),
          ),
        )
        .orderBy(desc(conversations.createdAt))
        .limit(1);
      let conversation = open[0];
      if (!conversation) {
        const [created] = await tx
          .insert(conversations)
          .values({ workspaceId, visitorId: visitor.id })
          .returning();
        conversation = created;
      }
      if (!conversation) throw new AppError('internal_error', 'Failed to create conversation', 500);

      // Recent history for the resumed conversation (keyset-free: the window is
      // small and capped). Newest first from the DB, reversed for display order.
      const history = await tx
        .select({
          id: messages.id,
          conversationId: messages.conversationId,
          senderType: messages.senderType,
          senderId: messages.senderId,
          body: messages.body,
          bodyType: messages.bodyType,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(
          and(
            eq(messages.workspaceId, workspaceId),
            eq(messages.conversationId, conversation.id),
          ),
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(INIT_HISTORY_LIMIT);
      history.reverse();

      const token = signVisitorToken({ sub: visitor.id, workspaceId });
      return {
        visitorId: visitor.id,
        conversationId: conversation.id,
        token,
        expiresAt: new Date(Date.now() + VISITOR_TOKEN_TTL_SECONDS * 1000),
        messages: history,
      };
    });
  },
};
