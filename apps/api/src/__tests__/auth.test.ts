import '../load-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import postgres from 'postgres';
import { authService } from '../auth-service.js';
import { hashToken } from '../crypto.js';
import { closeDb } from '@livechat/db';

/**
 * Auth flow tests (blueprint §8.9): signup, login, lockout, refresh rotation +
 * reuse detection, logout revocation, email verify, password reset (invalidates
 * sessions). Runs against the TEST database.
 */

// authService reads process.env.DATABASE_URL at call time — point it at the
// TEST database so unit tests never create rows in dev.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;
process.env.EMAIL_PROVIDER = 'console';

const BOOT_URL = process.env.BOOTSTRAP_DATABASE_URL!.replace(/\/[^/]+$/, '/livechat_test');
let boot: ReturnType<typeof postgres>;
const created: { userIds: string[]; emails: string[]; workspaceIds: string[] } = {
  userIds: [],
  emails: [],
  workspaceIds: [],
};

const uniq = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

before(() => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must be set');
  const u = new URL(BOOT_URL);
  u.searchParams.delete('schema');
  boot = postgres(u.toString(), { max: 1, onnotice: () => {} });
});

after(async () => {
  // Clean up created users (cascade removes their refresh/email tokens).
  for (const email of created.emails) {
    await boot`DELETE FROM users WHERE email = ${email}::citext`;
  }
  for (const workspaceId of created.workspaceIds) {
    await boot`DELETE FROM workspaces WHERE id = ${workspaceId}::uuid`;
  }
  await boot.end();
  await closeDb();
});

/**
 * Capture the token the dev "mailer" (console.log) prints for a given marker,
 * e.g. captureEmailToken(p, '[email:verify]'). Returns undefined when nothing
 * was logged — used to assert "no email was sent" cases too.
 */
async function captureEmailToken(p: Promise<unknown>, marker: string): Promise<string | undefined> {
  const captured: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    const line = String(args[0] ?? '');
    if (line.startsWith(marker)) {
      const m = line.split('-> ')[1];
      if (m) captured.push(m.trim());
    }
    orig.apply(console, args as []);
  };
  try {
    await p;
  } finally {
    console.log = orig;
  }
  return captured[captured.length - 1];
}

async function verifyAccount(email: string): Promise<void> {
  const token = await captureEmailToken(
    authService.resendVerification(email),
    '[email:verify]',
  );
  assert.ok(token, 'verification email was sent');
  await authService.verifyEmail(token);
}

