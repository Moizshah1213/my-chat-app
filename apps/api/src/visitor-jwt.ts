import jwt from 'jsonwebtoken';
import { VISITOR_TOKEN_TTL_SECONDS } from '@livechat/shared';
import { config } from './config.js';

/**
 * Visitor tokens (blueprint §9, step 2): short-lived JWTs minted by the PUBLIC
 * widget init endpoint so a visitor can open an authenticated socket and send
 * messages without an account.
 *
 * SECURITY: visitor tokens use a DISTINCT audience (`<aud>-widget`) from agent
 * access tokens, with the same signing secret. A widget token can therefore
 * never satisfy the HTTP AuthGuard / verifyAccessToken (audience mismatch =>
 * verify throws), and an agent token can never be used as a visitor token.
 * Tokens carry only { sub: visitorId, workspaceId } — no roles, no capabilities.
 */
export interface VisitorTokenClaims {
  sub: string; // visitor id
  workspaceId: string;
}

export const VISITOR_TOKEN_AUDIENCE = () => `${config.jwt.audience}-widget`;

export function signVisitorToken(claims: VisitorTokenClaims): string {
  return jwt.sign(claims, config.jwt.secret, {
    algorithm: 'HS256',
    expiresIn: VISITOR_TOKEN_TTL_SECONDS,
    issuer: config.jwt.issuer,
    audience: VISITOR_TOKEN_AUDIENCE(),
  });
}

export function verifyVisitorToken(token: string): VisitorTokenClaims {
  const decoded = jwt.verify(token, config.jwt.secret, {
    algorithms: ['HS256'],
    issuer: config.jwt.issuer,
    audience: VISITOR_TOKEN_AUDIENCE(),
  });
  if (typeof decoded === 'string') throw new Error('Invalid visitor token payload');
  // Hard fail if someone smuggles agent claims into a widget-audience token.
  if (typeof decoded.role !== 'undefined') throw new Error('Invalid visitor token claims');
  return {
    sub: decoded.sub as string,
    workspaceId: decoded.workspaceId as string,
  };
}
