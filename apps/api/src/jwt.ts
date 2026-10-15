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
