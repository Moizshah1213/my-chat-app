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
  canActivate(context: ExecutionContext): boolean {
    const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, context.getHandler());
    const req = context.switchToHttp().getRequest<Request>();
    if (isPublic) {
      // OPTIONAL AUTH: attach identity if a *valid* token was presented, but
      // never reject — public routes decide whether identity is required
      // (e.g. POST /v1/invitations/accept: signed-in invitees pass their
      // userId, anonymous users can still accept by creating an account).
      const claims = extractClaims(req);
      if (claims) (req as any).auth = claims satisfies AuthContext;
      return true;
    }
    const claims = extractClaims(req);
    if (!claims) throw unauthenticated();
    (req as any).auth = claims satisfies AuthContext;
    return true;
  }
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
