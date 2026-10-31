'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api, type Role } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import AuthLayout from '@/components/auth-layout';

interface InvitationPreview {
  email: string;
  role: Role;
  workspaceName: string;
  expiresAt: string;
}

export default function InvitationPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const token = params.token;
  const { user, loading: authLoading, acceptInvitation, signOut } = useAuth();
  const [invitation, setInvitation] = useState<InvitationPreview | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api.previewInvitation(token)
      .then((preview) => {
        if (active) setInvitation(preview);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'This invitation is invalid or expired.');
      });
    return () => {
      active = false;
    };
  }, [token]);

  const signedInAsInvitee =
    !!user?.email && !!invitation?.email && user.email.toLowerCase() === invitation.email.toLowerCase();
  const loginHref = `/login?next=${encodeURIComponent(`/invite/${token}`)}`;

  async function onAccept(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await acceptInvitation(token, user ? {} : { name, password });
      router.replace('/overview');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not accept this invitation.');
    } finally {
      setBusy(false);
    }
  }

  async function switchAccount() {
    await signOut();
    router.replace(loginHref);
  }

  return (
    <AuthLayout>
      <section className="auth-card">
        <h1>Join {invitation?.workspaceName || 'workspace'}</h1>
        <p className="sub">You’ve been invited to join this team.</p>
        {error && <div className="alert error">{error}</div>}
        {!invitation && !error && <p className="loading">Checking invitation…</p>}
        {invitation && (
          <>
            <div className="invite-summary">
              <span><strong>Email</strong><span>{invitation.email}</span></span>
              <span><strong>Role</strong><span className="badge">{invitation.role}</span></span>
              <span>
                <strong>Expires</strong>
                <span>{new Date(invitation.expiresAt).toLocaleDateString()}</span>
              </span>
            </div>
            {authLoading ? (
              <p className="loading">Checking your account…</p>
            ) : user && signedInAsInvitee ? (
              <form onSubmit={onAccept}>
                <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
                  {busy ? 'Joining workspace…' : 'Accept invitation'}
                </button>
              </form>
            ) : user ? (
              <div className="invite-actions">
                <p className="muted">
                  This invitation is for <strong>{invitation.email}</strong>. You’re signed in as {user.email}.
                </p>
                <button className="btn" type="button" onClick={() => void switchAccount()}>
                  Sign in as invitee
                </button>
              </div>
            ) : (
              <form onSubmit={onAccept}>
                <div className="field">
                  <label htmlFor="invite-name">Your name</label>
                  <input
                    id="invite-name"
                    autoComplete="name"
                    required
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="invite-password">Create password</label>
                  <input
                    id="invite-password"
                    type="password"
                    autoComplete="new-password"
                    minLength={10}
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </div>
                <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
                  {busy ? 'Accepting…' : 'Create account & join'}
                </button>
                <p className="auth-alt">
                  Already have an account? <Link href={loginHref}>Sign in to accept</Link>
                </p>
              </form>
            )}
          </>
        )}
      </section>
    </AuthLayout>
  );
}
