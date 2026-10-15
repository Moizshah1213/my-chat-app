import '../load-env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import postgres from 'postgres';
import { authService } from '../auth-service.js';
import { workspaceService } from '../workspaces.service.js';
import { closeDb } from '@livechat/db';

/**
 * Invitation flow tests (service level): preview, accept by a NEW invitee
 * (account creation), accept by an EXISTING account (signed-in as the
 * invitee, never as someone else), single-use enforcement, expiry.
 * Runs against the TEST database.
 */

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;

const BOOT_URL = process.env.BOOTSTRAP_DATABASE_URL!.replace(/\/[^/]+$/, '/livechat_test');
let boot: ReturnType<typeof postgres>;
const createdEmails: string[] = [];

const uniq = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

before(() => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must be set');
  const u = new URL(BOOT_URL);
  u.searchParams.delete('schema');
  boot = postgres(u.toString(), { max: 1, onnotice: () => {} });
});

after(async () => {
  for (const email of createdEmails) {
    await boot`DELETE FROM users WHERE email = ${email}::citext`;
  }
  await boot.end();
  await closeDb();
});

async function makeOwner(label: string) {
  const email = `${label}-${uniq()}@example.com`;
  createdEmails.push(email);
  const s = await authService.signup({
    email,
    password: 'correct-horse-battery',
    name: label,
    workspaceName: `${label} WS`,
  });
  return { email, userId: s.user.id, accessToken: s.accessToken, workspaceId: s.workspaceId };
}

describe('Invitation accept flow', () => {
  it('preview shows workspace/email/role; accept creates the account + agent session; token dies', async () => {
    const owner = await makeOwner('inv-owner');
    const invitee = `invitee-${uniq()}@example.com`;
    createdEmails.push(invitee);

    const { token } = await workspaceService.invite(owner.workspaceId, 'owner', {
      email: invitee,
      role: 'agent',
    });
    assert.ok(token, 'invite returns the raw token (dev stand-in for email)');

    const preview = await workspaceService.previewInvitation(token);
    assert.equal(preview.email, invitee);
    assert.equal(preview.role, 'agent');
    assert.equal(preview.workspaceName, 'inv-owner WS');

    // Anonymous accept with no existing account -> creates the user + joins.
    const session = await workspaceService.acceptInvitation(token, null, {
      name: 'Invited Agent',
      password: 'correct-horse-battery',
    });
    assert.equal(session.role, 'agent');
    assert.equal(session.workspaceId, owner.workspaceId, 'session scoped to the inviting workspace');
    assert.ok(session.accessToken && session.refreshToken, 'full session issued');

    // Owner sees the new member (members:read is owner-only, we are the owner).
    const members = await workspaceService.listMembers(owner.workspaceId, 'owner');
    assert.equal(members.length, 2, 'owner + accepted invitee');

    // Single use: the token cannot be replayed for preview or accept.
    await assert.rejects(
      () => workspaceService.acceptInvitation(token, null, { name: 'X', password: 'correct-horse-battery' }),
      /Invalid invitation token/,
    );
    await assert.rejects(() => workspaceService.previewInvitation(token), /Invalid invitation token/);
  });

  it('existing accounts must accept signed in AS the invitee', async () => {
    const ownerA = await makeOwner('inv-exists-a');
    const existing = await makeOwner('inv-exists-b'); // has its own workspace

    const { token } = await workspaceService.invite(ownerA.workspaceId, 'owner', {
      email: existing.email,
      role: 'agent',
    });

    // Anonymous -> 401: an existing account cannot be joined without a session.
    await assert.rejects(
      () => workspaceService.acceptInvitation(token, null, {}),
      /Sign in/,
    );
    // Signed in as someone else -> 403: no takeover via a stolen invite token.
    await assert.rejects(
      () => workspaceService.acceptInvitation(token, ownerA.userId, {}),
      /different email/,
    );

    // Signed in as the invitee -> joins workspace A as agent.
    const session = await workspaceService.acceptInvitation(token, existing.userId, {});
    assert.equal(session.workspaceId, ownerA.workspaceId);
    assert.equal(session.role, 'agent');
  });

  it('new-user accept without name/password is rejected; token is NOT consumed', async () => {
    const owner = await makeOwner('inv-validation');
    const invitee = `novel-${uniq()}@example.com`;
    createdEmails.push(invitee);
    const { token } = await workspaceService.invite(owner.workspaceId, 'owner', {
      email: invitee,
      role: 'agent',
    });
    await assert.rejects(
      () => workspaceService.acceptInvitation(token, null, {}),
      /Name and password/,
    );
    // The failed attempt did not burn the token.
    const preview = await workspaceService.previewInvitation(token);
    assert.equal(preview.email, invitee);
  });

  it('rejects unknown and expired tokens', async () => {
    await assert.rejects(
      () => workspaceService.previewInvitation('not-a-real-token-aaaaaaaaaaaaaaaaaaaaaa'),
      /Invalid invitation token/,
    );

    const owner = await makeOwner('inv-expired');
    const invitee = `expired-${uniq()}@example.com`;
    createdEmails.push(invitee);
    const { token } = await workspaceService.invite(owner.workspaceId, 'owner', {
      email: invitee,
      role: 'agent',
    });
    // Force-expire via bootstrap superuser (app_user can't see rows without tenant ctx).
    await boot`UPDATE invitations SET expires_at = now() - interval '1 hour'
               WHERE workspace_id = ${owner.workspaceId}`;

    await assert.rejects(() => workspaceService.previewInvitation(token), /expired/);
    await assert.rejects(
      () => workspaceService.acceptInvitation(token, null, { name: 'E', password: 'correct-horse-battery' }),
      /expired/,
    );
  });

  it('role rules: agents cannot invite; owners cannot invite owners', async () => {
    const owner = await makeOwner('inv-cap');
    await assert.rejects(
      () => workspaceService.invite(owner.workspaceId, 'agent', {
        email: `agent-${uniq()}@example.com`,
        role: 'agent',
      }),
      /permission|role/,
    );
    await assert.rejects(
      () => workspaceService.invite(owner.workspaceId, 'owner', {
        email: `coowner-${uniq()}@example.com`,
        role: 'owner',
      }),
      /owner/,
    );
  });
});