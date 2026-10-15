import { and, desc, eq, isNull } from 'drizzle-orm';
import { apiKeys } from '@livechat/db';
import { withTenant, currentTx } from '@livechat/db';
import {
  notFound,
  forbidden,
  conflict,
  roleCan,
  createApiKeySchema,
  type Capability,
  type Role,
} from '@livechat/shared';
import { randomBytes } from 'node:crypto';
import { parse } from './validation.js';

/**
 * ApiKeyService — widget public keys (blueprint §7.3).
 *
 * Key format: `pk_<workspaceId-hex>_<random>`.
 *  - The workspaceId segment routes the key to its tenant BEFORE any RLS
 *    context exists (Intercom-style app_id), so the PUBLIC widget endpoints
 *    (visitor_init, settings fetch) can resolve a key without a token.
 *  - The full string is still verified against the api_keys row inside
 *    withTenant() on every use — the random segment is the capability, a
 *    forged key with a valid workspace segment but garbage tail fails there.
 *  - api_keys has FORCE RLS, so resolution MUST go through withTenant; the
 *    workspace UUID alone grants nothing (signup/login are email+password).
 */

/** Mint a public key for a workspace (called inside that workspace's context). */
export function generatePublicKey(workspaceId: string): string {
  const rand = randomBytes(18).toString('base64url'); // 144 bits
  return `pk_${workspaceId.replace(/-/g, '')}_${rand}`;
}

const PUBLIC_KEY_RE = /^pk_([0-9a-f]{32})_[A-Za-z0-9_-]{10,}$/;

/** Extract the workspace UUID embedded in a pk_… key, or null if malformed. */
export function workspaceIdFromPublicKey(publicKey: string): string | null {
  const m = PUBLIC_KEY_RE.exec(publicKey);
  if (!m?.[1]) return null;
  const hex = m[1];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertCapability(role: Role, capability: Capability) {
  if (!roleCan(role, capability)) throw forbidden('Insufficient role for this action');
}

/** Wire shape — secretHash is NEVER returned to any client. */
export interface ApiKeyView {
  id: string;
  name: string;
  publicKey: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export const apiKeyService = {
  /** List the workspace's keys (metadata only, newest first). */
  async list(workspaceId: string, role: Role): Promise<ApiKeyView[]> {
    assertCapability(role, 'apikeys:read');
    return withTenant(process.env.DATABASE_URL!, workspaceId, async () => {
      const tx = currentTx();
      const rows = await tx
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          publicKey: apiKeys.publicKey,
          createdAt: apiKeys.createdAt,
          lastUsedAt: apiKeys.lastUsedAt,
          revokedAt: apiKeys.revokedAt,
        })
        .from(apiKeys)
        .orderBy(desc(apiKeys.createdAt));
      return rows;
    });
  },

  /** Mint a new widget key. The full pk_… string is returned ONCE here. */
  async create(workspaceId: string, role: Role, body: unknown): Promise<ApiKeyView> {
    assertCapability(role, 'apikeys:manage');
    const input = parse(createApiKeySchema, body);
    const publicKey = generatePublicKey(workspaceId);

    return withTenant(process.env.DATABASE_URL!, workspaceId, async () => {
      const tx = currentTx();
      const [row] = await tx
        .insert(apiKeys)
        .values({ workspaceId, name: input.name, publicKey })
        .returning();
      if (!row) throw conflict('Failed to create API key');
      return {
        id: row.id,
        name: row.name,
        publicKey: row.publicKey,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        revokedAt: row.revokedAt,
      };
    });
  },

  /**
   * Revoke a key. Idempotent: revoking an already-revoked key is a no-op
   * success; a key that never existed in THIS workspace is 404 (indistinguishable
   * across tenants — RLS scopes the lookup to the caller's workspace).
   */
  async revoke(
    workspaceId: string,
    role: Role,
    keyId: string,
  ): Promise<{ ok: true; revokedAt: Date }> {
    assertCapability(role, 'apikeys:manage');
    return withTenant(process.env.DATABASE_URL!, workspaceId, async () => {
      const tx = currentTx();
      const [revoked] = await tx
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
        .returning({ id: apiKeys.id, revokedAt: apiKeys.revokedAt });
      if (revoked?.revokedAt) return { ok: true as const, revokedAt: revoked.revokedAt };

      const [existing] = await tx
        .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
        .from(apiKeys)
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.workspaceId, workspaceId)));
      if (!existing?.revokedAt) throw notFound('API key not found');
      return { ok: true as const, revokedAt: existing.revokedAt };
    });
  },

  /**
   * PUBLIC (unauthenticated): resolve a widget key to its workspace and verify
   * it is live. The workspaceId is embedded in the key so we can enter the
   * tenant context; the UPDATE…RETURNING verifies the full key string against
   * the (RLS-scoped) row AND stamps last_used_at in one round trip. Unknown,
   * malformed, or revoked keys are 404.
   */
  async resolveWorkspaceByPublicKey(publicKey: string): Promise<string> {
    const workspaceId = workspaceIdFromPublicKey(publicKey);
    if (!workspaceId) throw notFound('Unknown widget key');

    return withTenant(process.env.DATABASE_URL!, workspaceId, async () => {
      const tx = currentTx();
      const [row] = await tx
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(and(eq(apiKeys.publicKey, publicKey), isNull(apiKeys.revokedAt)))
        .returning({ workspaceId: apiKeys.workspaceId });
      if (!row) throw notFound('Unknown widget key');
      return row.workspaceId;
    });
  },
};
