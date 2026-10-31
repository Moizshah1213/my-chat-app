import { eq, and, isNull, gt } from 'drizzle-orm';
import { memberships, workspaces, invitations, invitationTokens, users, refreshTokens } from '@livechat/db';
import { withTenant, withoutTenant, currentTx, setTenantContext } from '@livechat/db';
import { sendEmail } from './email.js';
import {
  conflict,
  notFound,
  forbidden,
  unauthenticated,
  badRequest,
  roleCan,
  type Role,
  type Capability,
  inviteSchema,
  updateRoleSchema,
  INVITATION_TTL_SECONDS,
  MIN_PASSWORD_LENGTH,
} from '@livechat/shared';
import { generateToken, hashToken, hashPassword } from './crypto.js';
import { authService, type SessionResult } from './auth-service.js';
import { config } from './config.js';

/**
 * WorkspaceService — team & membership management, fully tenant-scoped.
 * Every method runs inside withTenant(workspaceId) so RLS + the app layer both
 * enforce isolation. workspaceId ALWAYS comes from the caller's verified token.
 */

function assertCapability(role: Role, capability: Capability) {
  if (!roleCan(role, capability)) throw forbidden('Insufficient role for this action');
}

function memberRole(value: string): Role {
  if (value === 'owner' || value === 'admin' || value === 'agent') return value;
  throw new Error(`Invalid stored workspace role: ${value}`);
}

export interface MemberView {
  userId: string;
  name: string | null;
  email: string;
  role: Role;
  createdAt: Date;
}

export interface InvitationView {
  id: string;
  email: string;
  role: Role;
  status: 'pending' | 'expired' | 'accepted';
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
}

