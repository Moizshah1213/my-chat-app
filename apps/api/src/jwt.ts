import jwt from 'jsonwebtoken';
import { ACCESS_TOKEN_TTL_SECONDS, type Role } from '@livechat/shared';
import { config } from './config.js';

export interface AccessTokenClaims {
  sub: string; // user id
  workspaceId: string;
  role: Role;
  jti: string; // token id (for revocation bookkeeping)
}

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, config.jwt.secret, {
    algorithm: 'HS256',
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
  });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  const decoded = jwt.verify(token, config.jwt.secret, {
    algorithms: ['HS256'],
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
  });
  // jsonwebtoken returns string | JwtPayload; assert shape.
  if (typeof decoded === 'string') throw new Error('Invalid token payload');
  return {
    sub: decoded.sub as string,
    workspaceId: decoded.workspaceId as string,
    role: decoded.role as Role,
    jti: decoded.jti as string,
  };
}

/**
 * Two-step 2FA login bridge: after the password checks out, login returns a
 * short-lived tempToken the client posts to /v1/auth/2fa/verify with its code.
 * Separate audience (`${audience}-2fa`) so it can NEVER be used as an API
 * bearer token (verifyAccessToken rejects the audience mismatch) and access
 * tokens can't stand in for it. Stateless by design: the account lockout +
 * per-route rate limit already bound guessing; no server-side table needed.
 */
export const TEMP_TOKEN_TTL_SECONDS = 10 * 60; // long enough to open an authenticator app

export function signTempToken(sub: string): string {
  return jwt.sign({ sub }, config.jwt.secret, {
    algorithm: 'HS256',
    expiresIn: TEMP_TOKEN_TTL_SECONDS,
    issuer: config.jwt.issuer,
    audience: `${config.jwt.audience}-2fa`,
  });
}

export function verifyTempToken(token: string): { sub: string } {
  const decoded = jwt.verify(token, config.jwt.secret, {
    algorithms: ['HS256'],
    issuer: config.jwt.issuer,
    audience: `${config.jwt.audience}-2fa`,
  });
  if (typeof decoded === 'string' || typeof decoded.sub !== 'string') {
    throw new Error('Invalid temp token payload');
  }
  return { sub: decoded.sub };
}
