import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { acceptInvitationSchema } from '@livechat/shared';
import { RequireCapability, CurrentAuth, Public } from './guards.js';
import { RateLimit } from './rate-limit.js';
import { workspaceService } from './workspaces.service.js';
import { parse } from './validation.js';
import { config } from './config.js';
import { recordAuditFor } from './audit.service.js';

const REFRESH_COOKIE = 'refresh_token';

function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: 'lax',
    domain: config.cookie.domain,
    path: '/v1/auth',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

/**
 * Workspace & team routes. All are authenticated (global AuthGuard) and
 * tenant-scoped: the workspaceId used by the service comes ONLY from the
 * verified token (CurrentAuth), never from the request body/URL (blueprint §5).
 */
@Controller('v1')
export class WorkspacesController {
  @Get('workspace')
  @RequireCapability('workspace:read')
  getWorkspace(@CurrentAuth() auth: { workspaceId: string; role: 'owner' | 'admin' | 'agent' }) {
    return workspaceService.getWorkspace(auth.workspaceId, auth.role);
  }

  @Get('members')
  @RequireCapability('members:read')
  listMembers(@CurrentAuth() auth: { workspaceId: string; role: 'owner' | 'admin' | 'agent' }) {
    return workspaceService.listMembers(auth.workspaceId, auth.role);
  }

  @Post('invitations')
  @RequireCapability('members:invite')
  async invite(
    @CurrentAuth() auth: { workspaceId: string; sub: string; role: 'owner' | 'admin' | 'agent' },
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const res = await workspaceService.invite(auth.workspaceId, auth.role, body);
    void recordAuditFor(auth.workspaceId, {
      actorId: auth.sub,
      action: 'members.invite',
      target: res.invitationId,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string) ?? null,
    });
    return res;
  }

  /**
   * PUBLIC: preview an invitation before accepting (token is the capability).
   * Lets the invitee's browser show "X invited you to Y as Z".
   */
  @Public()
  @RateLimit(30, 60_000)
  @Get('invitations/:token')
  previewInvitation(@Param('token') token: string) {
    return workspaceService.previewInvitation(token);
  }

  /**
   * PUBLIC with optional auth: accept an invitation.
   * - New invitee: provide name+password; account is created and a session for
   *   the invited workspace is returned (refresh cookie set).
   * - Existing account: send the Bearer token of a session AS the invitee;
   *   a session for the newly joined workspace is returned.
   * Single-use token; replay => 404.
   */
  @Public()
  @RateLimit(10, 60_000)
  @Post('invitations/accept')
  @HttpCode(HttpStatus.OK)
  async acceptInvitation(
    @Req() req: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = parse(acceptInvitationSchema, body);
    const callerUserId = ((req as any).auth?.sub as string | undefined) ?? null;
    const session = await workspaceService.acceptInvitation(
      input.token,
      callerUserId,
      { name: input.name, password: input.password },
      { ip: req.ip, userAgent: req.headers['user-agent'] },
    );
    setRefreshCookie(res, session.refreshToken);
    return {
      accessToken: session.accessToken,
      user: session.user,
      workspaceId: session.workspaceId,
      role: session.role,
    };
  }

  @Patch('members/:id/role')
  @RequireCapability('members:update-role')
  async updateRole(
    @CurrentAuth() auth: { workspaceId: string; sub: string; role: 'owner' | 'admin' | 'agent' },
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const res = await workspaceService.updateRole(auth.workspaceId, auth.role, id, body);
    void recordAuditFor(auth.workspaceId, {
      actorId: auth.sub,
      action: 'members.update-role',
      target: id,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string) ?? null,
    });
    return res;
  }

  @Delete('members/:id')
  @RequireCapability('members:remove')
  async removeMember(
    @CurrentAuth() auth: { workspaceId: string; sub: string; role: 'owner' | 'admin' | 'agent' },
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    const res = await workspaceService.removeMember(auth.workspaceId, auth.role, id);
    void recordAuditFor(auth.workspaceId, {
      actorId: auth.sub,
      action: 'members.remove',
      target: id,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string) ?? null,
    });
    return res;
  }
}
