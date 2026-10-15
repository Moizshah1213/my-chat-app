import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequireCapability, CurrentAuth, type AuthContext } from './guards.js';
import { auditService } from './audit.service.js';

/**
 * Audit log read API (blueprint §7.4). Owner/admin only; workspace always
 * comes from the verified token.
 */
@Controller('v1/audit-logs')
export class AuditController {
  @Get()
  @RequireCapability('audit:read')
  list(@CurrentAuth() auth: AuthContext, @Query('limit') limit?: string) {
    return auditService.list(auth.workspaceId, auth.role, limit ? Number(limit) : 100);
  }
}
