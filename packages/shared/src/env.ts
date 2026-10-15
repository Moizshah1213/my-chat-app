import { z } from 'zod';

/**
 * Environment validation. Config is validated at boot (fail fast) per blueprint §17.
 * Never logs secret values.
 */
const hexOrSecret = z.string().min(32, 'must be at least 32 chars');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PRODUCT_NAME: z.string().min(1).default('LiveChat'),

  // Postgres — runtime (app_user, NOBYPASSRLS) + migration owner
  DATABASE_URL: z.string().url(),
  MIGRATION_DATABASE_URL: z.string().url(),
  BOOTSTRAP_DATABASE_URL: z.string().url().optional(),

  REDIS_URL: z.string().url().optional(),

  ENCRYPTION_KEY: hexOrSecret, // 32-byte hex in production
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default('livechat'),
  JWT_AUDIENCE: z.string().default('livechat-app'),

  API_PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  COOKIE_DOMAIN: z.string().default('localhost'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  EMAIL_FROM: z.string().email().default('no-reply@example.com'),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // Fail fast, but do NOT print secret values (zod messages only).
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
