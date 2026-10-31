import { eq, and, isNull, gt, desc, ne, lt, inArray, or } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import {
  users,
  userAvatars,
  workspaces,
  memberships,
  refreshTokens,
  emailTokens,
  qrLoginChallenges,
  type User,
} from '@livechat/db';
import { withoutTenant, currentTx, setTenantContext, setUserContext } from '@livechat/db';
import { sendEmail } from './email.js';
import {
  conflict,
  invalidCredentials,
  badRequest,
  forbidden,
  notFound,
  REFRESH_TOKEN_TTL_SECONDS,
  EMAIL_VERIFY_TTL_SECONDS,
  PASSWORD_RESET_TTL_SECONDS,
  MIN_PASSWORD_LENGTH,
  type Role,
} from '@livechat/shared';
import { generateToken, generateUuid, hashToken, hashPassword, verifyPassword } from './crypto.js';
import { signAccessToken, signTempToken, verifyTempToken } from './jwt.js';
import { generateTotpSecret, totpUri, verifyTotp, storeTotpSecret, loadTotpSecret } from './totp.js';
import type { GoogleIdentity } from './google-auth.js';

const MAX_FAILED = 8;
const LOCK_MINUTES = 15;

function isMembershipRole(value: string): value is Role {
  return value === 'owner' || value === 'admin' || value === 'agent';
}

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
  twoFactorSkipped: boolean;
  user: Pick<User, 'id' | 'email' | 'name' | 'phone' | 'avatarUrl' | 'emailVerifiedAt' | 'totpEnabled'>;
  workspaceId: string;
  role: string;
}

export interface SignupVerificationRequired {
  requiresEmailVerification: true;
  email: string;
  workspaceId: string;
  userId: string;
}

type SignupMethod = {
  (input: { email: string; password: string; name: string; workspaceName: string }): Promise<SessionResult>;
  (
    input: { email: string; password: string; name: string; workspaceName: string },
    requireEmailVerification: true,
  ): Promise<SignupVerificationRequired>;
};

function verificationEmailContent(token: string) {
  const appName = process.env.PRODUCT_NAME ?? 'Qonvilo';
  const origin = (process.env.PUBLIC_APP_ORIGIN ?? 'http://localhost:3000').replace(/\/+$/, '');
  const verifyUrl = new URL('/verify-email', origin);
  verifyUrl.searchParams.set('token', token);
  const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]!);
  const safeAppName = escapeHtml(appName);
  const safeVerifyUrl = escapeHtml(verifyUrl.toString());
  const expiryHours = Math.max(1, Math.round(EMAIL_VERIFY_TTL_SECONDS / 3600));

  return {
    subject: `Confirm your email for ${appName}`,
    text: [
      `Hello,`,
      '',
      `Thanks for creating a ${appName} account. Confirm that this email address belongs to you by opening the link below:`,
      '',
      verifyUrl.toString(),
      '',
      `This link expires in ${expiryHours} hours and can only be used once. If you did not create this account, you can ignore this email.`,
      '',
      `${appName} Support`,
    ].join('\n'),
    html: `<div style="margin:0;padding:36px 16px;background:#f5f5f6;font-family:Arial,Helvetica,sans-serif;color:#171719"><table role="presentation" style="width:100%;max-width:560px;margin:0 auto;border-collapse:collapse"><tr><td style="padding:28px;background:#fff;border:1px solid #e8e8eb;border-radius:16px"><p style="margin:0 0 24px;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#68686f">${safeAppName}</p><h1 style="margin:0 0 14px;font-size:24px;line-height:1.3;color:#171719">Confirm your email</h1><p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#55555c">Thanks for creating an account. Confirm this email address to finish setting up your workspace.</p><p style="margin:0 0 24px"><a href="${safeVerifyUrl}" style="display:inline-block;padding:12px 20px;border-radius:999px;background:#171719;color:#fff;text-decoration:none;font-size:14px;font-weight:600">Confirm email address</a></p><p style="margin:0 0 10px;font-size:12px;line-height:1.6;color:#77777e">This link expires in ${expiryHours} hours and can only be used once.</p><p style="margin:0;font-size:12px;line-height:1.6;color:#77777e">If you did not create this account, you can safely ignore this email.</p></td></tr><tr><td style="padding:16px 8px;text-align:center;font-size:11px;color:#8a8a90">Sent by ${safeAppName}</td></tr></table></div>`,
  };
}

