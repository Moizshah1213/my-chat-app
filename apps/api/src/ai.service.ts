import { eq } from 'drizzle-orm';
import { aiSettings } from '@livechat/db';
import { withTenant, currentTx } from '@livechat/db';
import { badRequest, forbidden, roleCan, type Role, type UpdateAiSettingsInput } from '@livechat/shared';
import { assertPublicHttpsUrl } from './ssrf.js';
import { seal } from './crypto.js';

const DB_URL = () => process.env.DATABASE_URL!;

export interface AiSettingsView {
  mode: string;
  provider: string;
  baseUrl: string | null;
  model: string | null;
  apiKeyLast4: string | null;
  instructions: Record<string, unknown>;
  temperature: number;
  maxOutputTokens: number;
  monthlyTokenCap: number;
}

export const aiService = {
  async get(workspaceId: string, role: Role): Promise<AiSettingsView> {
    if (!roleCan(role, 'settings:update')) throw forbidden('Insufficient role');
    return withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      const [row] = await tx.select().from(aiSettings).where(eq(aiSettings.workspaceId, workspaceId)).limit(1);
      if (!row) {
        return { mode: 'off', provider: 'openai_compatible', baseUrl: null, model: null, apiKeyLast4: null, instructions: {}, temperature: 0.3, maxOutputTokens: 400, monthlyTokenCap: 200000 };
      }
      return {
        mode: row.mode,
        provider: row.provider,
        baseUrl: row.baseUrl ?? null,
        model: row.model ?? null,
        apiKeyLast4: row.apiKeyLast4 ?? null,
        instructions: (row.instructions ?? {}) as Record<string, unknown>,
        temperature: Number(row.temperature),
        maxOutputTokens: row.maxOutputTokens,
        monthlyTokenCap: row.monthlyTokenCap,
      };
    });
  },

  async save(workspaceId: string, role: Role, userId: string, input: UpdateAiSettingsInput) {
    if (!roleCan(role, 'settings:update')) throw forbidden('Insufficient role');
    if (input.baseUrl) {
      try {
        await assertPublicHttpsUrl(input.baseUrl);
      } catch {
        throw badRequest('Provider URL must use HTTPS and resolve to a public host on port 443');
      }
    }
    return withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      const [existing] = await tx
        .select()
        .from(aiSettings)
        .where(eq(aiSettings.workspaceId, workspaceId))
        .limit(1);
      const values: typeof aiSettings.$inferInsert = {
        workspaceId,
        mode: input.mode ?? existing?.mode ?? 'off',
        provider: input.provider ?? existing?.provider ?? 'openai_compatible',
        baseUrl: input.baseUrl ?? existing?.baseUrl ?? null,
        model: input.model ?? existing?.model ?? null,
        apiKeyEnc: input.apiKey ? seal(input.apiKey, workspaceId) : existing?.apiKeyEnc ?? null,
        apiKeyLast4: input.apiKey ? input.apiKey.slice(-4) : existing?.apiKeyLast4 ?? null,
        instructions: input.instructions ?? existing?.instructions ?? {},
        temperature: String(input.temperature ?? existing?.temperature ?? 0.3),
        maxOutputTokens: input.maxOutputTokens ?? existing?.maxOutputTokens ?? 400,
        monthlyTokenCap: input.monthlyTokenCap ?? existing?.monthlyTokenCap ?? 200000,
        updatedBy: userId,
        updatedAt: new Date(),
      };
      if (values.mode === 'auto' && (!values.baseUrl || !values.model || !values.apiKeyEnc)) {
        throw badRequest('Automatic replies require a provider URL, model, and API key');
      }
      await tx.insert(aiSettings).values(values).onConflictDoUpdate({ target: aiSettings.workspaceId, set: values });
      return { ok: true };
    });
  },
};
