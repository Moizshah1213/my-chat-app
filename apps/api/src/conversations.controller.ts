import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { RequireCapability, CurrentAuth, type AuthContext } from './guards.js';
import { conversationService } from './conversations.service.js';

/**
 * Agent inbox REST API (blueprint §6). All routes are authenticated and
 * capability-checked; the workspace always comes from the verified token.
 */
@Controller('v1/conversations')
export class ConversationsController {
  @Get()
  @RequireCapability('conversations:read')
  list(@CurrentAuth() auth: AuthContext, @Query() query: Record<string, unknown>) {
    return conversationService.list(auth.workspaceId, auth.role, auth.sub, query);
  }

  @Get(':id')
  @RequireCapability('conversations:read')
  get(@CurrentAuth() auth: AuthContext, @Param('id') id: string) {
    return conversationService.get(auth.workspaceId, auth.role, id);
  }

  /** Assign / change status (open|pending|closed) / set subject. */
  @Patch(':id')
  @RequireCapability('conversations:write')
  update(@CurrentAuth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return conversationService.update(auth.workspaceId, auth.role, id, body);
  }

  @Get(':id/messages')
  @RequireCapability('conversations:read')
  listMessages(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ) {
    return conversationService.listMessages(auth.workspaceId, auth.role, id, query);
  }

  /** REST send path (tests, future mobile app); the widget uses the socket. */
  @Post(':id/messages')
  @HttpCode(HttpStatus.CREATED)
  @RequireCapability('conversations:write')
  sendMessage(@CurrentAuth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return conversationService.sendMessage(auth.workspaceId, auth.role, auth.sub, id, body);
  }
}
