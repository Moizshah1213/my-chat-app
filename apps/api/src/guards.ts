import {
  CanActivate,
  ExecutionContext,
  createParamDecorator,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';
import { verifyAccessToken, type AccessTokenClaims } from './jwt.js';
import { roleCan, type Capability, type Role, unauthenticated, forbidden } from '@livechat/shared';
import { currentTx, memberships, refreshTokens, users, withoutTenant, setUserContext } from '@livechat/db';
import { and, eq, gt, isNull } from 'drizzle-orm';

/**
 * Request auth context attached after the bearer token is verified.
 * workspaceId/role come ONLY from the verified token — never the request body,
 * query, or URL (blueprint §5, layer 1: token-derived tenant).
 */
export interface AuthContext extends AccessTokenClaims {}

export const CAPABILITY_KEY = 'required:capability';
export const IS_PUBLIC_KEY = 'is:public';
export const RequireCapability = (capability: Capability) =>
  SetMetadata(CAPABILITY_KEY, capability);

function isRole(value: string): value is Role {
  return value === 'owner' || value === 'admin' || value === 'agent';
}

/** Mark a route as public (no auth required). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Extract + verify the JWT from the Authorization header or auth cookie. */
function extractClaims(req: Request): AccessTokenClaims | null {
  const header = req.headers.authorization;
  let token: string | undefined;
  if (header?.startsWith('Bearer ')) token = header.slice(7);
  else if ((req as any).cookies?.access_token) token = (req as any).cookies.access_token;
  if (!token) return null;
  try {
    return verifyAccessToken(token);
  } catch {
    return null;
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, context.getHandler());
    const req = context.switchToHttp().getRequest<Request>();
    if (isPublic) {
      // OPTIONAL AUTH: attach identity if a *valid* token was presented, but
      // never reject — public routes decide whether identity is required
      // (e.g. POST /v1/invitations/accept: signed-in invitees pass their
      // userId, anonymous users can still accept by creating an account).
      const claims = extractClaims(req);
      const enrollmentVerify = req.path === '/v1/auth/2fa/verify';
      const authState = claims ? await getAuthState(claims.sub, claims.workspaceId, claims.sid) : null;
      if (
        claims &&
        authState?.emailVerified &&
        authState.sessionValid &&
        authState.membershipRole &&
        (authState.totpEnabled || authState.twoFactorSkipped || enrollmentVerify)
      ) {
        (req as any).auth = { ...claims, role: authState.membershipRole } satisfies AuthContext;
      }
      return true;
    }
    const claims = extractClaims(req);
    if (!claims) throw unauthenticated();
    const authState = await getAuthState(claims.sub, claims.workspaceId, claims.sid);
    if (!authState?.emailVerified) {
      throw forbidden('Verify your email before accessing your workspace.');
    }
    if (!authState.sessionValid || !authState.membershipRole) {
      throw forbidden('This account no longer has access to this workspace.');
    }
    const twoFactorRoute = req.path === '/v1/auth/2fa/setup' || req.path === '/v1/auth/2fa/skip';
    if (!authState.totpEnabled && !twoFactorRoute && !authState.twoFactorSkipped) {
      throw forbidden('Set up two-factor authentication before accessing your workspace.');
    }
    (req as any).auth = { ...claims, role: authState.membershipRole } satisfies AuthContext;
    return true;
  }
}

async function getAuthState(
  userId: string,
  workspaceId: string,
  sessionId?: string,
): Promise<{
  emailVerified: boolean;
  totpEnabled: boolean;
  twoFactorSkipped: boolean;
  sessionValid: boolean;
  membershipRole: Role | null;
} | null> {
  return withoutTenant(process.env.DATABASE_URL!, async () => {
    const tx = currentTx();
    const [user] = await tx
      .select({ emailVerifiedAt: users.emailVerifiedAt, totpEnabled: users.totpEnabled })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) return null;
    await setUserContext(userId);
    const [membership] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(
        eq(memberships.userId, userId),
        eq(memberships.workspaceId, workspaceId),
      ))
      .limit(1);
    const [session] = sessionId
      ? await tx
          .select({
            twoFactorSkipped: refreshTokens.twoFactorSkipped,
            workspaceId: refreshTokens.workspaceId,
          })
          .from(refreshTokens)
          .where(and(
            eq(refreshTokens.userId, userId),
            eq(refreshTokens.familyId, sessionId),
            eq(refreshTokens.workspaceId, workspaceId),
            isNull(refreshTokens.revokedAt),
            gt(refreshTokens.expiresAt, new Date()),
          ))
          .limit(1)
      : [];
    return {
      emailVerified: Boolean(user.emailVerifiedAt),
      totpEnabled: user.totpEnabled,
      twoFactorSkipped: Boolean(session?.twoFactorSkipped),
      sessionValid: !sessionId || Boolean(session),
      membershipRole: membership && isRole(membership.role) ? membership.role : null,
    };
  });
}

@Injectable()
export class CapabilityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const required: Capability | undefined = Reflect.getMetadata(
      CAPABILITY_KEY,
      context.getHandler(),
    );
    if (!required) return true; // no capability required on this route
    const req = context.switchToHttp().getRequest<Request>();
    const auth = (req as any).auth as AuthContext | undefined;
    if (!auth) throw unauthenticated();
    if (!roleCan(auth.role as Role, required)) throw forbidden('Insufficient role');
    return true;
  }
}

/** Param decorator to inject the verified auth context into a handler. */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    const req = ctx.switchToHttp().getRequest<Request>();
    return (req as any).auth as AuthContext;
  },
);
