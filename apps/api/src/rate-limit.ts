import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';
import { rateLimited } from '@livechat/shared';

/**
 * Dependency-free, in-memory rate limiting (blueprint §8.2 — brute-force /
 * credential-stuffing protection on auth-sensitive routes).
 *
 * A fixed-window counter per (IP, route[, email]) key. In-memory is fine for a
 * single Node process; when we scale to multiple instances this must move to a
 * shared store (Redis / DB) — see blueprint §9 scaling notes. The interface
 * (`@RateLimit`) is intentionally identical to @nestjs/throttler so swapping
 * the implementation later is a drop-in.
 */
export const RATE_LIMIT_KEY = 'rate:limit';
export const RateLimit = (limit: number, windowMs = 60_000) =>
  SetMetadata(RATE_LIMIT_KEY, { limit, windowMs });

interface Window {
  count: number;
  resetAt: number;
}

/** Module-level so it survives across guard instances; exported for tests. */
const buckets = new Map<string, Window>();

export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Generic fixed-window counter, keyed by caller. Used by the HTTP guard AND
 * the WebSocket gateway (per-socket message floods). In-memory = single node;
 * move to Redis when scaling horizontally (blueprint §9).
 */
export function consumeRateLimit(key: string, limit: number, windowMs: number): RateDecision {
  const now = Date.now();
  let win = buckets.get(key);
  if (!win || win.resetAt <= now) {
    win = { count: 0, resetAt: now + windowMs };
    buckets.set(key, win);
  }
  win.count += 1;

  // Opportunistic cleanup to bound memory (every ~10k requests).
  if (buckets.size > 10_000) {
    for (const [k, w] of buckets) if (w.resetAt <= now) buckets.delete(k);
  }

  if (win.count > limit) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((win.resetAt - now) / 1000)) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Test hook: clear all rate-limit state between suites. */
export function resetRateLimits(): void {
  buckets.clear();
}

/** Test hook: current bucket count for a key (or 0). */
export function rateLimitCount(key: string): number {
  return buckets.get(key)?.count ?? 0;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const opts: { limit: number; windowMs: number } | undefined = Reflect.getMetadata(
      RATE_LIMIT_KEY,
      context.getHandler(),
    );
    if (!opts) return true; // route opted out

    const req = context.switchToHttp().getRequest<Request>();
    // Key by IP + route path; for login/reset also fold in the submitted email
    // so one attacker IP can't lock out every account (and one targeted account
    // is limited across IPs only when we later add a shared store).
    const email = typeof (req.body as any)?.email === 'string' ? (req.body as any).email : '';
    const key = `${req.ip ?? 'unknown'}|${req.method} ${req.path}|${email}`;
    const decision = consumeRateLimit(key, opts.limit, opts.windowMs);
    if (!decision.allowed) {
      throw rateLimited(`Too many requests. Retry after ${decision.retryAfterSeconds}s`);
    }
    return true;
  }
}
