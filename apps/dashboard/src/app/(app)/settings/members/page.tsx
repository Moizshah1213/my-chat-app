'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type Member, type Role } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/** Team management: members list, invite (token shown once), roles, removal. */
export default function MembersPage() {
  const { user, role: myRole } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('agent');
  const [inviteToken, setInviteToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setMembers(await api.listMembers());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load members');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const canManage = myRole === 'owner' || myRole === 'admin';

  async function onInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setError('');
    setBusy(true);
    try {
      const res = await api.invite(email.trim(), inviteRole);
      setInviteToken(res.token);
      setEmail('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to invite');
    } finally {
      setBusy(false);
    }
  }

  async function onChangeRole(userId: string, role: Role) {
    setError('');
    try {
      await api.updateRole(userId, role);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change role');
    }
  }

  async function onRemove(userId: string) {
    setError('');
    try {
      await api.removeMember(userId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member');
    }
  }

  return (
    <div className="page">
      {error && <div className="alert error">{error}</div>}
        {inviteToken && (
          <div className="alert success">
            <strong>Invitation created — share this link (dev stand-in for email):</strong>
            <div className="mono" style={{ marginTop: 6, wordBreak: 'break-all' }}>
              {inviteToken}
            </div>
            <button
              className="btn s"
              style={{ marginTop: 8 }}
              onClick={() => setInviteToken('')}
            >
              Dismiss
            </button>
          </div>
        )}

        {canManage && (
          <div className="card">
            <h2>Invite a teammate</h2>
            <form onSubmit={onInvite} style={{ display: 'flex', gap: 10 }}>
              <div className="field" style={{ flex: 2, marginBottom: 0 }}>
                <input
                  type="email"
                  placeholder="teammate@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as Role)}
                  aria-label="Role"
                >
                  <option value="agent">Agent</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <button className="btn" type="submit" disabled={busy}>
                {busy ? 'Inviting…' : 'Send invite'}
              </button>
            </form>
          </div>
        )}

        <div className="card">
          <h2>Members</h2>
          <table className="list">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Joined</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const isOwner = m.role === 'owner';
                const isMe = m.userId === user?.id;
                return (
                  <tr key={m.userId}>
                    <td className="mono">
                      {m.userId.slice(0, 13)}… {isMe && <span className="muted">(you)</span>}
                    </td>
                    <td>
                      {canManage && !isOwner ? (
                        <select
                          value={m.role}
                          onChange={(e) => void onChangeRole(m.userId, e.target.value as Role)}
                          aria-label={`Role for ${m.userId}`}
                          className="pill-select"
                        >
                          <option value="agent">agent</option>
                          <option value="admin">admin</option>
                          <option value="owner">owner</option>
                        </select>
                      ) : (
                        <span className={`badge ${isOwner ? 'closed' : 'open'}`}>{m.role}</span>
                      )}
                    </td>
                    <td className="muted">{new Date(m.createdAt).toLocaleDateString()}</td>
                    <td style={{ textAlign: 'right' }}>
                      {canManage && !isOwner && !isMe && (
                        <button className="btn danger sm" onClick={() => void onRemove(m.userId)}>
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {members.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    No members.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
            Only owners can change roles. Role changes take effect on the member&apos;s next token
            refresh.
          </p>
        </div>
      </div>
  );
}
