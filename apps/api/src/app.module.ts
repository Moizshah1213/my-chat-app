import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller.js';
import { WorkspacesController } from './workspaces.controller.js';
import { ConversationsController } from './conversations.controller.js';
import { ApiKeysController } from './api-keys.controller.js';
import { AuditController } from './audit.controller.js';
import { VisitorsController } from './visitors.controller.js';
import { WidgetSettingsController } from './widget-settings.controller.js';
import { WidgetController } from './widget.controller.js';
import { ChatGateway } from './chat.gateway.js';
import { AuthGuard, CapabilityGuard } from './guards.js';
import { RateLimitGuard } from './rate-limit.js';
import { HttpExceptionFilter } from './filters.js';

@Module({
  imports: [],
  controllers: [
    AuthController,
    WorkspacesController,
    ConversationsController,
    ApiKeysController,
    AuditController,
    VisitorsController,
    WidgetSettingsController,
    WidgetController,
  ],
  providers: [
    // Order matters: rate-limit BEFORE auth so credential-stuffing floods get
    // 429s (not 401 work) and can't be used to probe token validity cheaply.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: CapabilityGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    ChatGateway,
  ],
})
export class AppModule {}
