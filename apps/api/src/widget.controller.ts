import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { widgetSettingsQuerySchema } from '@livechat/shared';
import { Public } from './guards.js';
import { RateLimit } from './rate-limit.js';
import { widgetService } from './widget.service.js';
import { widgetSettingsService } from './widget-settings.service.js';
import { parse } from './validation.js';

/**
 * Widget-facing PUBLIC endpoints (blueprint §7: the widget public schema).
 * Served under /widget/* with any-origin CORS (token-authed, no cookies);
 * rate-limited per IP against floods from a single visitor/browser.
 */
@Controller('widget')
export class WidgetController {
  /**
   * POST /widget/v1/visitor_init (blueprint §9, step 2):
   * find-or-create the visitor, resume/open their conversation, mint the
   * short-lived visitor token used for the WebSocket handshake.
   */
  @Public()
  @RateLimit(30, 60_000)
  @Post('v1/visitor_init')
  @HttpCode(HttpStatus.OK)
  visitorInit(@Body() body: unknown, @Req() req: Request) {
    return widgetService.visitorInit(body, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      // Origin drives the allowlist check; Referer is the legacy fallback.
      origin: (req.headers.origin ?? req.headers.referer) as string | undefined,
    });
  }

  /**
   * GET /widget/v1/settings?key=pk_… (blueprint §10): the widget's bootstrap
   * config. The key is verified (live + not revoked), the Origin allowlist is
   * enforced, and only the public projection is returned.
   */
  @Public()
  @RateLimit(60, 60_000)
  @Get('v1/settings')
  settings(@Query() query: Record<string, unknown>, @Req() req: Request) {
    const { key } = parse(widgetSettingsQuerySchema, { key: query.key });
    const origin = (req.headers.origin ?? req.headers.referer) as string | undefined;
    return widgetSettingsService.publicSettings(key, origin);
  }
}
