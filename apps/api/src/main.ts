import 'reflect-metadata';
import type { NextFunction, Request, Response } from 'express';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import { config } from './config.js';
import { HttpExceptionFilter } from './filters.js';
import { RedisIoAdapter } from './redis-io.adapter.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  // Security headers (blueprint §8.2). CSP is strict; the API serves JSON only.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    }),
  );

  app.use(cookieParser());

  // Trust the proxy (Caddy/Nginx/Cloudflare) so secure cookies + client IP work.
  app.set('trust proxy', 1);

  // Body size limits (blueprint §8.2).
  app.useBodyParser('json', { limit: '256kb' });

  app.useGlobalFilters(new HttpExceptionFilter());

  // Widget endpoints (blueprint §7): token-authed, NO cookies, so they may be
  // called from any site that embeds the widget — allow any origin, scoped to
  // /widget only. Registered BEFORE the global (credentialed, allow-listed)
  // CORS so a foreign origin never gains access to cookie-authenticated
  // dashboard routes. Preflights are answered here directly.
  app.use('/widget', (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.enableCors({
    origin: [config.publicAppOrigin, config.publicSiteOrigin].filter(Boolean) as string[],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Socket.IO gateway: Redis adapter for cross-instance fan-out, with a
  // graceful in-memory fallback when Redis is unset or unreachable (dev/test,
  // single node) — the HTTP layer must not depend on Redis being up.
  const redisIoAdapter = new RedisIoAdapter(app);
  const redisReady = await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);
  // eslint-disable-next-line no-console
  console.log(`[ws] socket.io adapter: ${redisReady ? 'redis (shared)' : 'in-memory (single node)'}`);

  app.setGlobalPrefix('');
  await app.listen(config.port);
  // eslint-disable-next-line no-console
  console.log(`${config.productName} API listening on :${config.port} [${config.env}]`);
}

bootstrap();
