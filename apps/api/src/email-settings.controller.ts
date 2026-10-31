import { Body, Controller, Get, Patch } from '@nestjs/common';
import { CurrentAuth, RequireCapability, type AuthContext } from './guards.js';
import { emailSettingsService } from './email-settings.service.js';
import { emailSettingsSchema } from '@livechat/shared';
import { parse } from './validation.js';

@Controller('v1/email-settings')
export class EmailSettingsController {
  @Get()
  @RequireCapability('settings:update')
  get(@CurrentAuth() auth: AuthContext) {
    return emailSettingsService.get(auth.workspaceId, auth.role);
  }

  @Patch()
  @RequireCapability('settings:update')
  async save(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const input = parse(emailSettingsSchema, body);
    return emailSettingsService.save(auth.workspaceId, auth.role, auth.sub, input) as Promise<{ ok: true }>;
  }
}
