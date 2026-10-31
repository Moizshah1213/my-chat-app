import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { aiSettings, aiUsage, conversations, messages } from '@livechat/db';
import { currentTx, withTenant } from '@livechat/db';
import { openSealed } from './crypto.js';
import { assertPublicHttpsUrl } from './ssrf.js';
import { emitToConversation, emitToWorkspace } from './realtime.js';
import { notificationsService } from './notifications.service.js';
import type { MessageView } from './conversations.service.js';

const DB_URL = () => process.env.DATABASE_URL!;
const CONTEXT_WINDOW = 10;
const HUMAN_REPLY_GRACE_MS = 3_000;
const CONNECTED_AGENT_GRACE_MS = 8_000;

/** Advisory per-process agent presence. Replies are still checked in the database. */
const agentCounts = new Map<string, number>();

export function agentConnected(workspaceId: string): void {
  agentCounts.set(workspaceId, (agentCounts.get(workspaceId) ?? 0) + 1);
}

export function agentDisconnected(workspaceId: string): void {
  const count = agentCounts.get(workspaceId) ?? 0;
  if (count <= 1) agentCounts.delete(workspaceId);
  else agentCounts.set(workspaceId, count - 1);
}

export function hasOnlineAgent(workspaceId: string): boolean {
  return (agentCounts.get(workspaceId) ?? 0) > 0;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function buildSystemPrompt(instructions: Record<string, unknown>): string {
  const parts: string[] = [];
  if (instructions.persona) parts.push(`You are ${String(instructions.persona)}.`);
  if (instructions.systemPrompt) parts.push(String(instructions.systemPrompt));
  if (instructions.tone) parts.push(`Maintain a ${String(instructions.tone)} tone.`);
  if (instructions.fallback) {
    parts.push(`If you are unsure, say: "${String(instructions.fallback)}"`);
  }
  if (!parts.length) {
    const legacy = Object.entries(instructions)
      .filter(([, value]) => typeof value === 'string' && value)
      .map(([key, value]) => `${key}: ${value}`);
    if (legacy.length) parts.push(...legacy);
  }
  parts.push(
    'Write concise, professional customer-support replies in plain text. Do not use Markdown, asterisks, decorative symbols, or emojis. Ask only the questions needed to help the customer, and never invent product or business details.',
  );
  return parts.join('\n\n');
}

export function normalizeAiReply(text: string): string {
  return text
    .replace(/```[\w-]*\s*([\s\S]*?)```/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/\*\*(.*?)\*\*/gs, '$1')
    .replace(/__(.*?)__/gs, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/~~(.*?)~~/gs, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[ \t]*[*+-][ \t]+/gm, '')
    .replace(/^[ \t]*[•◦▪][ \t]+/gm, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F\u200D]/gu, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface LlmResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

function appendPath(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
}

export function getProviderErrorDetail(payload: unknown, apiKey: string): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as { error?: { message?: unknown } | string; message?: unknown };
  const error = body.error;
  const message =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && typeof error.message === 'string'
        ? error.message
        : typeof body.message === 'string'
          ? body.message
          : null;
  if (!message) return null;
  return message.split(apiKey).join('[redacted]').slice(0, 500);
}

async function callLlm(
  provider: string,
  baseUrl: string,
  model: string,
  apiKey: string,
  temperature: number,
  maxTokens: number,
  chatMessages: ChatMessage[],
): Promise<LlmResult> {
  const anthropic = provider === 'anthropic';
  const endpoint = anthropic
    ? appendPath(baseUrl, baseUrl.replace(/\/+$/, '').endsWith('/v1') ? 'messages' : 'v1/messages')
    : appendPath(baseUrl, 'chat/completions');

  await assertPublicHttpsUrl(endpoint);

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  let requestBody: Record<string, unknown>;
  if (anthropic) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    requestBody = {
      model,
      max_tokens: maxTokens,
      temperature,
      system: chatMessages.find((message) => message.role === 'system')?.content ?? '',
      messages: chatMessages
        .filter((message) => message.role !== 'system')
        .map(({ role, content }) => ({ role, content })),
    };
  } else {
    headers.authorization = `Bearer ${apiKey}`;
    requestBody = { model, messages: chatMessages, temperature, max_tokens: maxTokens };
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    let detail: string | null = null;
    try {
      detail = getProviderErrorDetail(await response.json(), apiKey);
    } catch {
      // Some providers return a non-JSON body for errors; keep the HTTP status.
    }
    throw new Error(
      `AI provider request failed (${response.status})${detail ? `: ${detail}` : ''}`,
    );
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    content?: { type?: string; text?: string }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  const text = anthropic
    ? (data.content ?? []).filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n')
    : data.choices?.[0]?.message?.content ?? '';

  return {
    text,
    promptTokens: data.usage?.prompt_tokens ?? data.usage?.input_tokens ??
      estimateTokens(chatMessages.map((message) => message.content).join(' ')),
    completionTokens: data.usage?.completion_tokens ?? data.usage?.output_tokens ?? estimateTokens(text),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait briefly for a human to answer, then generate a reply only for the latest
 * visitor message. The conversation row is locked before the final check/insert,
 * so a human send that commits first always suppresses the AI response.
 */
export async function triggerAiReply(
  workspaceId: string,
  conversationId: string,
  visitorMessageId: string,
): Promise<void> {
  try {
    await delay(hasOnlineAgent(workspaceId) ? CONNECTED_AGENT_GRACE_MS : HUMAN_REPLY_GRACE_MS);

    const row = await withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      const [conversation] = await tx
        .select({ status: conversations.status })
        .from(conversations)
        .where(and(
          eq(conversations.workspaceId, workspaceId),
          eq(conversations.id, conversationId),
          isNull(conversations.deletedAt),
        ))
        .limit(1);
      if (!conversation || conversation.status === 'closed') return null;

      const [latest] = await tx
        .select({ id: messages.id, senderType: messages.senderType })
        .from(messages)
        .where(and(
          eq(messages.workspaceId, workspaceId),
          eq(messages.conversationId, conversationId),
          isNull(messages.deletedAt),
        ))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(1);
      if (latest?.id !== visitorMessageId || latest.senderType !== 'visitor') return null;

      const [settings] = await tx
        .select()
        .from(aiSettings)
        .where(eq(aiSettings.workspaceId, workspaceId))
        .limit(1);
      return settings ?? null;
    });

    if (!row || row.mode !== 'auto' || !row.baseUrl || !row.model || !row.apiKeyEnc) return;

    const currentMonth = new Date().toISOString().slice(0, 7);
    const usage = await withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      const [current] = await tx
        .select({ month: aiUsage.month, totalTokens: aiUsage.totalTokens })
        .from(aiUsage)
        .where(eq(aiUsage.workspaceId, workspaceId))
        .limit(1);
      return current ?? null;
    });
    if (
      row.monthlyTokenCap > 0 &&
      usage?.month === currentMonth &&
      usage.totalTokens >= row.monthlyTokenCap
    ) {
      console.warn(`[ai] Monthly token cap reached for workspace ${workspaceId}`);
      return;
    }

    const apiKey = openSealed(row.apiKeyEnc, workspaceId);
    const history = await withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      const rows = await tx
        .select({ senderType: messages.senderType, body: messages.body })
        .from(messages)
        .where(and(
          eq(messages.workspaceId, workspaceId),
          eq(messages.conversationId, conversationId),
          isNull(messages.deletedAt),
        ))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(CONTEXT_WINDOW);
      return rows.reverse();
    });

    const systemPrompt = buildSystemPrompt(row.instructions as Record<string, unknown>);
    const chatMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history.map((message) => ({
        role: message.senderType === 'visitor' ? 'user' as const : 'assistant' as const,
        content: message.body,
      })),
    ];
    emitToConversation(conversationId, 'typing', {
      conversationId,
      typing: true,
      by: 'ai',
      senderId: null,
    });
    let result: LlmResult;
    try {
      result = await callLlm(
        row.provider,
        row.baseUrl,
        row.model,
        apiKey,
        Number(row.temperature),
        row.maxOutputTokens,
        chatMessages,
      );
    } finally {
      emitToConversation(conversationId, 'typing', {
        conversationId,
        typing: false,
        by: 'ai',
        senderId: null,
      });
    }
    const reply = normalizeAiReply(result.text);
    if (!reply) return;

    const inserted = await withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      const [conversation] = await tx
        .select({ id: conversations.id, status: conversations.status })
        .from(conversations)
        .where(and(
          eq(conversations.workspaceId, workspaceId),
          eq(conversations.id, conversationId),
          isNull(conversations.deletedAt),
        ))
        .for('update')
        .limit(1);
      if (!conversation || conversation.status === 'closed') return null;

      const [latest] = await tx
        .select({ id: messages.id, senderType: messages.senderType })
        .from(messages)
        .where(and(
          eq(messages.workspaceId, workspaceId),
          eq(messages.conversationId, conversationId),
          isNull(messages.deletedAt),
        ))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(1);
      if (latest?.id !== visitorMessageId || latest.senderType !== 'visitor') return null;

      const [message] = await tx
        .insert(messages)
        .values({
          workspaceId,
          conversationId,
          senderType: 'ai',
          body: reply,
          idempotencyKey: `ai-reply:${visitorMessageId}`,
        })
        .onConflictDoNothing()
        .returning();
      if (!message) return null;

      await tx
        .update(conversations)
        .set({ lastMessageAt: message.createdAt })
        .where(eq(conversations.id, conversationId));
      return message;
    });
    if (!inserted) return;

    const messageView: MessageView = {
      id: inserted.id,
      conversationId: inserted.conversationId,
      senderType: inserted.senderType,
      senderId: inserted.senderId,
      body: inserted.body,
      bodyType: inserted.bodyType,
      createdAt: inserted.createdAt,
    };
    emitToConversation(conversationId, 'message:new', { conversationId, message: messageView });
    emitToWorkspace(workspaceId, 'conversation:updated', {
      conversationId,
      lastMessageAt: inserted.createdAt,
      lastMessageSenderType: inserted.senderType,
      lastMessageSenderId: inserted.senderId,
    });
    void notificationsService.notifyAiReply(
      workspaceId,
      conversationId,
      `${conversationId}:${inserted.createdAt.toISOString()}`,
    ).catch((error: unknown) => {
      console.error('[push] Could not notify mobile devices about an AI reply:', error);
    });

    const totalTokens = result.promptTokens + result.completionTokens;
    await withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      await tx
        .insert(aiUsage)
        .values({
          workspaceId,
          month: currentMonth,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          totalTokens,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [aiUsage.workspaceId, aiUsage.month],
          set: {
            month: currentMonth,
            promptTokens: sql`CASE WHEN ai_usage.month = ${currentMonth}
              THEN ai_usage.prompt_tokens + ${result.promptTokens}
              ELSE ${result.promptTokens} END`,
            completionTokens: sql`CASE WHEN ai_usage.month = ${currentMonth}
              THEN ai_usage.completion_tokens + ${result.completionTokens}
              ELSE ${result.completionTokens} END`,
            totalTokens: sql`CASE WHEN ai_usage.month = ${currentMonth}
              THEN ai_usage.total_tokens + ${totalTokens}
              ELSE ${totalTokens} END`,
            updatedAt: new Date(),
          },
        });
    });
    console.log(`[ai] auto-replied to conversation ${conversationId} | ${totalTokens} tokens`);
  } catch (error) {
    console.error('[ai] Auto-reply failed:', error);
  }
}
