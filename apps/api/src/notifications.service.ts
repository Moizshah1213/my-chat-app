import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import { conflict, notFound } from '@livechat/shared';
import {
  conversationNotificationPreferences,
  currentTx,
  mobilePushTokens,
  refreshTokens,
  withTenant,
} from '@livechat/db';

const DB_URL = () => process.env.DATABASE_URL!;
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

async function activePushTokens(workspaceId: string, conversationId: string, excludedUserId?: string) {
  return withTenant(DB_URL(), workspaceId, async () => {
    const tx = currentTx();
    const conditions = [
      eq(mobilePushTokens.workspaceId, workspaceId),
      isNull(refreshTokens.revokedAt),
      gt(refreshTokens.expiresAt, new Date()),
    ];
    if (excludedUserId) conditions.push(ne(mobilePushTokens.userId, excludedUserId));
    return tx
      .select({ token: mobilePushTokens.token, userId: mobilePushTokens.userId })
      .from(mobilePushTokens)
      .innerJoin(
        refreshTokens,
        and(
          eq(refreshTokens.userId, mobilePushTokens.userId),
          eq(refreshTokens.workspaceId, mobilePushTokens.workspaceId),
          eq(refreshTokens.familyId, mobilePushTokens.sessionId),
          isNull(refreshTokens.revokedAt),
          gt(refreshTokens.expiresAt, new Date()),
        ),
      )
      .where(and(...conditions))
      .then(async (tokens) => {
        const paused = await tx
          .select({ userId: conversationNotificationPreferences.userId })
          .from(conversationNotificationPreferences)
          .where(and(
            eq(conversationNotificationPreferences.workspaceId, workspaceId),
            eq(conversationNotificationPreferences.conversationId, conversationId),
            eq(conversationNotificationPreferences.paused, true),
          ));
        const pausedUsers = new Set(paused.map((row) => row.userId));
        return tokens
          .filter((entry) => !pausedUsers.has(entry.userId))
          .map(({ token }) => ({ token }));
      });
  });
}

async function sendPush(
  tokens: Array<{ token: string }>,
  conversationId: string,
  title: string,
  body: string,
  eventKey: string,
) {
  for (let offset = 0; offset < tokens.length; offset += 100) {
    const batch = tokens.slice(offset, offset + 100);
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(batch.map(({ token }) => ({
        to: token,
        title,
        body,
        sound: 'default',
        channelId: 'messages-v2',
        priority: 'high',
        data: { type: 'new_message', source: 'push', conversationId, eventKey },
      }))),
    });
    if (!response.ok) {
      throw new Error(`Expo push service returned HTTP ${response.status}`);
    }
    const result = await response.json() as {
      data?: Array<{ status?: string; message?: string; details?: { error?: string } }>;
    };
    for (const ticket of result.data ?? []) {
      if (ticket.status === 'error') {
        console.error('[push] Expo rejected a notification:', ticket.details?.error ?? ticket.message ?? 'unknown error');
      }
    }
  }
}

export const notificationsService = {
  async registerPushToken(workspaceId: string, userId: string, sessionId: string, token: string) {
    return withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      const [existing] = await tx
        .select()
        .from(mobilePushTokens)
        .where(eq(mobilePushTokens.token, token))
        .limit(1);
      if (existing && existing.userId !== userId) {
        throw conflict('This device notification token is already registered to another account');
      }
      if (existing) {
        await tx
          .update(mobilePushTokens)
          .set({ sessionId, updatedAt: new Date() })
          .where(and(
            eq(mobilePushTokens.id, existing.id),
            eq(mobilePushTokens.userId, userId),
          ));
      } else {
        await tx.insert(mobilePushTokens).values({ workspaceId, sessionId, userId, token }).onConflictDoNothing();
        const [registered] = await tx
          .select({ userId: mobilePushTokens.userId, workspaceId: mobilePushTokens.workspaceId })
          .from(mobilePushTokens)
          .where(eq(mobilePushTokens.token, token))
          .limit(1);
        if (registered?.userId !== userId || registered.workspaceId !== workspaceId) {
          throw conflict('This device notification token is already registered to another account');
        }
      }
      return { ok: true as const };
    });
  },

  async unregisterPushToken(workspaceId: string, userId: string, token: string) {
    return withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      const deleted = await tx
        .delete(mobilePushTokens)
        .where(and(
          eq(mobilePushTokens.workspaceId, workspaceId),
          eq(mobilePushTokens.userId, userId),
          eq(mobilePushTokens.token, token),
        ))
        .returning({ id: mobilePushTokens.id });
      if (!deleted.length) throw notFound('Notification device not found');
      return { ok: true as const };
    });
  },

  async notifyVisitorMessage(workspaceId: string, conversationId: string, eventKey: string) {
    const tokens = await activePushTokens(workspaceId, conversationId);
    await sendPush(tokens, conversationId, 'New customer message', 'A customer sent a message to your workspace.', eventKey);
  },

  async notifyAgentReply(workspaceId: string, conversationId: string, senderId: string, eventKey: string) {
    const tokens = await activePushTokens(workspaceId, conversationId, senderId);
    await sendPush(tokens, conversationId, 'Agent replied', 'A teammate replied in a conversation.', eventKey);
  },

  async notifyAiReply(workspaceId: string, conversationId: string, eventKey: string) {
    const tokens = await activePushTokens(workspaceId, conversationId);
    await sendPush(tokens, conversationId, 'AI replied', 'The assistant replied to a customer.', eventKey);
  },
};
