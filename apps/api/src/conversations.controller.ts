import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { RequireCapability, CurrentAuth, type AuthContext } from './guards.js';
import { conversationService } from './conversations.service.js';
import { RateLimit } from './rate-limit.js';

/**
 * Agent inbox REST API (blueprint §6). All routes are authenticated and
 * capability-checked; the workspace always comes from the verified token.
 */
@Controller('v1/conversations')
export class ConversationsController {
  @Get('notification-preferences')
  @RequireCapability('conversations:read')
  listNotificationPreferences(@CurrentAuth() auth: AuthContext) {
    return conversationService.listNotificationPreferences(auth.workspaceId, auth.role, auth.sub);
  }

  @Get()
  @RequireCapability('conversations:read')
  list(@CurrentAuth() auth: AuthContext, @Query() query: Record<string, unknown>) {
    return conversationService.list(auth.workspaceId, auth.role, auth.sub, query);
  }

  @Get(':id')
  @RequireCapability('conversations:read')
  get(@CurrentAuth() auth: AuthContext, @Param('id') id: string) {
    return conversationService.get(auth.workspaceId, auth.role, auth.sub, id);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @RequireCapability('conversations:read')
  markRead(@CurrentAuth() auth: AuthContext, @Param('id') id: string) {
    return conversationService.markRead(auth.workspaceId, auth.role, auth.sub, id);
  }

  /** Assign / change status (open|pending|closed) / set subject. */
  @Patch(':id')
  @RequireCapability('conversations:write')
  update(@CurrentAuth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return conversationService.update(auth.workspaceId, auth.role, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequireCapability('conversations:write')
  delete(@CurrentAuth() auth: AuthContext, @Param('id') id: string) {
    return conversationService.delete(auth.workspaceId, auth.role, id);
  }

  @Get(':id/notifications')
  @RequireCapability('conversations:read')
  getNotificationPreference(@CurrentAuth() auth: AuthContext, @Param('id') id: string) {
    return conversationService.getNotificationPreference(auth.workspaceId, auth.role, auth.sub, id);
  }

  @Patch(':id/notifications')
  @RequireCapability('conversations:write')
  updateNotificationPreference(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return conversationService.updateNotificationPreference(auth.workspaceId, auth.role, auth.sub, id, body);
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
  @RateLimit(30, 60_000)
  @RequireCapability('conversations:write')
  sendMessage(@CurrentAuth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return conversationService.sendMessage(auth.workspaceId, auth.role, auth.sub, id, body);
  }

  @Patch(':id/messages/:messageId')
  @RequireCapability('conversations:write')
  editMessage(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body() body: unknown,
  ) {
    return conversationService.editMessage(auth.workspaceId, auth.role, auth.sub, id, messageId, body);
  }

  @Delete(':id/messages/:messageId')
  @HttpCode(HttpStatus.OK)
  @RequireCapability('conversations:write')
  deleteMessage(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
  ) {
    return conversationService.deleteMessage(auth.workspaceId, auth.role, auth.sub, id, messageId);
  }
}
