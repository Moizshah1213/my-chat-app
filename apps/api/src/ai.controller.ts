import { Body, Controller, Get, Patch } from '@nestjs/common';
import { CurrentAuth, RequireCapability, type AuthContext } from './guards.js';
import { aiService, type AiSettingsView } from './ai.service.js';
import { updateAiSettingsSchema, type UpdateAiSettingsInput } from '@livechat/shared';
import { parse } from './validation.js';

@Controller('v1/ai/settings')
export class AiController {
  @Get()
  @RequireCapability('settings:update')
  get(@CurrentAuth() auth: AuthContext): Promise<AiSettingsView> {
    return aiService.get(auth.workspaceId, auth.role);
  }
  @Patch()
  @RequireCapability('settings:update')
  async save(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const input = parse(updateAiSettingsSchema, body) as UpdateAiSettingsInput;
    await aiService.save(auth.workspaceId, auth.role, auth.sub, input);
    return { ok: true };
  }
}
