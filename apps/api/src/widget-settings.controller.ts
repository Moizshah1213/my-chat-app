import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequireCapability, CurrentAuth, type AuthContext } from './guards.js';
import { widgetSettingsService } from './widget-settings.service.js';
import { recordAuditFor } from './audit.service.js';

/**
 * Agent-facing widget customization routes (blueprint §10). Authenticated +
 * settings:update (owner/admin); the workspace comes from the verified token.
 */
@Controller('v1/widget/settings')
export class WidgetSettingsController {
  @Get()
  @RequireCapability('settings:update')
  get(@CurrentAuth() auth: AuthContext) {
    return widgetSettingsService.getSettings(auth.workspaceId, auth.role);
  }

  @Patch()
  @RequireCapability('settings:update')
  async update(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Req() req: Request) {
    const res = await widgetSettingsService.updateSettings(auth.workspaceId, auth.role, body);
    void recordAuditFor(auth.workspaceId, {
      actorId: auth.sub,
      action: 'settings.update',
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string) ?? null,
    });
    return res;
  }
}
