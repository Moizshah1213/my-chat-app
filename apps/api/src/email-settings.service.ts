import { eq } from 'drizzle-orm';
import { emailSettings } from '@livechat/db';
import { withTenant, currentTx } from '@livechat/db';
import { forbidden, roleCan, type Role } from '@livechat/shared';
import { emailSettingsSchema, type EmailSettingsInput } from '@livechat/shared';
import { seal } from './crypto.js';

export interface EmailSettingsView {
  provider: string;
  host: string | null;
  port: number | null;
  user: string | null;
  fromEmail: string | null;
  fromName: string | null;
  verifiedAt: Date | null;
}

const DB_URL = () => process.env.DATABASE_URL!;

export const emailSettingsService = {
  async get(workspaceId: string, role: Role): Promise<EmailSettingsView> {
    if (!roleCan(role, 'settings:update')) throw forbidden('Insufficient role');
    return withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      const [row] = await tx
        .select()
        .from(emailSettings)
        .where(eq(emailSettings.workspaceId, workspaceId))
        .limit(1);
      if (!row) {
        return {
          provider: 'smtp',
          host: null,
          port: null,
          user: null,
          fromEmail: null,
          fromName: null,
          verifiedAt: null,
        };
      }
      return {
        provider: row.provider,
        host: row.host,
        port: row.port,
        user: row.user,
        fromEmail: row.fromEmail,
        fromName: row.fromName,
        verifiedAt: row.verifiedAt ? new Date(row.verifiedAt) : null,
      };
    });
  },

  async save(
    workspaceId: string,
    role: Role,
    userId: string,
    input: EmailSettingsInput,
  ): Promise<{ ok: true }> {
    if (!roleCan(role, 'settings:update')) throw forbidden('Insufficient role');
    const toSave: Record<string, unknown> = {
      workspaceId,
      provider: input.provider ?? 'smtp',
      host: input.host ?? null,
      port: input.port ?? null,
      user: input.user ?? null,
      fromName: input.fromName ?? null,
      updatedBy: userId,
      updatedAt: new Date(),
    };
    if (input.password) {
      toSave.passwordEnc = await seal(input.password, workspaceId);
    }
    if (input.fromEmail) {
      toSave.fromEmail = input.fromEmail.toLowerCase();
    } else if (input.fromEmail === null) {
      toSave.fromEmail = null;
    }
    await withTenant(DB_URL(), workspaceId, async () => {
      const tx = currentTx();
      await tx
        .insert(emailSettings)
        .values(toSave as typeof emailSettings.$inferInsert)
        .onConflictDoUpdate({
          target: emailSettings.workspaceId,
          set: toSave,
        });
    });
    return { ok: true };
  },
};