/** One active login session (= the newest row of a refresh-token family). */
export interface SessionView {
  id: string; // family id
  ip: string | null;
  userAgent: string | null;
  location: string | null;
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
  async startQrLogin(pollToken: string, origin: string) {
    const challengeToken = generateToken();
    const expiresAt = new Date(Date.now() + 3 * 60_000);
    await withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      await tx.delete(qrLoginChallenges).where(
        lt(qrLoginChallenges.expiresAt, new Date(Date.now() - 24 * 60 * 60_000)),
      );
      await tx.insert(qrLoginChallenges).values({
        challengeHash: hashToken(challengeToken),
        pollTokenHash: hashToken(pollToken),
        origin,
        expiresAt,
      });
    });
    return { challengeToken, expiresAt };
  },

  async inspectQrLogin(challengeToken: string) {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const [challenge] = await tx
        .select({
          origin: qrLoginChallenges.origin,
          status: qrLoginChallenges.status,
          expiresAt: qrLoginChallenges.expiresAt,
        })
        .from(qrLoginChallenges)
        .where(eq(qrLoginChallenges.challengeHash, hashToken(challengeToken)))
        .limit(1);
      if (!challenge) throw notFound('QR sign-in request not found');
      return {
        origin: challenge.origin,
        status: challenge.expiresAt.getTime() <= Date.now() ? 'expired' : challenge.status,
        expiresAt: challenge.expiresAt,
      };
    });
  },

  async approveQrLogin(
    challengeToken: string,
    auth: { userId: string; workspaceId: string; role: string; sessionId?: string },
  ) {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const now = new Date();
      const [currentSession] = auth.sessionId
        ? await tx
            .select({ twoFactorSkipped: refreshTokens.twoFactorSkipped })
            .from(refreshTokens)
            .where(and(
              eq(refreshTokens.userId, auth.userId),
              eq(refreshTokens.familyId, auth.sessionId),
              isNull(refreshTokens.revokedAt),
              gt(refreshTokens.expiresAt, now),
            ))
            .limit(1)
        : [];
      const [approved] = await tx
        .update(qrLoginChallenges)
        .set({
          status: 'approved',
          approvedBy: auth.userId,
          workspaceId: auth.workspaceId,
          role: auth.role,
          twoFactorSkipped: Boolean(currentSession?.twoFactorSkipped),
        })
        .where(and(
          eq(qrLoginChallenges.challengeHash, hashToken(challengeToken)),
          eq(qrLoginChallenges.status, 'pending'),
          gt(qrLoginChallenges.expiresAt, now),
        ))
        .returning({ id: qrLoginChallenges.id });
      if (!approved) throw conflict('QR sign-in request expired or was already approved');
      return { ok: true as const };
    });
  },

  async pollQrLogin(
    challengeToken: string,
    pollToken: string,
    meta?: { ip?: string; userAgent?: string; location?: string },
  ): Promise<{ status: 'pending' | 'expired' | 'consumed' } | { status: 'approved'; session: SessionResult }> {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const [challenge] = await tx
        .select()
        .from(qrLoginChallenges)
        .where(and(
          eq(qrLoginChallenges.challengeHash, hashToken(challengeToken)),
          eq(qrLoginChallenges.pollTokenHash, hashToken(pollToken)),
        ))
        .limit(1);
      if (!challenge) throw invalidCredentials('Invalid QR sign-in request');
      if (challenge.expiresAt.getTime() <= Date.now()) return { status: 'expired' as const };
      if (challenge.status === 'consumed') return { status: 'consumed' as const };
      if (challenge.status !== 'approved') return { status: 'pending' as const };
      if (!challenge.approvedBy || !challenge.workspaceId || !challenge.role) {
        throw conflict('QR sign-in approval is incomplete');
      }

      const [consumed] = await tx
        .update(qrLoginChallenges)
        .set({ status: 'consumed' })
        .where(and(
          eq(qrLoginChallenges.id, challenge.id),
          eq(qrLoginChallenges.status, 'approved'),
          gt(qrLoginChallenges.expiresAt, new Date()),
        ))
        .returning({ id: qrLoginChallenges.id });
      if (!consumed) return { status: 'consumed' as const };

      const [user] = await tx.select().from(users).where(eq(users.id, challenge.approvedBy));
      if (!user || !user.emailVerifiedAt) throw forbidden('Please verify your email before signing in.');
      const session = await authService.issueSession(user, challenge.workspaceId, challenge.role, {
        ...meta,
        twoFactorSkipped: challenge.twoFactorSkipped,
      });
      return { status: 'approved' as const, session };
    });
  },

  signup: (async (input: {
    email: string;
    password: string;
    name: string;
    workspaceName: string;
  }, requireEmailVerification = false): Promise<SessionResult | SignupVerificationRequired> => {
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
        ...verificationEmailContent(verifyToken),
        devMarker: '[email:verify]',
        devToken: verifyToken,
      });

      if (requireEmailVerification) {
        return {
          requiresEmailVerification: true,
          email: user.email,
          workspaceId: ws.id,
          userId: user.id,
        };
      }

      const session = await authService.issueSession(user, ws.id, 'owner');
      return session;
    });
  }) as SignupMethod,

  async issueSession(
    user: User,
    workspaceId: string,
    role: string,
    meta?: { ip?: string; userAgent?: string; location?: string; twoFactorSkipped?: boolean },
  ): Promise<SessionResult> {
    const refreshToken = generateToken();
    const familyId = generateUuid();
    const tx = currentTx();

    await tx.insert(refreshTokens).values({
      userId: user.id,
      workspaceId,
      tokenHash: hashToken(refreshToken),
      familyId,
      twoFactorSkipped: meta?.twoFactorSkipped ?? false,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      ip: meta?.ip,
      userAgent: meta?.userAgent,
      location: meta?.location,
    });

    const accessToken = signAccessToken({
      sub: user.id,
      workspaceId,
      role: role as 'owner',
      jti: generateToken(8),
      sid: familyId,
    });

    return {
      accessToken,
      refreshToken,
      twoFactorSkipped: meta?.twoFactorSkipped ?? false,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        avatarUrl: user.avatarUrl,
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
    location?: string;
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

      if (!user.emailVerifiedAt) {
        throw forbidden('Please verify your email before signing in.');
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
        location: input.location,
      });
    });
  },

  async loginWithGoogle(input: GoogleIdentity & {
    ip?: string;
    userAgent?: string;
    location?: string;
  }): Promise<SessionResult | { requires2fa: true; tempToken: string }> {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      let [user] = await tx.select().from(users).where(eq(users.googleSubject, input.subject));

      if (!user) {
        [user] = await tx.select().from(users).where(eq(users.email, input.email));
        if (user?.googleSubject && user.googleSubject !== input.subject) {
          throw conflict('This email is already linked to another Google account.');
        }
      }

      if (user) {
        if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
          throw invalidCredentials('Account temporarily locked. Try again later.');
        }
        const [linkedUser] = await tx
          .update(users)
          .set({
            googleSubject: input.subject,
            emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
            name: user.name ?? input.name,
          })
          .where(eq(users.id, user.id))
          .returning();
        if (!linkedUser) throw invalidCredentials();
        user = linkedUser;
      } else {
        const name = input.name || input.email.split('@')[0] || 'Qonvilo user';
        const [createdUser] = await tx
          .insert(users)
          .values({
            email: input.email,
            googleSubject: input.subject,
            passwordHash: await hashPassword(generateToken(32)),
            emailVerifiedAt: new Date(),
            name,
          })
          .returning();
        if (!createdUser) throw conflict('Failed to create account');
        user = createdUser;

        const [workspace] = await tx
          .insert(workspaces)
          .values({ name: `${name}'s workspace`, slug: slugify(`${name}-workspace`) })
          .returning();
        if (!workspace) throw conflict('Failed to create workspace');

        await setTenantContext(workspace.id);
        await tx.insert(memberships).values({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'owner',
        });
      }

      await setUserContext(user.id);
      const [membership] = await tx
        .select()
        .from(memberships)
        .where(eq(memberships.userId, user.id));
      if (!membership) throw badRequest('User has no workspace');

      if (user.totpEnabled) {
        return { requires2fa: true as const, tempToken: signTempToken(user.id) };
      }

      await tx
        .update(users)
        .set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() })
        .where(eq(users.id, user.id));

      return this.issueSession(user, membership.workspaceId, membership.role, {
        ip: input.ip,
        userAgent: input.userAgent,
        location: input.location,
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
    location?: string;
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
      if (!user.emailVerifiedAt) throw forbidden('Please verify your email before signing in.');
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
        location: input.location,
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
      if (!user.emailVerifiedAt) throw forbidden('Please verify your email before signing in.');

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
        twoFactorSkipped: stored.twoFactorSkipped,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
        ip: stored.ip,
        userAgent: stored.userAgent,
        location: stored.location,
      });

      // Allow reading this user's OWN memberships (RLS self policy).
      await setUserContext(user.id);
      const availableMemberships = await tx
        .select()
        .from(memberships)
        .where(eq(memberships.userId, user.id));
      const membership = stored.workspaceId
        ? availableMemberships.find((entry) => entry.workspaceId === stored.workspaceId)
        : availableMemberships.length === 1 ? availableMemberships[0] : undefined;
      if (!membership || !isMembershipRole(membership.role)) {
        throw invalidCredentials('Session workspace membership no longer exists');
      }
      const wsId = membership.workspaceId;
      const role = membership.role;

      const accessToken = signAccessToken({
        sub: user.id,
        workspaceId: wsId,
        role: role as 'owner',
        jti: generateToken(8),
        sid: stored.familyId,
      });

      return {
        accessToken,
        refreshToken: newToken,
        twoFactorSkipped: stored.twoFactorSkipped,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          phone: user.phone,
          avatarUrl: user.avatarUrl,
          emailVerifiedAt: user.emailVerifiedAt,
          totpEnabled: user.totpEnabled,
        },
        workspaceId: wsId,
        role,
      };
    });
  },

  async skipTwoFactorForSession(
    userId: string,
    sessionId: string,
  ): Promise<Omit<SessionResult, 'refreshToken'>> {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const [stored] = await tx
        .select()
        .from(refreshTokens)
        .where(and(
          eq(refreshTokens.userId, userId),
          eq(refreshTokens.familyId, sessionId),
          isNull(refreshTokens.revokedAt),
          gt(refreshTokens.expiresAt, new Date()),
        ))
        .limit(1);
      if (
        !stored ||
        stored.userId !== userId ||
        stored.revokedAt ||
        stored.expiresAt.getTime() < Date.now()
      ) {
        throw invalidCredentials('Invalid session');
      }

      const [user] = await tx.select().from(users).where(eq(users.id, userId));
      if (!user || !user.emailVerifiedAt) throw forbidden('Please verify your email before signing in.');
      if (user.totpEnabled) throw badRequest('Two-factor authentication is already enabled');

      await tx
        .update(refreshTokens)
        .set({ twoFactorSkipped: true })
        .where(and(eq(refreshTokens.familyId, stored.familyId), isNull(refreshTokens.revokedAt)));

      await setUserContext(user.id);
      const availableMemberships = await tx
        .select()
        .from(memberships)
        .where(eq(memberships.userId, user.id));
      const membership = stored.workspaceId
        ? availableMemberships.find((entry) => entry.workspaceId === stored.workspaceId)
        : availableMemberships.length === 1 ? availableMemberships[0] : undefined;
      if (!membership || !isMembershipRole(membership.role)) {
        throw invalidCredentials('Session workspace membership no longer exists');
      }
      const workspaceId = membership.workspaceId;
      const role = membership.role;
      return {
        accessToken: signAccessToken({
          sub: user.id,
          workspaceId,
          role: role as 'owner',
          jti: generateToken(8),
          sid: stored.familyId,
        }),
        twoFactorSkipped: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          phone: user.phone,
          avatarUrl: user.avatarUrl,
          emailVerifiedAt: user.emailVerifiedAt,
          totpEnabled: user.totpEnabled,
        },
        workspaceId,
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
            inArray(emailTokens.type, ['verify', 'email_change']),
          ),
        );
      if (!row) throw badRequest('Invalid or expired verification token');
      if (row.usedAt && row.type === 'verify') {
        const [user] = await tx.select().from(users).where(eq(users.id, row.userId));
        if (user?.emailVerifiedAt) return;
        throw badRequest('Invalid or expired verification token');
      }
      if (row.usedAt) throw badRequest('Invalid or expired verification token');
      if (row.expiresAt.getTime() <= Date.now()) {
        throw badRequest('Invalid or expired verification token');
      }
      await tx.update(emailTokens).set({ usedAt: new Date() }).where(eq(emailTokens.id, row.id));
      if (row.type === 'email_change') {
        const [user] = await tx.select().from(users).where(eq(users.id, row.userId));
        if (!user?.pendingEmail) throw badRequest('This email change is no longer pending');
        await tx.update(users)
          .set({ email: user.pendingEmail, pendingEmail: null, emailVerifiedAt: new Date() })
          .where(eq(users.id, row.userId));
      } else {
        await tx.update(users)
          .set({ emailVerifiedAt: new Date() })
          .where(eq(users.id, row.userId));
      }
    });
  },

  async getProfile(userId: string) {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const [user] = await currentTx()
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          phone: users.phone,
          avatarUrl: users.avatarUrl,
          pendingEmail: users.pendingEmail,
          emailVerifiedAt: users.emailVerifiedAt,
        })
        .from(users)
        .where(eq(users.id, userId));
      if (!user) throw notFound('User not found');
      return user;
    });
  },

  async updateProfile(
    userId: string,
    input: { name: string; phone: string | null },
  ) {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const [user] = await currentTx()
        .update(users)
        .set(input)
        .where(eq(users.id, userId))
        .returning({
          id: users.id,
          email: users.email,
          name: users.name,
          phone: users.phone,
          avatarUrl: users.avatarUrl,
          pendingEmail: users.pendingEmail,
          emailVerifiedAt: users.emailVerifiedAt,
        });
      if (!user) throw notFound('User not found');
      return user;
    });
  },

  async uploadAvatar(
    userId: string,
    input: { mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; imageData: string },
  ) {
    const data = Buffer.from(input.imageData, 'base64');
    if (data.length === 0 || data.length > 1_000_000 || data.toString('base64') !== input.imageData) {
      throw badRequest('Profile photo must be a valid image under 1 MB');
    }
    const isJpeg = input.mimeType === 'image/jpeg' && data.length >= 3
      && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    const isPng = input.mimeType === 'image/png'
      && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isWebp = input.mimeType === 'image/webp' && data.length >= 12
      && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
    if (!isJpeg && !isPng && !isWebp) throw badRequest('The selected file is not a valid supported image');
    const avatarUrl = `/v1/auth/avatar/${userId}?v=${generateUuid()}`;
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const [user] = await tx.update(users)
        .set({ avatarUrl })
        .where(eq(users.id, userId))
        .returning({ id: users.id });
      if (!user) throw notFound('User not found');
      await tx.insert(userAvatars).values({
        userId,
        mimeType: input.mimeType,
        imageData: input.imageData,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: userAvatars.userId,
        set: { mimeType: input.mimeType, imageData: input.imageData, updatedAt: new Date() },
      });
      return { avatarUrl };
    });
  },

  async getAvatar(userId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
      throw notFound('Profile photo not found');
    }
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const [avatar] = await currentTx()
        .select({ mimeType: userAvatars.mimeType, imageData: userAvatars.imageData })
        .from(userAvatars)
        .where(eq(userAvatars.userId, userId));
      if (!avatar) throw notFound('Profile photo not found');
      return { mimeType: avatar.mimeType, data: Buffer.from(avatar.imageData, 'base64') };
    });
  },

  async deleteAvatar(userId: string) {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      await tx.delete(userAvatars).where(eq(userAvatars.userId, userId));
      const [user] = await tx.update(users)
        .set({ avatarUrl: null })
        .where(eq(users.id, userId))
        .returning({ id: users.id });
      if (!user) throw notFound('User not found');
      return { avatarUrl: null };
    });
  },

  async requestEmailChange(userId: string, email: string, password: string): Promise<void> {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const [user] = await tx.select().from(users).where(eq(users.id, userId));
      if (!user) throw notFound('User not found');
      if (!(await verifyPassword(user.passwordHash, password))) throw invalidCredentials();
      if (user.email.toLowerCase() === email.toLowerCase()) {
        throw badRequest('This is already your email address');
      }

      const [existing] = await tx.select({ id: users.id }).from(users).where(or(
        eq(users.email, email),
        eq(users.pendingEmail, email),
      )).limit(1);
      if (existing && existing.id !== userId) throw conflict('Email already in use');

      await tx.update(emailTokens)
        .set({ usedAt: new Date() })
        .where(and(
          eq(emailTokens.userId, userId),
          eq(emailTokens.type, 'email_change'),
          isNull(emailTokens.usedAt),
        ));
      const token = generateToken();
      await tx.update(users).set({ pendingEmail: email }).where(eq(users.id, userId));
      await tx.insert(emailTokens).values({
        userId,
        type: 'email_change',
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_SECONDS * 1000),
      });
      const origin = (process.env.PUBLIC_APP_ORIGIN ?? 'http://localhost:3000').replace(/\/+$/, '');
      const verifyUrl = new URL('/verify-email', origin);
      verifyUrl.searchParams.set('token', token);
      await sendEmail({
        to: email,
        subject: 'Confirm your new Qonvilo email',
        text: `Confirm your new email address by opening this link: ${verifyUrl.toString()}\n\nIf you did not request this change, you can ignore this email.`,
        html: `<p>Confirm your new Qonvilo email address:</p><p><a href="${verifyUrl.toString()}">Confirm email</a></p><p>If you did not request this change, you can ignore this email.</p>`,
        devMarker: '[email:change]',
        devToken: token,
      });
    });
  },

  async changePassword(
    userId: string,
    currentFamilyId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      throw badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    await withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const [user] = await tx.select().from(users).where(eq(users.id, userId));
      if (!user) throw notFound('User not found');
      if (!(await verifyPassword(user.passwordHash, currentPassword))) throw invalidCredentials();
      const passwordHash = await hashPassword(newPassword);
      await tx.update(users)
        .set({ passwordHash, failedLogins: 0, lockedUntil: null })
        .where(eq(users.id, userId));
      await tx.update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(
          eq(refreshTokens.userId, userId),
          ne(refreshTokens.familyId, currentFamilyId),
          isNull(refreshTokens.revokedAt),
        ));
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
        ...verificationEmailContent(token),
        devMarker: '[email:verify]',
        devToken: token,
      });
    });
  },

  async forgotPassword(email: string): Promise<boolean> {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const [user] = await tx.select().from(users).where(eq(users.email, email));
      if (!user) return false;
      await tx
        .update(emailTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(emailTokens.userId, user.id),
            eq(emailTokens.type, 'reset'),
            isNull(emailTokens.usedAt),
          ),
        );
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
        text: `Reset your password using this secure link: ${(process.env.PUBLIC_APP_ORIGIN ?? 'http://localhost:3000').replace(/\/+$/, '')}/reset-password/${encodeURIComponent(token)}`,
        html: `<p>We received a request to reset your password.</p><p><a href="${(process.env.PUBLIC_APP_ORIGIN ?? 'http://localhost:3000').replace(/\/+$/, '')}/reset-password/${encodeURIComponent(token)}">Reset password</a></p><p>This link expires in 30 minutes and can only be used once. If you did not request this, you can ignore this email.</p>`,
        devMarker: '[email:reset]',
        devToken: token,
      });
      return true;
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
      await tx
        .update(emailTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(emailTokens.userId, row.userId),
            eq(emailTokens.type, 'reset'),
            isNull(emailTokens.usedAt),
          ),
        );
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
  async listSessions(
    userId: string,
    currentToken?: string,
    currentFamilyId?: string,
  ): Promise<SessionView[]> {
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
          location: r.location,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          current:
            (currentHash !== null && r.tokenHash === currentHash) ||
            (currentFamilyId !== undefined && r.familyId === currentFamilyId),
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
    currentFamilyId?: string,
  ): Promise<{ revoked: number }> {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const keepHash = !currentFamilyId && currentToken ? hashToken(currentToken) : null;
      const revoked = await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(refreshTokens.userId, userId),
            isNull(refreshTokens.revokedAt),
            currentFamilyId
              ? ne(refreshTokens.familyId, currentFamilyId)
              : keepHash ? ne(refreshTokens.tokenHash, keepHash) : undefined,
          ),
        )
        .returning({ id: refreshTokens.id });
      return { revoked: revoked.length };
    });
  },
};
