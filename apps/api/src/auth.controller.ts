import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  signupSchema,
  loginSchema,
  verifyEmailSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  totpVerifySchema,
  twoFactorLoginSchema,
  refreshTokenBodySchema,
  disable2faSchema,
  AppError,
  unauthenticated,
} from '@livechat/shared';
import { authService } from './auth-service.js';
import { verifyGoogleIdToken } from './google-auth.js';
import { CurrentAuth, type AuthContext } from './guards.js';
import { Public } from './guards.js';
import { RateLimit } from './rate-limit.js';
import { parse } from './validation.js';
import { config } from './config.js';
import { recordAuditFor } from './audit.service.js';
import { z } from 'zod';

const REFRESH_COOKIE = 'refresh_token';
const qrTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const qrStartSchema = z.object({ pollToken: qrTokenSchema }).strict();
const qrChallengeSchema = z.object({ challengeToken: qrTokenSchema }).strict();
const qrPollSchema = z.object({
  challengeToken: qrTokenSchema,
  pollToken: qrTokenSchema,
}).strict();
const profileSchema = z.object({
  name: z.string().trim().min(1).max(100),
  phone: z.string().trim().max(40).nullable().transform((value) => value || null),
}).strict();
const avatarUploadSchema = z.object({
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  imageData: z.string().min(1).max(1_400_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();
const emailChangeSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(128),
}).strict();
const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(1).max(128),
}).strict();
const googleLoginSchema = z.object({
  idToken: z.string().min(1).max(8192),
}).strict();

function sessionLocation(req: Request): string | undefined {
  const read = (name: string) => {
    const raw = req.headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string'
      ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)
      : '';
  };
  const parts = [
    read('cf-ipcity') || read('x-vercel-ip-city'),
    read('x-vercel-ip-country-region'),
    read('cf-ipcountry') || read('x-vercel-ip-country'),
  ].filter(Boolean);
  return parts.length ? [...new Set(parts)].join(', ').slice(0, 180) : undefined;
}

function dashboardOrigin(req: Request): string {
  const rawOrigin = req.headers.origin;
  if (!rawOrigin) throw new AppError('forbidden', 'A dashboard browser origin is required', 403);
  let origin: string;
  try {
    origin = new URL(rawOrigin).origin;
  } catch {
    throw new AppError('forbidden', 'Invalid dashboard browser origin', 403);
  }
  const allowed = [
    config.publicAppOrigin,
    ...(config.env !== 'production' ? ['http://localhost:3000', 'http://127.0.0.1:3000'] : []),
  ].filter(Boolean).map((value) => {
    try {
      return new URL(value!).origin;
    } catch {
      return '';
    }
  });
  if (!allowed.includes(origin)) {
    throw new AppError('forbidden', 'QR sign-in is only available from the dashboard', 403);
  }
  return origin;
}

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

@Controller('v1/auth')
export class AuthController {
  @Public()
  @RateLimit(10, 60_000) // 10 signups/min per IP — signup abuse + list stuffing
  @Post('signup')
  @HttpCode(HttpStatus.OK)
  async signup(@Body() body: unknown) {
    const input = parse(signupSchema, body);
    const registration = await authService.signup(input, true);
    // Audit AFTER the service returns (its transaction has committed — the
    // audit row FKs the workspace; blueprint §8.8).
    void recordAuditFor(registration.workspaceId, {
      actorId: registration.userId,
      action: 'auth.signup',
      target: registration.email,
    });
    return {
      requiresEmailVerification: true,
      email: registration.email,
    };
  }