describe('Auth flows', () => {
  it('Google login creates a verified account and reuses the linked identity', async () => {
    const email = `google-${uniq()}@example.com`;
    created.emails.push(email);
    const identity = {
      subject: `google-sub-${uniq()}`,
      email,
      name: 'Google User',
    };

    const createdSession = await authService.loginWithGoogle(identity);
    assert.ok('accessToken' in createdSession);
    assert.ok(createdSession.user.emailVerifiedAt);
    assert.equal(createdSession.user.name, identity.name);
    assert.equal(createdSession.role, 'owner');

    const returningSession = await authService.loginWithGoogle(identity);
    assert.ok('accessToken' in returningSession);
    assert.equal(returningSession.user.id, createdSession.user.id);
    assert.equal(returningSession.workspaceId, createdSession.workspaceId);
  });

  it('signup creates user + workspace + owner membership and returns a session', async () => {
    const email = `signup-${uniq()}@example.com`;
    created.emails.push(email);
    const res = await authService.signup({
      email,
      password: 'correct-horse-battery',
      name: 'Signup User',
      workspaceName: 'Signup WS',
    });
    assert.ok(res.accessToken, 'access token issued');
    assert.ok(res.refreshToken, 'refresh token issued');
    assert.equal(res.role, 'owner');
    assert.ok(res.workspaceId, 'workspace created');
    assert.equal(res.user.emailVerifiedAt, null, 'email not yet verified');
  });

  it('signup rejects duplicate email', async () => {
    const email = `dup-${uniq()}@example.com`;
    created.emails.push(email);
    await authService.signup({ email, password: 'correct-horse-battery', name: 'A', workspaceName: 'WA' });
    await assert.rejects(
      () => authService.signup({ email, password: 'correct-horse-battery', name: 'B', workspaceName: 'WB' }),
      /already registered/,
    );
  });

  it('login succeeds with correct credentials and fails with wrong password', async () => {
    const email = `login-${uniq()}@example.com`;
    created.emails.push(email);
    await authService.signup({ email, password: 'correct-horse-battery', name: 'L', workspaceName: 'WL' });

    await assert.rejects(
      () => authService.login({ email, password: 'correct-horse-battery' }),
      /verify your email/,
      'unverified accounts cannot sign in',
    );
    await verifyAccount(email);
    const ok = await authService.login({ email, password: 'correct-horse-battery' });
    assert.ok('accessToken' in ok, 'login returns a session');

    await assert.rejects(
      () => authService.login({ email, password: 'wrong-password-here' }),
      /Invalid email or password/,
    );
  });

  it('refresh rotates the token and issues a new pair', async () => {
    const email = `refresh-${uniq()}@example.com`;
    created.emails.push(email);
    const s = await authService.signup({ email, password: 'correct-horse-battery', name: 'R', workspaceName: 'WR' });

    await verifyAccount(email);
    const r2 = await authService.refresh(s.refreshToken);
    assert.ok(r2.accessToken, 'new access token');
    assert.notEqual(r2.refreshToken, s.refreshToken, 'refresh token rotated');

    // The new token works too (chained rotation).
    const r3 = await authService.refresh(r2.refreshToken);
    assert.ok(r3.accessToken, 'chained rotation works');
  });

  it('refresh reuse detection revokes the whole family', async () => {
    const email = `reuse-${uniq()}@example.com`;
    created.emails.push(email);
    const s = await authService.signup({ email, password: 'correct-horse-battery', name: 'RU', workspaceName: 'WRU' });

    await verifyAccount(email);
    const r2 = await authService.refresh(s.refreshToken);
    // Present the OLD token again -> must be detected as reuse and rejected.
    await assert.rejects(() => authService.refresh(s.refreshToken), /reuse detected/);
    // The whole family is now revoked: even the newest token fails.
    await assert.rejects(() => authService.refresh(r2.refreshToken), /reuse detected|revoked/);
  });

  it('account locks after repeated failed logins', async () => {
    const email = `lock-${uniq()}@example.com`;
    created.emails.push(email);
    await authService.signup({ email, password: 'correct-horse-battery', name: 'LK', workspaceName: 'WLK' });
    await verifyAccount(email);

    for (let i = 0; i < 8; i++) {
      await assert.rejects(() => authService.login({ email, password: 'bad-password' }));
    }
    // Now even the CORRECT password is refused due to lockout.
    await assert.rejects(
      () => authService.login({ email, password: 'correct-horse-battery' }),
      /locked|Invalid email or password/,
    );
  });

  it('logout revokes the refresh family; unknown token is a no-op', async () => {
    const email = `logout-${uniq()}@example.com`;
    created.emails.push(email);
    const s = await authService.signup({
      email,
      password: 'correct-horse-battery',
      name: 'LO',
      workspaceName: 'WLO',
    });

    await verifyAccount(email);
    await authService.logout(s.refreshToken);
    // The revoked token must no longer work (server-side, not just cookie).
    await assert.rejects(() => authService.refresh(s.refreshToken), /revoked|Invalid/);

    // Idempotent: logging out with garbage must not throw or leak state.
    await authService.logout('not-a-real-token');
    await authService.logout(undefined);
  });

  it('verify-email marks the user verified; the token is single-use', async () => {
    const email = `verify-${uniq()}@example.com`;
    created.emails.push(email);
    const token = await captureEmailToken(
      authService.signup({ email, password: 'correct-horse-battery', name: 'V', workspaceName: 'WV' }),
      '[email:verify]',
    );
    assert.ok(token, 'dev mailer logged a verification token');

    await authService.verifyEmail(token);
    const login = await authService.login({ email, password: 'correct-horse-battery' });
    assert.ok('accessToken' in login);
    assert.ok(login.user.emailVerifiedAt, 'emailVerifiedAt set after verify');

    await authService.verifyEmail(token);
  });

  it('resend-verification rotates the token (old link dies) — no enumeration otherwise', async () => {
    const email = `resend-${uniq()}@example.com`;
    created.emails.push(email);
    const token1 = await captureEmailToken(
      authService.signup({ email, password: 'correct-horse-battery', name: 'RS', workspaceName: 'WRS' }),
      '[email:verify]',
    );
    assert.ok(token1, 'signup emailed a verify token');
    const token2 = await captureEmailToken(authService.resendVerification(email), '[email:verify]');
    assert.ok(token2 && token2 !== token1, 'a fresh token is issued');

    await assert.rejects(() => authService.verifyEmail(token1), /Invalid or expired/, 'old token rotated out');
    await authService.verifyEmail(token2);

    // Unknown email: silent no-op (no throw, no email, no enumeration).
    const ghost = await captureEmailToken(
      authService.resendVerification(`ghost-${uniq()}@example.com`),
      '[email:verify]',
    );
    assert.equal(ghost, undefined, 'no email for unknown accounts');
    // Already verified: silent no-op too.
    const again = await captureEmailToken(authService.resendVerification(email), '[email:verify]');
    assert.equal(again, undefined, 'no email for verified accounts');
  });

  it('password reset switches the password and revokes all sessions', async () => {
    const email = `reset-${uniq()}@example.com`;
    created.emails.push(email);
    assert.equal(
      await authService.forgotPassword(`missing-${uniq()}@example.com`),
      false,
      'unknown emails are reported as not found',
    );
    const s = await authService.signup({
      email,
      password: 'correct-horse-battery',
      name: 'P',
      workspaceName: 'WP',
    });

    await verifyAccount(email);
    const staleResetToken = await captureEmailToken(authService.forgotPassword(email), '[email:reset]');
    assert.ok(staleResetToken, 'dev mailer logged the first reset token');
    const resetToken = await captureEmailToken(authService.forgotPassword(email), '[email:reset]');
    assert.ok(resetToken, 'dev mailer logged the replacement reset token');
    await assert.rejects(
      () => authService.resetPassword(staleResetToken, 'another-brand-new-password'),
      /Invalid or expired/,
      'requesting a new reset link invalidates the old one',
    );
    await authService.resetPassword(resetToken, 'a-brand-new-password');

    const login = await authService.login({ email, password: 'a-brand-new-password' });
    assert.ok('accessToken' in login, 'new password works');
    await assert.rejects(
      () => authService.login({ email, password: 'correct-horse-battery' }),
      /Invalid email or password/,
    );
    // The pre-reset session is dead.
    await assert.rejects(() => authService.refresh(s.refreshToken), /Invalid|revoked|reuse/);

    // Reset tokens are single-use.
    await assert.rejects(() => authService.resetPassword(resetToken, 'another-password'), /Invalid or expired/);
  });

  it('updates profile details, verifies email changes, records session location, and changes password', async () => {
    const email = `profile-${uniq()}@example.com`;
    const nextEmail = `profile-next-${uniq()}@example.com`;
    created.emails.push(email, nextEmail);
    const signup = await authService.signup({
      email,
      password: 'correct-horse-battery',
      name: 'Profile User',
      workspaceName: 'Profile Workspace',
    });
    await verifyAccount(email);

    const updated = await authService.updateProfile(signup.user.id, {
      name: 'Updated Profile',
      phone: '+1 555 0100',
    });
    assert.equal(updated.name, 'Updated Profile');
    assert.equal(updated.phone, '+1 555 0100');
    const imageData = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9k=';
    const uploadedAvatar = await authService.uploadAvatar(signup.user.id, { mimeType: 'image/jpeg', imageData });
    assert.match(uploadedAvatar.avatarUrl, new RegExp(`^/v1/auth/avatar/${signup.user.id}\\?v=`));
    const savedAvatar = await authService.getAvatar(signup.user.id);
    assert.equal(savedAvatar.mimeType, 'image/jpeg');
    assert.deepEqual(savedAvatar.data, Buffer.from(imageData, 'base64'));
    await authService.deleteAvatar(signup.user.id);
    await assert.rejects(() => authService.getAvatar(signup.user.id), /Profile photo not found/);

    await assert.rejects(
      () => authService.requestEmailChange(signup.user.id, nextEmail, 'wrong-password'),
      /Invalid email or password/,
    );
    const emailToken = await captureEmailToken(
      authService.requestEmailChange(signup.user.id, nextEmail, 'correct-horse-battery'),
      '[email:change]',
    );
    assert.ok(emailToken, 'email-change verification token was sent');
    assert.equal((await authService.getProfile(signup.user.id)).pendingEmail, nextEmail);
    await authService.verifyEmail(emailToken);
    assert.equal((await authService.getProfile(signup.user.id)).email, nextEmail);

    const login = await authService.login({
      email: nextEmail,
      password: 'correct-horse-battery',
      location: 'Toronto, Ontario, CA',
    });
    assert.ok('accessToken' in login);
    const sessions = await authService.listSessions(signup.user.id, login.refreshToken);
    const current = sessions.find((session) => session.current);
    assert.equal(current?.location, 'Toronto, Ontario, CA');

    await authService.changePassword(
      signup.user.id,
      current!.id,
      'correct-horse-battery',
      'a-brand-new-password',
    );
    assert.ok((await authService.refresh(login.refreshToken)).accessToken, 'current session remains active');
    await assert.rejects(() => authService.refresh(signup.refreshToken), /Invalid|revoked|reuse/);
    assert.ok(
      'accessToken' in await authService.login({ email: nextEmail, password: 'a-brand-new-password' }),
      'new password works',
    );
  });
});

