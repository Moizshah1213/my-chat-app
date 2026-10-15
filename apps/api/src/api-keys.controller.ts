import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequireCapability, CurrentAuth, type AuthContext } from './guards.js';
import { apiKeyService } from './api-keys.service.js';
import { recordAuditFor } from './audit.service.js';

/**
 * Agent-facing API key management (blueprint §7.3). All routes are
 * authenticated and capability-checked (owner/admin only); the workspace
 * always comes from the verified token.
 */
@Controller('v1/api-keys')
export class ApiKeysController {
  @Get()
  @RequireCapability('apikeys:read')
  list(@CurrentAuth() auth: AuthContext) {
    return apiKeyService.list(auth.workspaceId, auth.role);
  }

  /** Mint a new widget public key — the key string is returned only here. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireCapability('apikeys:manage')
  async create(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Req() req: Request) {
    const key = await apiKeyService.create(auth.workspaceId, auth.role, body);
    void recordAuditFor(auth.workspaceId, {
      actorId: auth.sub,
      action: 'apikey.create',
      target: key.id,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string) ?? null,
      meta: { name: key.name },
    });
    return key;
  }

  /** Revoke a key (idempotent). Revoked keys stop working on widget endpoints. */
  @Delete(':id')
  @RequireCapability('apikeys:manage')
  async revoke(@CurrentAuth() auth: AuthContext, @Param('id') id: string, @Req() req: Request) {
    const res = await apiKeyService.revoke(auth.workspaceId, auth.role, id);
    void recordAuditFor(auth.workspaceId, {
      actorId: auth.sub,
      action: 'apikey.revoke',
      target: id,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string) ?? null,
    });
    return res;
  }
}
