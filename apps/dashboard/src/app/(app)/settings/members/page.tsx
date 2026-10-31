'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, API_URL, type Invitation, type Member, type Role } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Check, Copy, Mail, Plus, Trash2, Users } from 'lucide-react';

function displayDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

function initials(name: string | null, email: string) {
  const label = name?.trim() || email;
  return label.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

export default function MembersPage() {
  const { user, role: myRole } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('agent');
  const [inviteId, setInviteId] = useState('');
  const [inviteUrl, setInviteUrl] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const [memberRows, invitationRows] = await Promise.all([
        api.listMembers(),
        api.listInvitations(),
      ]);
      const workspaceMembers = [...memberRows];
      if (user && myRole && !workspaceMembers.some((member) => member.userId === user.id)) {
        workspaceMembers.unshift({
          userId: user.id,
          name: user.name,
          email: user.email,
          role: myRole,
          createdAt: '',
        });
      }
      workspaceMembers.sort((a, b) => Number(b.userId === user?.id) - Number(a.userId === user?.id));
      setMembers(workspaceMembers);
      setInvitations(invitationRows.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load team');
    } finally {
      setLoading(false);
    }
  }, [myRole, user]);

  useEffect(() => {
    void load();
  }, [load]);

  const canInvite = myRole === 'owner' || myRole === 'admin';
  const canChangeRoles = myRole === 'owner';
  const pendingCount = invitations.filter((invitation) => invitation.status === 'pending').length;

  async function onInvite(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    setInviteId('');
    setInviteUrl('');
    setBusy(true);
    try {
      const result = await api.invite(email.trim(), inviteRole);
      setInviteId(result.invitationId);
      setInviteUrl(result.inviteUrl || `${window.location.origin}/invite/${encodeURIComponent(result.token)}`);
      setEmail('');
      setNotice('Invitation created. Copy the secure link and share it with your teammate.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create invitation');
    } finally {
      setBusy(false);
    }
  }

  async function copyInviteLink() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setNotice('Invite link copied to clipboard.');
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not access the clipboard. Select and copy the invite link manually.');
    }
  }

  async function onChangeRole(member: Member, role: Role) {
    setError('');
    setNotice('');
    setActionId(member.userId);
    try {
      await api.updateRole(member.userId, role);
      setNotice(`${member.name || member.email} is now ${role}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change role');
    } finally {
      setActionId('');
    }
  }

  async function onRemove(member: Member) {
    if (!window.confirm(`Remove ${member.name || member.email} from this workspace?`)) return;
    setError('');
    setNotice('');
    setActionId(member.userId);
    try {
      await api.removeMember(member.userId);
      setNotice(`${member.name || member.email} was removed from the workspace.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member');
    } finally {
      setActionId('');
    }
  }

  async function onCancelInvitation(invitation: Invitation) {
    if (!window.confirm(`Cancel the invitation sent to ${invitation.email}? Its link will stop working.`)) return;
    setError('');
    setNotice('');
    setActionId(invitation.id);
    try {
      await api.cancelInvitation(invitation.id);
      setNotice(`Invitation for ${invitation.email} was cancelled.`);
      if (inviteId === invitation.id) {
        setInviteId('');
        setInviteUrl('');
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel invitation');
    } finally {
      setActionId('');
    }
  }

  return (
    <div className="page team-page">
      {error && <div className="alert error" role="alert">{error}</div>}
      {notice && <div className="alert success" role="status">{notice}</div>}

      {inviteUrl && (
        <section className="card invite-link-card">
          <div className="invite-link-heading">
            <span className="invite-link-icon"><Mail size={18} /></span>
            <div>
              <h2>Invitation link ready</h2>
              <p className="muted">Share this link with the teammate you invited. It expires in 7 days.</p>
            </div>
          </div>
          <div className="invite-link-row">
            <input aria-label="Invitation link" readOnly value={inviteUrl} onFocus={(event) => event.target.select()} />
            <button type="button" className="btn" onClick={() => void copyInviteLink()}>
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <button type="button" className="icon-btn" aria-label="Dismiss invitation link" onClick={() => setInviteUrl('')}>
              ×
            </button>
          </div>
        </section>
      )}

      {canInvite && (
        <section className="card team-invite-card">
          <div className="team-section-heading">
            <div>
              <h2>Invite a teammate</h2>
              <p className="muted">Add someone to your workspace and choose their access level.</p>
            </div>
          </div>
          <form className="team-invite-form" onSubmit={(event) => void onInvite(event)}>
            <label className="field">
              <span>Work email</span>
              <input
                type="email"
                autoComplete="email"
                placeholder="teammate@company.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Role</span>
              <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as Role)}>
                <option value="agent">Agent</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <button className="btn" type="submit" disabled={busy}>
              <Plus size={16} />
              {busy ? 'Creating invite…' : 'Create invite'}
            </button>
          </form>
        </section>
      )}

      <section className="card team-members-card">
        <div className="team-section-heading">
          <div>
            <h2>Team members</h2>
            <p className="muted">People who can access this workspace.</p>
          </div>
          <span className="team-count"><Users size={15} /> {members.length} {members.length === 1 ? 'member' : 'members'}</span>
        </div>
        <div className="team-table-wrap">
          <table className="team-table">
            <thead>
              <tr><th>Member</th><th>Access</th><th /></tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const isOwner = member.role === 'owner';
                const isMe = member.userId === user?.id;
                return (
                  <tr key={member.userId}>
                    <td>
                      <div className="team-user">
                        <span className="team-avatar">
                          {member.userId === user?.id && user.avatarUrl
                            ? <img src={user.avatarUrl.startsWith('/') ? `${API_URL}${user.avatarUrl}` : user.avatarUrl} alt="" />
                            : initials(member.name, member.email)}
                        </span>
                        <span className="team-user-copy">
                          <strong>{member.name || 'Name not set'} {isMe && <small>(you)</small>}</strong>
                          <span>{member.email}</span>
                        </span>
                      </div>
                    </td>
                    <td>
                      {canChangeRoles && !isOwner ? (
                        <select
                          value={member.role}
                          onChange={(event) => void onChangeRole(member, event.target.value as Role)}
                          aria-label={`Role for ${member.name || member.email}`}
                          className="team-role-select"
                          disabled={actionId === member.userId}
                        >
                          <option value="agent">Agent</option>
                          <option value="admin">Admin</option>
                        </select>
                      ) : <span className={`team-role-label role-${member.role}`}>{member.role}</span>}
                    </td>
                    <td className="team-actions">
                      {canInvite && !isOwner && !isMe && (
                        <button
                          type="button"
                          className="team-remove"
                          aria-label={`Remove ${member.name || member.email} from the workspace`}
                          title="Remove member"
                          disabled={actionId === member.userId}
                          onClick={() => void onRemove(member)}
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!loading && members.length === 0 && (
                <tr><td colSpan={3} className="team-empty">No members found.</td></tr>
              )}
              {loading && (
                <tr><td colSpan={3} className="team-empty">Loading team…</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="team-footnote">Only workspace owners can change member roles. Role changes apply after the member refreshes their session.</p>
      </section>

      <section className="card team-invitations-card">
        <div className="team-section-heading">
          <div>
            <h2>Invitations</h2>
            <p className="muted">Track invites sent to teammates and manage links that are still open.</p>
          </div>
          <span className="team-count">{pendingCount} pending</span>
        </div>
        <div className="team-table-wrap">
          <table className="team-table">
            <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Sent</th><th>Expires</th><th /></tr></thead>
            <tbody>
              {invitations.map((invitation) => (
                <tr key={invitation.id}>
                  <td><span className="team-invite-email">{invitation.email}</span></td>
                  <td><span className={`team-role-badge role-${invitation.role}`}>{invitation.role}</span></td>
                  <td><span className={`team-status ${invitation.status}`}>{invitation.status}</span></td>
                  <td className="team-date">{displayDate(invitation.createdAt)}</td>
                  <td className="team-date">{displayDate(invitation.expiresAt)}</td>
                  <td className="team-actions">
                    {canInvite && invitation.status === 'pending' && (
                      <button
                        type="button"
                        className="team-remove"
                        disabled={actionId === invitation.id}
                        onClick={() => void onCancelInvitation(invitation)}
                      >
                        <Trash2 size={14} /> Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!loading && invitations.length === 0 && (
                <tr><td colSpan={6} className="team-empty">No invitations yet.</td></tr>
              )}
              {loading && (
                <tr><td colSpan={6} className="team-empty">Loading invitations…</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
