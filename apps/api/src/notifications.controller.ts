import { Body, Controller, Delete, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { z } from 'zod';
import { unauthenticated } from '@livechat/shared';
import { CurrentAuth } from './guards.js';
import type { AuthContext } from './guards.js';
import { RateLimit } from './rate-limit.js';
import { parse } from './validation.js';
import { notificationsService } from './notifications.service.js';

const pushTokenSchema = z.object({
  token: z.string().regex(/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/),
}).strict();

@Controller('v1/notifications')
export class NotificationsController {
  @RateLimit(5, 60_000)
  @Post('push-token')
  @HttpCode(HttpStatus.OK)
  registerPushToken(@Body() body: unknown, @CurrentAuth() auth: AuthContext) {
    const { token } = parse(pushTokenSchema, body);
    if (!auth.sid) throw unauthenticated();
    return notificationsService.registerPushToken(auth.workspaceId, auth.sub, auth.sid, token);
  }

  @RateLimit(10, 60_000)
  @Delete('push-token')
  @HttpCode(HttpStatus.OK)
  unregisterPushToken(@Body() body: unknown, @CurrentAuth() auth: AuthContext) {
    const { token } = parse(pushTokenSchema, body);
    return notificationsService.unregisterPushToken(auth.workspaceId, auth.sub, token);
  }
}
