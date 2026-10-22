'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type LoginSession } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/**
 * Security settings (blueprint §7.1/§12): TOTP 2FA enrollment with recovery
 * codes, and session management ("log out everywhere").
 */
export default function SecurityPage() {
  const { user } = useAuth();
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // 2FA setup flow
  const [pending, setPending] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);

  // 2FA disable flow
  const [pw, setPw] = useState('');
  const [dcode, setDcode] = useState('');

  // sessions
  const [sessions, setSessions] = useState<LoginSession[]>([]);

  useEffect(() => {
    setEnabled(Boolean(user?.totpEnabled));
  }, [user?.totpEnabled]);

  const loadSessions = useCallback(async () => {
    try {
      setSessions(await api.listSessions());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions');
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  async function onStartSetup() {
    setError('');
    setBusy(true);
    try {
      setPending(await api.setup2fa());
      setCode('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '2FA setup failed');
    } finally {
      setBusy(false);
    }
  }

  async function onVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setError('');
    setBusy(true);
    try {
      const result = await api.enable2fa(code.trim());
      setRecovery(result.recoveryCodes);
      setPending(null);
      setCode('');
      setEnabled(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid code');
    } finally {
      setBusy(false);
    }
  }

  async function onDisable(e: React.FormEvent) {
    e.preventDefault();
    if (!pw || !dcode.trim()) return;
    setError('');
    setBusy(true);
    try {
      await api.disable2fa(pw, dcode.trim());
      setEnabled(false);
      setPw('');
      setDcode('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disable 2FA');
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(id: string) {
    setError('');
    try {
      await api.revokeSession(id);
      await loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke session');
    }
  }

  async function onLogoutAll() {
    setError('');
    try {
      await api.logoutAll();
      await loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to log out other sessions');
    }
  }

  return (
    <div className="page">
      {error && <div className="alert error">{error}</div>}

        <div className="card">
          <h2>Two-factor authentication</h2>
          {recovery ? (
            <div className="alert success">
              <strong>2FA enabled. Recovery codes — copy them now, shown once:</strong>
              <div
                className="mono"
                style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}
              >
                {recovery.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </div>
              <button
                className="btn s"
                style={{ marginTop: 8 }}
                onClick={() => setRecovery(null)}
              >
                I saved them
              </button>
            </div>
          ) : enabled ? (
            <>
              <p>
                <span className="badge open">enabled</span> — authenticator codes are required at
                sign-in.
              </p>
              <form onSubmit={onDisable}>
                <div className="form-row">
                  <div className="field">
                    <label htmlFor="pw">Password</label>
                    <input
                      id="pw"
                      type="password"
                      autoComplete="current-password"
                      value={pw}
                      onChange={(e) => setPw(e.target.value)}
                      required
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="dcode">Authenticator or recovery code</label>
                    <input
                      id="dcode"
                      placeholder="123456 or xxxxx-xxxxx"
                      value={dcode}
                      onChange={(e) => setDcode(e.target.value)}
                      required
                    />
                  </div>
                </div>
                <button className="btn danger" type="submit" disabled={busy}>
                  {busy ? 'Disabling…' : 'Disable 2FA'}
                </button>
              </form>
            </>
          ) : pending ? (
            <>
              <p className="muted">
                Add this secret to your authenticator app, then confirm with the 6-digit code it
                shows:
              </p>
              <div className="code" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {pending.otpauthUrl}
              </div>
              <div className="mono muted" style={{ marginTop: 6, wordBreak: 'break-all' }}>
                Secret: {pending.secret}
              </div>
              <form onSubmit={onVerify} style={{ marginTop: 12, display: 'flex', gap: 10 }}>
                <div className="field" style={{ marginBottom: 0, width: 180 }}>
                  <input
                    aria-label="6-digit code"
                    placeholder="123456"
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                  />
                </div>
                <button className="btn" type="submit" disabled={busy}>
                  {busy ? 'Verifying…' : 'Verify & enable'}
                </button>
                <button className="btn s" type="button" onClick={() => setPending(null)}>
                  Cancel
                </button>
              </form>
            </>
          ) : (
            <>
              <p className="muted">
                Require a 6-digit authenticator code at sign-in, with one-time recovery codes as a
                backup.
              </p>
              <button className="btn" onClick={() => void onStartSetup()} disabled={busy}>
                {busy ? 'Preparing…' : 'Set up 2FA'}
              </button>
            </>
          )}
        </div>

        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>Sessions</h2>
            <button className="btn s" onClick={() => void onLogoutAll()}>
              Log out other sessions
            </button>
          </div>
          <p className="muted">Every signed-in device for your account.</p>
          <table className="list">
            <thead>
              <tr>
                <th>Device</th>
                <th>IP</th>
                <th>Signed in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>
                    {(s.userAgent ?? 'Unknown device').slice(0, 70)}
                    {s.current && (
                      <span className="badge open" style={{ marginLeft: 8 }}>
                        this device
                      </span>
                    )}
                  </td>
                  <td className="mono muted">{s.ip ?? '—'}</td>
                  <td className="muted">{new Date(s.createdAt).toLocaleString()}</td>
                  <td style={{ textAlign: 'right' }}>
                    {!s.current && (
                      <button className="btn danger sm" onClick={() => void onRevoke(s.id)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {sessions.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    No active sessions found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
  );
}