  @Public()
  @RateLimit(10, 60_000) // 10 logins/min per (IP+email) — credential stuffing
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response, @Req() req: Request) {
    const input = parse(loginSchema, body);
    const result = await authService.login({
      ...input,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      location: sessionLocation(req),
    });
    if ('requires2fa' in result) {
      // Two-step flow: tempToken bridges back to /2fa/verify without
      // re-sending the password (short-lived, not usable as a bearer token).
      return { requires2fa: true, tempToken: result.tempToken };
    }
    void recordAuditFor(result.workspaceId, {
      actorId: result.user.id,
      action: 'auth.login',
      target: result.user.email,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    setRefreshCookie(res, result.refreshToken);
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
      workspaceId: result.workspaceId,
      role: result.role,
    };
  }

  @Public()
  @RateLimit(10, 60_000)
  @Post('google')
  @HttpCode(HttpStatus.OK)
  async googleLogin(@Body() body: unknown, @Res({ passthrough: true }) res: Response, @Req() req: Request) {
    const { idToken } = parse(googleLoginSchema, body);
    const identity = await verifyGoogleIdToken(idToken);
    const result = await authService.loginWithGoogle({
      ...identity,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      location: sessionLocation(req),
    });
    if ('requires2fa' in result) {
      return { requires2fa: true, tempToken: result.tempToken };
    }

    void recordAuditFor(result.workspaceId, {
      actorId: result.user.id,
      action: 'auth.google_login',
      target: result.user.email,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    setRefreshCookie(res, result.refreshToken);
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
      workspaceId: result.workspaceId,
      role: result.role,
    };
  }

  @Public()
  @RateLimit(5, 60_000)
  @Post('qr/start')
  @HttpCode(HttpStatus.OK)
  startQrLogin(@Body() body: unknown, @Req() req: Request) {
    const { pollToken } = parse(qrStartSchema, body);
    return authService.startQrLogin(pollToken, dashboardOrigin(req));
  }

  @Public()
  @RateLimit(30, 60_000)
  @Post('qr/inspect')
  @HttpCode(HttpStatus.OK)
  inspectQrLogin(@Body() body: unknown) {
    const { challengeToken } = parse(qrChallengeSchema, body);
    return authService.inspectQrLogin(challengeToken);
  }

  @Public()
  @RateLimit(10, 60_000)
  @Post('qr/approve')
  @HttpCode(HttpStatus.OK)
  async approveQrLogin(
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext | undefined,
  ) {
    if (!auth) throw unauthenticated();
    const { challengeToken } = parse(qrChallengeSchema, body);
    return authService.approveQrLogin(challengeToken, {
      userId: auth.sub,
      workspaceId: auth.workspaceId,
      role: auth.role,
      sessionId: auth.sid,
    });
  }

  @Public()
  @RateLimit(30, 60_000)
  @Post('qr/poll')
  @HttpCode(HttpStatus.OK)
  async pollQrLogin(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = parse(qrPollSchema, body);
    const result = await authService.pollQrLogin(input.challengeToken, input.pollToken, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      location: sessionLocation(req),
    });
    if (result.status !== 'approved') return result;

    setRefreshCookie(res, result.session.refreshToken);
    void recordAuditFor(result.session.workspaceId, {
      actorId: result.session.user.id,
      action: 'auth.qr_login',
      target: result.session.user.email,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    return {
      status: result.status,
      ...result.session,
    };
  }

  @Public()
  @RateLimit(120, 60_000) // generous: polling clients + tab restores
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Token source: JSON body (mobile — no usable cookies across the tunnel)
    // or HttpOnly cookie (browser). One of the two must be present.
    const { refreshToken: bodyToken } = parse(refreshTokenBodySchema, body ?? {});
    const token = bodyToken ?? ((req.cookies as any)?.[REFRESH_COOKIE] as string | undefined);
    if (!token) throw new AppError('unauthenticated', 'Missing refresh token', 401);
    const session = await authService.refresh(token);
    setRefreshCookie(res, session.refreshToken);
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      user: session.user,
      workspaceId: session.workspaceId,
      role: session.role,
      twoFactorSkipped: session.twoFactorSkipped,
    };
  }

  @Public()
  @RateLimit(120, 60_000)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Server-side revocation first (cookie is the client's copy of the truth),
    // then clear the cookie. Idempotent: missing body + cookie still succeeds.
    const { refreshToken: bodyToken } = parse(refreshTokenBodySchema, body ?? {});
    const token = bodyToken ?? ((req.cookies as any)?.[REFRESH_COOKIE] as string | undefined);
    await authService.logout(token);
    res.clearCookie(REFRESH_COOKIE, { path: '/v1/auth', domain: config.cookie.domain });
    return { ok: true };
  }

  @Public()
  @RateLimit(10, 60_000)
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(@Body() body: unknown) {
    const input = parse(verifyEmailSchema, body);
    await authService.verifyEmail(input.token);
    return { ok: true };
  }

  @Public()
  @RateLimit(5, 60_000) // 5/min per (IP+email) — email-bombing protection
  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  async resendVerification(@Body() body: unknown) {
    const input = parse(forgotPasswordSchema, body);
    await authService.resendVerification(input.email);
    // Always 202 regardless of whether the account exists/is verified (no enumeration).
    return { ok: true };
  }

  @Public()
  @RateLimit(5, 60_000) // 5/min per (IP+email) — inbox-bombing protection
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  async forgotPassword(@Body() body: unknown) {
    const input = parse(forgotPasswordSchema, body);
    await authService.forgotPassword(input.email);
    return { ok: true };
  }

  @Public()
  @RateLimit(10, 60_000)
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() body: unknown) {
    const input = parse(resetPasswordSchema, body);
    await authService.resetPassword(input.token, input.password);
    return { ok: true };
  }

  /** --- Two-factor enrollment (blueprint §7.1) — any signed-in user ---------- */

  /** Step 1: pending TOTP secret (encrypted at rest) + otpauth URI for the app. */
  @RateLimit(10, 60_000)
  @Post('2fa/setup')
  @HttpCode(HttpStatus.OK)
  async setup2fa(@CurrentAuth() auth: { sub: string }) {
    return authService.setup2fa(auth.sub);
  }

  @RateLimit(5, 60_000)
  @Post('2fa/skip')
  @HttpCode(HttpStatus.OK)
  async skip2fa(
    @CurrentAuth() auth: { sub: string; sid?: string },
  ) {
    if (!auth.sid) throw unauthenticated();
    const session = await authService.skipTwoFactorForSession(auth.sub, auth.sid);
    return {
      accessToken: session.accessToken,
      user: session.user,
      workspaceId: session.workspaceId,
      role: session.role,
      twoFactorSkipped: session.twoFactorSkipped,
    };
  }

  /**
   * Step 2 — dual purpose:
   *  - `{ code, tempToken }` with NO bearer: completes the two-step mobile
   *    login started at /login → full session in the response body.
   *  - `{ code }` with a Bearer token: confirms enrollment (step 2 of setup)
   *    → recovery codes returned ONCE.
   */
  @Public() // optional auth — tempToken flow is anonymous, enrollment passes Bearer
  @RateLimit(10, 60_000) // code-guessing throttle on top of login's own limit
  @Post('2fa/verify')
  @HttpCode(HttpStatus.OK)
  async verify2fa(
    @CurrentAuth() auth: { sub: string; workspaceId: string } | undefined,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const raw = (body ?? {}) as Record<string, unknown>;
    if (raw.tempToken !== undefined) {
      // Two-step login completion: tempToken proves /login already verified
      // the password (short-lived, audience-scoped — never a bearer token).
      const input = parse(twoFactorLoginSchema, body);
      const session = await authService.completeTwoFactorLogin({
        tempToken: input.tempToken,
        code: input.code,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        location: sessionLocation(req),
      });
      void recordAuditFor(session.workspaceId, {
        actorId: session.user.id,
        action: 'auth.login',
        target: session.user.email,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      setRefreshCookie(res, session.refreshToken);
      return {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        user: session.user,
        workspaceId: session.workspaceId,
        role: session.role,
        twoFactorSkipped: session.twoFactorSkipped,
      };
    }
    // Enrollment confirm: identity comes ONLY from the verified bearer token.
    if (!auth) throw unauthenticated();
    const input = parse(totpVerifySchema, body);
    const result = await authService.enable2fa(auth.sub, input.code);
    void recordAuditFor(auth.workspaceId, { actorId: auth.sub, action: '2fa.enabled' });
    return result;
  }

  /** Disable with password + (TOTP or recovery) code. */
  @RateLimit(10, 60_000)
  @Post('2fa/disable')
  @HttpCode(HttpStatus.OK)
  async disable2fa(
    @CurrentAuth() auth: { sub: string; workspaceId: string },
    @Body() body: unknown,
  ) {
    const input = parse(disable2faSchema, body);
    await authService.disable2fa(auth.sub, input.password, input.code);
    void recordAuditFor(auth.workspaceId, { actorId: auth.sub, action: '2fa.disabled' });
    return { ok: true };
  }

  // ---- Session management (blueprint §7.1) ----------------------------------

  /** Active login sessions for this user; `current` marks this device. */
  @Get('sessions')
  sessions(@CurrentAuth() auth: { sub: string; sid?: string }, @Req() req: Request) {
    const token = (req.cookies as any)?.[REFRESH_COOKIE] as string | undefined;
    return authService.listSessions(auth.sub, token, auth.sid);
  }

  @Get('profile')
  profile(@CurrentAuth() auth: AuthContext) {
    return authService.getProfile(auth.sub);
  }

  @Patch('profile')
  async updateProfile(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(profileSchema, body);
    return authService.updateProfile(auth.sub, input);
  }

  @Post('profile/avatar')
  async uploadProfileAvatar(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(avatarUploadSchema, body);
    return authService.uploadAvatar(auth.sub, input);
  }

  @Delete('profile/avatar')
  async deleteProfileAvatar(@CurrentAuth() auth: AuthContext) {
    return authService.deleteAvatar(auth.sub);
  }

  @Public()
  @Get('avatar/:userId')
  @RateLimit(120, 60_000)
  async getAvatar(@Param('userId') userId: string, @Res() res: Response) {
    const avatar = await authService.getAvatar(userId);
    res.setHeader('Content-Type', avatar.mimeType);
    res.setHeader('Content-Length', avatar.data.length);
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(avatar.data);
  }

  @Post('profile/email')
  @RateLimit(5, 60_000)
  @HttpCode(HttpStatus.ACCEPTED)
  async requestEmailChange(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(emailChangeSchema, body);
    await authService.requestEmailChange(auth.sub, input.email, input.password);
    return { ok: true, verificationRequired: true };
  }

  @Post('profile/password')
  @RateLimit(5, 60_000)
  @HttpCode(HttpStatus.OK)
  async changePassword(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    if (!auth.sid) throw unauthenticated();
    const input = parse(passwordChangeSchema, body);
    await authService.changePassword(auth.sub, auth.sid, input.currentPassword, input.newPassword);
    return { ok: true };
  }

  /** Revoke one session (by refresh-token family id) — own sessions only. */
  @Delete('sessions/:id')
  async revokeSession(@CurrentAuth() auth: { sub: string }, @Param('id') id: string) {
    await authService.revokeSession(auth.sub, id);
    return { ok: true };
  }

  /** "Log out everywhere" — revokes all OTHER sessions, keeps this one. */
  @RateLimit(10, 60_000)
  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  async logoutAll(
    @CurrentAuth() auth: { sub: string; workspaceId: string; sid?: string },
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const { refreshToken: bodyToken } = parse(refreshTokenBodySchema, body ?? {});
    const token = bodyToken ?? ((req.cookies as any)?.[REFRESH_COOKIE] as string | undefined);
    const result = await authService.revokeOtherSessions(auth.sub, token, auth.sid);
    void recordAuditFor(auth.workspaceId, {
      actorId: auth.sub,
      action: 'sessions.revoked_all',
      meta: { revoked: result.revoked },
    });
    return result;
  }

  /** Protected example: echoes the token-derived identity (no tenant from body). */
  @Get('me')
  me(@CurrentAuth() auth: { sub: string; workspaceId: string; role: string }) {
    return { userId: auth.sub, workspaceId: auth.workspaceId, role: auth.role };
  }
}
