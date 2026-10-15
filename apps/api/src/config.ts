import './load-env.js';
import { parseEnv, type Env } from '@livechat/shared';

/**
 * Boot-time env validation (blueprint §17: fail fast). Never logs secrets.
 */
export const env: Env = parseEnv();

export const config = {
  env: env.NODE_ENV,
  productName: env.PRODUCT_NAME,
  port: env.API_PORT,
  logLevel: env.LOG_LEVEL,
  databaseUrl: env.DATABASE_URL,
  jwt: {
    secret: env.JWT_SECRET,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  },
  cookie: {
    domain: env.COOKIE_DOMAIN,
    secure: env.COOKIE_SECURE,
  },
  publicAppOrigin: process.env.PUBLIC_APP_ORIGIN,
  publicSiteOrigin: process.env.PUBLIC_SITE_ORIGIN,
  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
  },
  emailFrom: env.EMAIL_FROM,
  /** Optional Redis for the Socket.IO adapter / shared rate limits (blueprint §3).
   *  When unset or unreachable the API falls back to single-node defaults. */
  redisUrl: process.env.REDIS_URL,
} as const;