describe('Two-factor auth + session management', () => {
  it('refresh and 2FA skip use the workspace membership for the current session', async () => {
    const email = `workspace-role-${uniq()}@example.com`;
    created.emails.push(email);
    const session = await authService.signup({
      email,
      password: 'correct-horse-battery',
      name: 'Workspace Role',
      workspaceName: 'Workspace Role Home',
    });
    await verifyAccount(email);

    const targetWorkspaceId = randomUUID();
    created.workspaceIds.push(targetWorkspaceId);
    await boot`INSERT INTO workspaces (id, name, slug)
      VALUES (${targetWorkspaceId}::uuid, 'Workspace Role Target', ${`workspace-role-${uniq()}`})`;
    await boot`INSERT INTO memberships (workspace_id, user_id, role)
      VALUES (${targetWorkspaceId}::uuid, ${session.user.id}::uuid, 'agent')`;
    const sessionId = await boot`
      SELECT family_id FROM refresh_tokens
      WHERE user_id = ${session.user.id}::uuid
        AND token_hash = ${hashToken(session.refreshToken)}
    `;
    assert.equal(sessionId.length, 1, 'signup session is found by its refresh token hash');
    await boot`UPDATE refresh_tokens
      SET workspace_id = ${targetWorkspaceId}::uuid
      WHERE family_id = ${sessionId[0]!.family_id}::uuid`;

    const refreshed = await authService.refresh(session.refreshToken);
    assert.equal(refreshed.workspaceId, targetWorkspaceId);
    assert.equal(refreshed.role, 'agent');

    const skipped = await authService.skipTwoFactorForSession(session.user.id, sessionId[0]!.family_id);
    assert.equal(skipped.workspaceId, targetWorkspaceId);
    assert.equal(skipped.role, 'agent');
  });

  it('Google sign-in preserves the existing second-factor challenge', async () => {
    const email = `google-2fa-${uniq()}@example.com`;
    created.emails.push(email);
    const identity = {
      subject: `google-sub-${uniq()}`,
      email,
      name: 'Google Two Factor',
    };
    const session = await authService.loginWithGoogle(identity);
    assert.ok('accessToken' in session);

    const { authenticator } = await import('otplib');
    const setup = await authService.setup2fa(session.user.id);
    await authService.enable2fa(session.user.id, authenticator.generate(setup.secret));

    const challenge = await authService.loginWithGoogle(identity);
    assert.ok('requires2fa' in challenge && challenge.requires2fa);
    const completed = await authService.completeTwoFactorLogin({
      tempToken: challenge.tempToken,
      code: authenticator.generate(setup.secret),
    });
    assert.ok('accessToken' in completed);
  });

  it('setup → enable → login (TOTP + one-time recovery codes) → disable', async () => {
    const email = `2fa-${uniq()}@example.com`;
    created.emails.push(email);
    const s = await authService.signup({
      email,
      password: 'correct-horse-battery',
      name: 'T',
      workspaceName: 'WT',
    });
    await verifyAccount(email);
    const userId = s.user.id;
    const { authenticator } = await import('otplib');

    // Pending setup mints a secret but does NOT enforce 2FA yet.
    const setup = await authService.setup2fa(userId);
    assert.ok(setup.secret.length > 10, 'secret minted');
    assert.ok(setup.otpauthUrl.startsWith('otpauth://'), 'otpauth URI for authenticator apps');
    const early = await authService.login({ email, password: 'correct-horse-battery' });
    assert.ok('accessToken' in early, 'pending setup does not gate login');

    // A wrong code cannot enable 2FA.
    await assert.rejects(
      () => authService.enable2fa(userId, '000000'),
      /Invalid authentication code/,
    );

    // Enable with a real TOTP code →10 recovery codes, returned once.
    const { recoveryCodes } = await authService.enable2fa(
      userId,
      authenticator.generate(setup.secret),
    );
    assert.equal(recoveryCodes.length, 10, 'ten recovery codes issued');
    assert.match(recoveryCodes[0]!, /^[a-z0-9]{5}-[a-z0-9]{5}$/i, 'code format xxxxx-xxxxx');

    // Login now demands the second factor, rejects a wrong one, accepts a fresh TOTP.
    const needs = await authService.login({ email, password: 'correct-horse-battery' });
    assert.ok('requires2fa' in needs && needs.requires2fa, 'login demands 2FA');
    const tempToken = (needs as { tempToken?: string }).tempToken;
    assert.ok(tempToken && tempToken.length > 20, 'tempToken bridges the two-step flow');

    // Two-step completion (mobile): tempToken + code, no password resend.
    await assert.rejects(
      () => authService.completeTwoFactorLogin({ tempToken: tempToken!, code: '000000' }),
      /Invalid authentication code/,
    );
    const stepped = await authService.completeTwoFactorLogin({
      tempToken: tempToken!,
      code: authenticator.generate(setup.secret),
    });
    assert.ok('accessToken' in stepped && stepped.refreshToken, 'session issued on tempToken + code');
    // Garbage tempToken rejected before any DB work.
    await assert.rejects(
      () => authService.completeTwoFactorLogin({ tempToken: 'garbage-not-a-jwt', code: '123456' }),
      /Invalid or expired 2FA token/,
    );
    await assert.rejects(
      () => authService.login({ email, password: 'correct-horse-battery', totpCode: '000000' }),
      /Invalid authentication code/,
    );
    const totpLogin = await authService.login({
      email,
      password: 'correct-horse-battery',
      totpCode: authenticator.generate(setup.secret),
    });
    assert.ok('accessToken' in totpLogin, 'TOTP login works');

    // A recovery code works exactly ONCE (consumed on use).
    const rc = recoveryCodes[0]!;
    const rcLogin = await authService.login({
      email,
      password: 'correct-horse-battery',
      totpCode: rc,
    });
    assert.ok('accessToken' in rcLogin, 'recovery code accepted');
    await assert.rejects(
      () => authService.login({ email, password: 'correct-horse-battery', totpCode: rc }),
      /Invalid authentication code/,
      'recovery code was consumed',
    );

    // Disable with password + TOTP; plain login works again.
    await authService.disable2fa(
      userId,
      'correct-horse-battery',
      authenticator.generate(setup.secret),
    );
    const plain = await authService.login({ email, password: 'correct-horse-battery' });
    assert.ok('accessToken' in plain, '2FA off after disable');
  });

  it('sessions: list marks current, single revoke kills one, logout-all kills the rest', async () => {
    const email = `sess-${uniq()}@example.com`;
    created.emails.push(email);
    const s1 = await authService.signup({
      email,
      password: 'correct-horse-battery',
      name: 'S',
      workspaceName: 'WSess',
    });
    await verifyAccount(email);
    const userId = s1.user.id;

    // A second "device": login again → second refresh-token family.
    const s2 = await authService.login({ email, password: 'correct-horse-battery' });
    assert.ok('accessToken' in s2);

    const list = await authService.listSessions(userId, s2.refreshToken);
    assert.ok(list.length >= 2, `two sessions listed: ${JSON.stringify(list)}`);
    assert.equal(
      list.filter((x) => x.current).length,
      1,
      'exactly one session marked current',
    );

    // Revoke the OTHER session → its refresh token dies.
    const other = list.find((x) => !x.current)!;
    await authService.revokeSession(userId, other.id);
    await assert.rejects(() => authService.refresh(s1.refreshToken), /Invalid|revoked|reuse/);
    const still = await authService.refresh(s2.refreshToken);
    assert.ok(still.accessToken, 'current session survives revoking another');

    // Log out everywhere from a third session — the caller itself survives.
    const s3 = await authService.login({ email, password: 'correct-horse-battery' });
    assert.ok('accessToken' in s3);
    const out = await authService.revokeOtherSessions(userId, s3.refreshToken);
    assert.ok(out.revoked >= 1, 'other sessions revoked');
    await assert.rejects(() => authService.refresh(still.refreshToken), /Invalid|revoked|reuse/);
    const survivor = await authService.refresh(s3.refreshToken);
    assert.ok(survivor.accessToken, 'the calling session stays signed in');

    // Revoking an unknown family is a 404, not a silent success.
    await assert.rejects(
      () => authService.revokeSession(userId, '00000000-0000-4000-8000-000000000000'),
      /not found/i,
    );
  });
});