export const workspaceService = {
  async getWorkspace(workspaceId: string, role: Role) {
    assertCapability(role, 'workspace:read');
    return withTenant(process.env.DATABASE_URL!, workspaceId, async () => {
      const tx = currentTx();
      const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId));
      // workspaces has no RLS, but we only ever pass a token-derived id.
      if (!ws) throw notFound('Workspace not found');
      return { id: ws.id, name: ws.name, slug: ws.slug, plan: ws.plan };
    });
  },

  async listMembers(workspaceId: string, role: Role): Promise<MemberView[]> {
    assertCapability(role, 'members:read');
    return withTenant(process.env.DATABASE_URL!, workspaceId, async () => {
      const tx = currentTx();
      const rows = await tx
        .select({
          userId: memberships.userId,
          name: users.name,
          email: users.email,
          role: memberships.role,
          createdAt: memberships.createdAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId));
      return rows.map((member) => ({ ...member, role: memberRole(member.role) }));
    });
  },

  async listInvitations(workspaceId: string, role: Role): Promise<InvitationView[]> {
    assertCapability(role, 'members:read');
    return withTenant(process.env.DATABASE_URL!, workspaceId, async () => {
      const tx = currentTx();
      const rows = await tx.select().from(invitations);
      const now = Date.now();
      return rows.map((inv) => ({
        id: inv.id,
        email: inv.email,
        role: memberRole(inv.role),
        status: inv.acceptedAt
          ? 'accepted'
          : inv.expiresAt.getTime() <= now
            ? 'expired'
            : 'pending',
        createdAt: inv.createdAt,
        expiresAt: inv.expiresAt,
        acceptedAt: inv.acceptedAt,
      }));
    });
  },

  /**
   * Invite a member. Creating an invitation writes to a tenant table, so it must
   * run with the workspace RLS context set (withTenant provides it).
   */
  async invite(
    workspaceId: string,
    role: Role,
    body: unknown,
  ): Promise<{ invitationId: string; token: string; inviteUrl: string }> {
    assertCapability(role, 'members:invite');
    const input = inviteSchema.parse(body);
    if (input.role === 'owner') throw forbidden('Cannot invite another owner');

    return withTenant(process.env.DATABASE_URL!, workspaceId, async () => {
      const tx = currentTx();
      const [existingUser] = await tx.select().from(users).where(eq(users.email, input.email));
      if (existingUser) {
        const [existingMembership] = await tx
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(eq(memberships.userId, existingUser.id));
        if (existingMembership) throw conflict('This user is already a workspace member');
      }
      const existing = await tx
        .select()
        .from(invitations)
        .where(
          and(
            eq(invitations.email, input.email),
            isNull(invitations.acceptedAt),
            gt(invitations.expiresAt, new Date()),
          ),
        );
      if (existing.length > 0) throw conflict('An active invitation already exists');

      const token = generateToken();
      const [inv] = await tx
        .insert(invitations)
        .values({
          workspaceId,
          email: input.email,
          role: input.role,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + INVITATION_TTL_SECONDS * 1000),
        })
        .returning();
      if (!inv) throw conflict('Failed to create invitation');
      // Global (non-RLS) pointer so the PUBLIC accept endpoint can resolve the
      // token to a workspace before any tenant context exists. See 0006.
      await tx.insert(invitationTokens).values({
        tokenHash: hashToken(token),
        invitationId: inv.id,
        workspaceId,
      });
      const appOrigin = (config.publicAppOrigin ?? 'http://localhost:3000').replace(/\/+$/, '');
      const inviteUrl = `${appOrigin}/invite/${encodeURIComponent(token)}`;
      await sendEmail({
        to: input.email,
        subject: "You've been invited",
        text: `Accept your workspace invitation: ${inviteUrl}`,
        html: `<p>You have been invited to join a workspace.</p><p><a href="${inviteUrl}">Accept invitation</a></p>`,
        devMarker: '[email:invite]',
        devToken: token,
      });
      return { invitationId: inv.id, token, inviteUrl };
    });
  },

  async cancelInvitation(workspaceId: string, role: Role, invitationId: string): Promise<{ ok: true }> {
    assertCapability(role, 'members:invite');
    return withTenant(process.env.DATABASE_URL!, workspaceId, async () => {
      const tx = currentTx();
      const [inv] = await tx
        .select()
        .from(invitations)
        .where(and(eq(invitations.id, invitationId), eq(invitations.workspaceId, workspaceId)));
      if (!inv) throw notFound('Invitation not found');
      if (inv.acceptedAt) throw conflict('Accepted invitations cannot be cancelled');
      await tx.delete(invitationTokens).where(eq(invitationTokens.tokenHash, inv.tokenHash));
      await tx.delete(invitations).where(eq(invitations.id, invitationId));
      return { ok: true as const };
    });
  },

  /**
   * Public preview of an invitation (no auth, token is the capability):
   * lets the invitee see which workspace/email/role they are joining before
   * signing up or logging in. Consumes nothing.
   */
  async previewInvitation(presentedToken: string): Promise<{
    email: string;
    role: string;
    workspaceName: string;
    expiresAt: Date;
  }> {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const [ptr] = await tx
        .select()
        .from(invitationTokens)
        .where(eq(invitationTokens.tokenHash, hashToken(presentedToken)));
      if (!ptr) throw notFound('Invalid invitation token');

      // Enter the invitation's tenant context (the invitation row is RLS-scoped).
      await setTenantContext(ptr.workspaceId);
      const [inv] = await tx
        .select()
        .from(invitations)
        .where(eq(invitations.id, ptr.invitationId));
      if (!inv || inv.acceptedAt) throw notFound('Invalid invitation token');
      if (inv.expiresAt.getTime() < Date.now()) throw badRequest('Invitation expired');

      const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, ptr.workspaceId));
      return {
        email: inv.email,
        role: inv.role,
        workspaceName: ws?.name ?? '',
        expiresAt: inv.expiresAt,
      };
    });
  },

  /**
   * Accept an invitation. Public endpoint with OPTIONAL auth:
   *  - Invitee already has an account: must be signed in AS the invitee
   *    (token-derived userId === user with the invite email). No account
   *    takeover possible — the token alone can't attach to someone else's user.
   *  - Invitee has no account: name+password required; user is created here
   *    (unverified) and a session scoped to the NEW workspace is issued.
   * Single-use: the global token pointer is deleted on success.
   */
  async acceptInvitation(
    presentedToken: string,
    callerUserId: string | null,
    input: { name?: string; password?: string },
    meta?: { ip?: string; userAgent?: string },
  ): Promise<SessionResult> {
    return withoutTenant(process.env.DATABASE_URL!, async () => {
      const tx = currentTx();
      const tokenHash = hashToken(presentedToken);
      const [ptr] = await tx
        .select()
        .from(invitationTokens)
        .where(eq(invitationTokens.tokenHash, tokenHash));
      if (!ptr) throw notFound('Invalid invitation token');

      await setTenantContext(ptr.workspaceId);
      const [inv] = await tx
        .select()
        .from(invitations)
        .where(eq(invitations.id, ptr.invitationId));
      if (!inv || inv.acceptedAt) throw notFound('Invalid invitation token');
      if (inv.expiresAt.getTime() < Date.now()) throw badRequest('Invitation expired');

      // Resolve the invitee's user account (users is a global table).
      const [existing] = await tx.select().from(users).where(eq(users.email, inv.email));
      let user;
      if (existing) {
        if (!callerUserId) throw unauthenticated('Sign in to accept this invitation');
        if (callerUserId !== existing.id)
          throw forbidden('This invitation is for a different email address');
        user = existing;
      } else {
        if (!input.name || !input.password) {
          throw badRequest('Name and password are required to create your account');
        }
        if (input.password.length < MIN_PASSWORD_LENGTH) {
          throw badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
        }
        const passwordHash = await hashPassword(input.password);
        const [created] = await tx
          .insert(users)
          .values({ email: inv.email, passwordHash, name: input.name, emailVerifiedAt: new Date() })
          .returning();
        if (!created) throw conflict('Failed to create account');
        user = created;
        // The single-use invitation link was delivered to this address and
        // proves mailbox access, so accepting it also verifies the account.
      }

      // Membership (idempotent: already a member — e.g. re-invited owner —
      // just gets a session; the unique index guards concurrent accepts).
      await tx
        .insert(memberships)
        .values({ workspaceId: ptr.workspaceId, userId: user.id, role: inv.role })
        .onConflictDoNothing();

      // Consume the invitation: mark accepted + delete the pointer (single use).
      await tx
        .update(invitations)
        .set({ acceptedAt: new Date() })
        .where(eq(invitations.id, inv.id));
      await tx
        .delete(invitationTokens)
        .where(eq(invitationTokens.tokenHash, tokenHash));

      return authService.issueSession(user, ptr.workspaceId, inv.role, meta);
    });
  },

  async updateRole(
    workspaceId: string,
    actorRole: Role,
    targetUserId: string,
    body: unknown,
  ): Promise<{ ok: true }> {
    assertCapability(actorRole, 'members:update-role');
    const input = updateRoleSchema.parse(body);

    return withTenant(process.env.DATABASE_URL!, workspaceId, async () => {
      const tx = currentTx();
      const [target] = await tx
        .select()
        .from(memberships)
        .where(eq(memberships.userId, targetUserId));
      if (!target) throw notFound('Member not found');
      if (target.role === 'owner') throw forbidden('Cannot change the owner role');

      await tx
        .update(memberships)
        .set({ role: input.role })
        .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, targetUserId)));
      return { ok: true as const };
    });
  },

  async removeMember(
    workspaceId: string,
    actorRole: Role,
    targetUserId: string,
  ): Promise<{ ok: true }> {
    assertCapability(actorRole, 'members:remove');
    return withTenant(process.env.DATABASE_URL!, workspaceId, async () => {
      const tx = currentTx();
      const [target] = await tx
        .select()
        .from(memberships)
        .where(eq(memberships.userId, targetUserId));
      if (!target) throw notFound('Member not found');
      if (target.role === 'owner') throw forbidden('Cannot remove the owner');
      await tx
        .delete(memberships)
        .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, targetUserId)));
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(
          eq(refreshTokens.workspaceId, workspaceId),
          eq(refreshTokens.userId, targetUserId),
          isNull(refreshTokens.revokedAt),
        ));
      return { ok: true as const };
    });
  },
};
