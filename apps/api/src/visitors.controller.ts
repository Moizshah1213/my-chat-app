import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { RequireCapability, CurrentAuth, type AuthContext } from './guards.js';
import { visitorService } from './visitors.service.js';

/**
 * Visitors REST API (blueprint §12 "Visitors list & details").
 * Reads reuse the conversations:read capability — visitors are the peers of
 * every conversation, so the same role boundary applies.
 */
@Controller('v1/visitors')
export class VisitorsController {
  @Get()
  @RequireCapability('conversations:read')
  list(@CurrentAuth() auth: AuthContext, @Query() query: Record<string, unknown>) {
    return visitorService.list(auth.workspaceId, auth.role, query);
  }

  @Get(':id')
  @RequireCapability('conversations:read')
  get(@CurrentAuth() auth: AuthContext, @Param('id') id: string) {
    return visitorService.get(auth.workspaceId, auth.role, id);
  }

  @Patch(':id')
  @RequireCapability('conversations:read')
  update(@CurrentAuth() auth: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    return visitorService.update(auth.workspaceId, auth.role, id, body);
  }
}
