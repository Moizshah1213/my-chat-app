import { eq, and, isNull, gt, desc, ne } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import {
  users,
  workspaces,
  memberships,
  refreshTokens,
  emailTokens,
  type User,
} from '@livechat/db';
import { withoutTenant, currentTx, setTenantContext, setUserContext } from '@livechat/db';
import { sendEmail } from './email.js';
import {
  conflict,
  invalidCredentials,
  badRequest,
  notFound,
  REFRESH_TOKEN_TTL_SECONDS,
  EMAIL_VERIFY_TTL_SECONDS,
  PASSWORD_RESET_TTL_SECONDS,
  MIN_PASSWORD_LENGTH,
} from '@livechat/shared';
import { generateToken, generateUuid, hashToken, hashPassword, verifyPassword } from './crypto.js';
import { signAccessToken, signTempToken, verifyTempToken } from './jwt.js';
import { generateTotpSecret, totpUri, verifyTotp, storeTotpSecret, loadTotpSecret } from './totp.js';

const MAX_FAILED = 8;
const LOCK_MINUTES = 15;

/**
 * Run a small write in its OWN committed transaction (no tenant context).
 * Used for security bookkeeping that must persist even though the surrounding
 * request will then throw (e.g. incrementing the failed-login counter or
 * revoking a refresh-token family) — a throw inside the request transaction
 * would otherwise roll the bookkeeping back.
 */
async function commitGlobalWrite<T>(fn: () => Promise<T>): Promise<T> {
  return withoutTenant(process.env.DATABASE_URL!, fn);
}

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
  const suffix = generateToken(3); // random to avoid collisions
  return `${base || 'ws'}-${suffix}`;
}

export interface SessionResult {
  accessToken: string;
  refreshToken: string;
  user: Pick<User, 'id' | 'email' | 'name' | 'emailVerifiedAt' | 'totpEnabled'>;
  workspaceId: string;
  role: string;
}

/** One active login session (= the newest row of a refresh-token family). */
export interface SessionView {
  id: string; // family id
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
  current: boolean;
}

/**
 * Second-factor check used by login and 2FA-off: TOTP first, then an unused
 * recovery code (argon2id-hashed in users.recovery_codes_hash, CONSUMED on
 * match so each code works exactly once — blueprint §7.1).
 */
async function verifySecondFactor(
  tx: ReturnType<typeof currentTx>,
  user: User,
  code: string,
): Promise<boolean> {
  if (user.totpSecretEnc && verifyTotp(loadTotpSecret(user.totpSecretEnc), code)) return true;
  if (!user.recoveryCodesHash) return false;
  let hashes: unknown;
  try {
    hashes = JSON.parse(user.recoveryCodesHash);
  } catch {
    return false;
  }
  if (!Array.isArray(hashes) || hashes.length === 0) return false;
  const normalized = code.toLowerCase();
  for (let i = 0; i < hashes.length; i++) {
    if (typeof hashes[i] !== 'string') continue;
    if (await verifyPassword(hashes[i], normalized)) {
      const remaining = hashes.filter((_, idx) => idx !== i);
      await tx
        .update(users)
        .set({ recoveryCodesHash: JSON.stringify(remaining) })
        .where(eq(users.id, user.id));
      return true;
    }
  }
  return false;
}

