import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from './guards.js';
import { RateLimit } from './rate-limit.js';
import { widgetSettingsService } from './widget-settings.service.js';
import { widgetService } from './widget.service.js';

/**
 * Public embed endpoint: GET /widget/v1/embed.js?key=qvse_….
 * Returns a tiny JavaScript bootstrap that the customer pastes into a
 * `<script src>` tag on their site. The script self-installs the chat
 * widget iframe/bundle.
 */
@Controller('widget/v1')
export class WidgetEmbedController {
  @Public()
  @RateLimit(120, 60_000)
  @Get('embed.js')
  embed(@Query('key') key: string, @Req() _req: Request): string {
    const safeKey = key.replace(/[^a-zA-Z0-9_]/g, '');
    return widgetSettingsService.embedScript(safeKey);
  }
}