/** Unambiguous recovery code: xxxxx-xxxxx over a no-l/o/0/1 alphabet. */
const RECOVERY_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
function generateRecoveryCode(): string {
  const chars = Array.from(randomBytes(10), (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]);
  return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`;
}

/**
 * AuthService — handles the four core flows for agents/owners.
 * All DB writes run in withoutTenant (users/workspaces/memberships are global or
 * created atomically; RLS is not yet relevant before a workspace context exists).
 */
export const authService = {
  async signup(input: {
    email: string;
    password: string;
    name: string;
    workspaceName: string;
  }): Promise<SessionResult> {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();

      const existing = await tx.select().from(users).where(eq(users.email, input.email));
      if (existing.length > 0) throw conflict('Email already registered');

      if (input.password.length < MIN_PASSWORD_LENGTH)
        throw badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);

      const passwordHash = await hashPassword(input.password);

      // Create user + workspace + owner membership atomically.
      const [user] = await tx
        .insert(users)
        .values({ email: input.email, passwordHash, name: input.name })
        .returning();
      const [ws] = await tx
        .insert(workspaces)
        .values({ name: input.workspaceName, slug: slugify(input.workspaceName) })
        .returning();
      if (!user || !ws) throw conflict('Failed to create account');

      // Now that the workspace exists, set the RLS tenant context on this
      // transaction so the memberships INSERT passes the WITH CHECK policy.
      await setTenantContext(ws.id);

      await tx.insert(memberships).values({
        workspaceId: ws.id,
        userId: user.id,
        role: 'owner',
      });

      // Email verification token (hashed at rest).
      const verifyToken = generateToken();
      await tx.insert(emailTokens).values({
        userId: user.id,
        type: 'verify',
        tokenHash: hashToken(verifyToken),
        expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_SECONDS * 1000),
      });
      await sendEmail({
        to: user.email,
        subject: 'Verify your email',
        text: `Verify your account with this code: ${verifyToken}`,
        devMarker: '[email:verify]',
        devToken: verifyToken,
      });

      const session = await this.issueSession(user, ws.id, 'owner');
      return session;
    });
  },

  async issueSession(
    user: User,
    workspaceId: string,
    role: string,
    meta?: { ip?: string; userAgent?: string },
  ): Promise<SessionResult> {
    const refreshToken = generateToken();
    const familyId = generateUuid();
    const tx = currentTx();

    await tx.insert(refreshTokens).values({
      userId: user.id,
      workspaceId,
      tokenHash: hashToken(refreshToken),
      familyId,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      ip: meta?.ip,
      userAgent: meta?.userAgent,
    });

    const accessToken = signAccessToken({
      sub: user.id,
      workspaceId,
      role: role as 'owner',
      jti: generateToken(8),
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerifiedAt: user.emailVerifiedAt,
        totpEnabled: user.totpEnabled,
      },
      workspaceId,
      role,
    };
  },

  /**
   * Login with brute-force protection (per-account lockout + failed counter).
   * Returns { requires2fa: true, tempToken } when 2FA is enabled and no code
   * was supplied — the client posts tempToken + code to /v1/auth/2fa/verify
   * (mobile two-step flow) OR simply retries login with `totpCode` (one-shot).
   */
  async login(input: {
    email: string;
    password: string;
    totpCode?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<SessionResult | { requires2fa: true; tempToken: string }> {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const [user] = await tx.select().from(users).where(eq(users.email, input.email));

      if (!user) throw invalidCredentials();
      if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
        throw invalidCredentials('Account temporarily locked. Try again later.');
      }

      const ok = await verifyPassword(user.passwordHash, input.password);
      if (!ok) {
        const failed = user.failedLogins + 1;
        const lock = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null;
        // Commit the counter/lockout in its own transaction BEFORE we throw,
        // otherwise the request transaction would roll this security write back.
        await commitGlobalWrite(async () => {
          const t = currentTx();
          await t
            .update(users)
            .set({ failedLogins: failed, lockedUntil: lock })
            .where(eq(users.id, user.id));
        });
        throw invalidCredentials();
      }

      if (user.totpEnabled && !input.totpCode) {
        return { requires2fa: true as const, tempToken: signTempToken(user.id) };
      }
      if (user.totpEnabled && input.totpCode) {
        // TOTP code or a one-time recovery code (consumed on match).
        if (!(await verifySecondFactor(tx, user, input.totpCode))) {
          throw invalidCredentials('Invalid authentication code');
        }
      }

      await tx
        .update(users)
        .set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() })
        .where(eq(users.id, user.id));

      // Allow reading this user's OWN memberships (RLS self policy) to find ws.
      await setUserContext(user.id);
      const [membership] = await tx
        .select()
        .from(memberships)
        .where(eq(memberships.userId, user.id));
      if (!membership) throw badRequest('User has no workspace');

      return this.issueSession(user, membership.workspaceId, membership.role, {
        ip: input.ip,
        userAgent: input.userAgent,
      });
    });
  },

  /**
   * Complete the two-step 2FA login: `tempToken` proves the password already
   * checked out at /login (short-lived, audience-scoped to 2FA only), `code`
   * is a TOTP or an unused recovery code. Issues a full session exactly like
   * `login` — same lockout rules, same counters reset.
   */
  async completeTwoFactorLogin(input: {
    tempToken: string;
    code: string;
    ip?: string;
    userAgent?: string;
  }): Promise<SessionResult> {
    let sub: string;
    try {
      ({ sub } = verifyTempToken(input.tempToken));
    } catch {
      throw invalidCredentials('Invalid or expired 2FA token');
    }
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const [user] = await tx.select().from(users).where(eq(users.id, sub));
      // Deleted account, 2FA turned off in the meantime, or still locked
      // (tempToken was minted before the password check — re-check gates here).
      if (!user || !user.totpEnabled) throw invalidCredentials();
      if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
        throw invalidCredentials('Account temporarily locked. Try again later.');
      }
      if (!(await verifySecondFactor(tx, user, input.code))) {
        throw invalidCredentials('Invalid authentication code');
      }

      await tx
        .update(users)
        .set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() })
        .where(eq(users.id, user.id));

      await setUserContext(user.id);
      const [membership] = await tx
        .select()
        .from(memberships)
        .where(eq(memberships.userId, user.id));
      if (!membership) throw badRequest('User has no workspace');

      return this.issueSession(user, membership.workspaceId, membership.role, {
        ip: input.ip,
        userAgent: input.userAgent,
      });
    });
  },

  /**
   * Refresh with rotation + reuse detection (blueprint §7.1).
   * A token presented twice (already revoked) => revoke the whole family.
   */
  async refresh(presentedToken: string): Promise<SessionResult> {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const hash = hashToken(presentedToken);
      const [stored] = await tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hash));

      if (!stored) throw invalidCredentials('Invalid refresh token');

      if (stored.revokedAt) {
        // Compromise response: revoke the whole family in its OWN committed
        // transaction (a throw here would otherwise roll the revocation back).
        await commitGlobalWrite(async () => {
          const t = currentTx();
          await t
            .update(refreshTokens)
            .set({ revokedAt: new Date() })
            .where(eq(refreshTokens.familyId, stored.familyId));
        });
        throw invalidCredentials('Refresh token reuse detected; sessions revoked');
      }
      if (stored.expiresAt.getTime() < Date.now()) {
        throw invalidCredentials('Refresh token expired');
      }

      const [user] = await tx.select().from(users).where(eq(users.id, stored.userId));
      if (!user) throw invalidCredentials();

      // Rotate: revoke old, insert new in same family.
      const newToken = generateToken();
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.id, stored.id));
      await tx.insert(refreshTokens).values({
        userId: stored.userId,
        workspaceId: stored.workspaceId,
        tokenHash: hashToken(newToken),
        familyId: stored.familyId,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
        ip: stored.ip,
        userAgent: stored.userAgent,
      });

      // Allow reading this user's OWN memberships (RLS self policy).
      await setUserContext(user.id);
      const [membership] = await tx
        .select()
        .from(memberships)
        .where(eq(memberships.userId, user.id));
      const wsId = stored.workspaceId ?? membership!.workspaceId;
      const role = membership?.role ?? 'agent';

      const accessToken = signAccessToken({
        sub: user.id,
        workspaceId: wsId,
        role: role as 'owner',
        jti: generateToken(8),
      });

      return {
        accessToken,
        refreshToken: newToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          emailVerifiedAt: user.emailVerifiedAt,
          totpEnabled: user.totpEnabled,
        },
        workspaceId: wsId,
        role,
      };
    });
  },

  /**
   * Logout: revoke the presented refresh token's whole family (one family =
   * one login session). Idempotent by design — an unknown or already-revoked
   * token is a silent no-op, so logout never leaks token state to a caller.
   */
  async logout(presentedToken: string | undefined): Promise<void> {
    if (!presentedToken) return;
    await commitGlobalWrite(async () => {
      const tx = currentTx();
      const [stored] = await tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hashToken(presentedToken)));
      if (!stored) return; // unknown token: no-op (idempotent)
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(eq(refreshTokens.familyId, stored.familyId), isNull(refreshTokens.revokedAt)),
        );
    });
  },

  async verifyEmail(token: string): Promise<void> {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const hash = hashToken(token);
      const [row] = await tx
        .select()
        .from(emailTokens)
        .where(
          and(
            eq(emailTokens.tokenHash, hash),
            eq(emailTokens.type, 'verify'),
            isNull(emailTokens.usedAt),
            gt(emailTokens.expiresAt, new Date()),
          ),
        );
      if (!row) throw badRequest('Invalid or expired verification token');
      await tx.update(emailTokens).set({ usedAt: new Date() }).where(eq(emailTokens.id, row.id));
      await tx
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(users.id, row.userId));
    });
  },

  /**
   * Re-send the verification email. Always succeeds from the caller's view
   * (no account enumeration); rotates the token so the newest link wins.
   */
  async resendVerification(email: string): Promise<void> {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const [user] = await tx.select().from(users).where(eq(users.email, email));
      if (!user || user.emailVerifiedAt) return; // unknown or already verified: no-op
      const token = generateToken();
      // Rotate: invalidate any outstanding verify tokens so the newest link wins.
      await tx
        .update(emailTokens)
        .set({ usedAt: new Date() })
        .where(
          and(eq(emailTokens.userId, user.id), eq(emailTokens.type, 'verify'), isNull(emailTokens.usedAt)),
        );
      await tx.insert(emailTokens).values({
        userId: user.id,
        type: 'verify',
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_SECONDS * 1000),
      });
      await sendEmail({
        to: user.email,
        subject: 'Verify your email',
        text: `Verify your account with this code: ${token}`,
        devMarker: '[email:verify]',
        devToken: token,
      });
    });
  },

  async forgotPassword(email: string): Promise<void> {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const [user] = await tx.select().from(users).where(eq(users.email, email));
      if (!user) return; // no enumeration
      const token = generateToken();
      await tx.insert(emailTokens).values({
        userId: user.id,
        type: 'reset',
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_SECONDS * 1000),
      });
      await sendEmail({
        to: user.email,
        subject: 'Reset your password',
        text: `Reset your password with this code: ${token}`,
        devMarker: '[email:reset]',
        devToken: token,
      });
    });
  },

  async resetPassword(token: string, newPassword: string): Promise<void> {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const hash = hashToken(token);
      const [row] = await tx
        .select()
        .from(emailTokens)
        .where(
          and(
            eq(emailTokens.tokenHash, hash),
            eq(emailTokens.type, 'reset'),
            isNull(emailTokens.usedAt),
            gt(emailTokens.expiresAt, new Date()),
          ),
        );
      if (!row) throw badRequest('Invalid or expired reset token');
      if (newPassword.length < MIN_PASSWORD_LENGTH)
        throw badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);

      await tx.update(emailTokens).set({ usedAt: new Date() }).where(eq(emailTokens.id, row.id));
      const passwordHash = await hashPassword(newPassword);
      await tx
        .update(users)
        .set({ passwordHash, failedLogins: 0, lockedUntil: null })
        .where(eq(users.id, row.userId));

      // Invalidate all sessions after reset.
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.userId, row.userId), isNull(refreshTokens.revokedAt)));
    });
  },

  // ---- Two-factor authentication (blueprint §7.1) ----------------------------

  /** Step 1: mint a pending TOTP secret (encrypted at rest) — NOT yet enabled. */
  async setup2fa(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const [user] = await tx.select().from(users).where(eq(users.id, userId));
      if (!user) throw badRequest('Unknown user');
      const secret = generateTotpSecret();
      await tx
        .update(users)
        .set({ totpSecretEnc: storeTotpSecret(secret), totpEnabled: false })
        .where(eq(users.id, userId));
      return { secret, otpauthUrl: totpUri(secret, user.email) };
    });
  },

  /** Step 2: confirm a code from the authenticator app → enable + recovery codes (ONCE). */
  async enable2fa(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const [user] = await tx.select().from(users).where(eq(users.id, userId));
      if (!user) throw badRequest('Unknown user');
      if (user.totpEnabled) throw badRequest('Two-factor authentication is already enabled');
      if (!user.totpSecretEnc) throw badRequest('Start 2FA setup first');
      if (!verifyTotp(loadTotpSecret(user.totpSecretEnc), code)) {
        throw invalidCredentials('Invalid authentication code');
      }
      const recoveryCodes = Array.from({ length: 10 }, () => generateRecoveryCode());
      const hashes = await Promise.all(recoveryCodes.map((c) => hashPassword(c)));
      await tx
        .update(users)
        .set({ totpEnabled: true, recoveryCodesHash: JSON.stringify(hashes) })
        .where(eq(users.id, userId));
      return { recoveryCodes };
    });
  },

  /** Turn 2FA off: password + a valid TOTP or recovery code; clears secret + codes. */
  async disable2fa(userId: string, password: string, code: string): Promise<void> {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const [user] = await tx.select().from(users).where(eq(users.id, userId));
      if (!user) throw badRequest('Unknown user');
      if (!user.totpEnabled) throw badRequest('Two-factor authentication is not enabled');
      if (!(await verifyPassword(user.passwordHash, password))) throw invalidCredentials();
      if (!(await verifySecondFactor(tx, user, code))) {
        throw invalidCredentials('Invalid authentication code');
      }
      await tx
        .update(users)
        .set({ totpEnabled: false, totpSecretEnc: null, recoveryCodesHash: null })
        .where(eq(users.id, userId));
    });
  },

  // ---- Session management (blueprint §7.1 "log out everywhere") ---------------

  /** Active login sessions — one entry per refresh-token family. */
  async listSessions(userId: string, currentToken?: string): Promise<SessionView[]> {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const rows = await tx
        .select()
        .from(refreshTokens)
        .where(
          and(
            eq(refreshTokens.userId, userId),
            isNull(refreshTokens.revokedAt),
            gt(refreshTokens.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(refreshTokens.createdAt));
      const currentHash = currentToken ? hashToken(currentToken) : null;
      const byFamily = new Map<string, SessionView>();
      for (const r of rows) {
        // Newest row per family = the currently-valid token of that session.
        if (byFamily.has(r.familyId)) continue;
        byFamily.set(r.familyId, {
          id: r.familyId,
          ip: r.ip,
          userAgent: r.userAgent,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          current: currentHash !== null && r.tokenHash === currentHash,
        });
      }
      return [...byFamily.values()];
    });
  },

  /** Revoke ONE session (its whole family), scoped to the requesting user. */
  async revokeSession(userId: string, familyId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(familyId)) throw badRequest('Invalid session id');
    await commitGlobalWrite(async () => {
      const tx = currentTx();
      const revoked = await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(refreshTokens.userId, userId),
            eq(refreshTokens.familyId, familyId),
            isNull(refreshTokens.revokedAt),
          ),
        )
        .returning({ id: refreshTokens.id });
      if (revoked.length === 0) throw notFound('Session not found');
    });
  },

  /** "Log out everywhere": revoke every session except the one making the call. */
  async revokeOtherSessions(
    userId: string,
    currentToken?: string,
  ): Promise<{ revoked: number }> {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const keepHash = currentToken ? hashToken(currentToken) : null;
      const revoked = await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(refreshTokens.userId, userId),
            isNull(refreshTokens.revokedAt),
            keepHash ? ne(refreshTokens.tokenHash, keepHash) : undefined,
          ),
        )
        .returning({ id: refreshTokens.id });
      return { revoked: revoked.length };
    });
  },
};
