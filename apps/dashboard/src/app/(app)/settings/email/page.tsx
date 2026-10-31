'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type EmailSettingsInput, type EmailSettingsView } from '@/lib/api';

const EMPTY: EmailSettingsView = {
  provider: 'smtp',
  host: null,
  port: null,
  user: null,
  fromEmail: null,
  fromName: null,
  verifiedAt: null,
};

/** Email provider configuration (system + company emails). */
export default function EmailSettingsPage() {
  const [s, setS] = useState<EmailSettingsView>(EMPTY);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');

  const load = useCallback(async () => {
    try {
      setS(await api.getEmailSettings());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load email settings');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setError('');
    setSaved(false);
    setBusy(true);
    try {
      const input: EmailSettingsInput = {
        provider: s.provider,
        host: s.host || undefined,
        port: s.port ?? undefined,
        user: s.user || undefined,
        password: password || undefined,
        fromEmail: s.fromEmail,
        fromName: s.fromName || null,
      };
      await api.updateEmailSettings(input);
      setPassword('');
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save email settings');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      {error && <div className="alert error">{error}</div>}
      {saved && <div className="alert success">Email settings saved.</div>}
      <form className="card" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <h2>Provider</h2>
        <p className="muted" style={{ marginBottom: 12 }}>
          SMTP credentials are sealed at rest (AES-256-GCM) and never returned to the browser. Save once — the key is stored encrypted.
        </p>
        <div className="field">
          <label htmlFor="provider">Provider</label>
          <select id="provider" value={s.provider} onChange={(e) => setS({ ...s, provider: e.target.value as EmailSettingsView['provider'] })}>
            <option value="smtp">SMTP</option>
            <option value="resend">Resend</option>
            <option value="sendgrid">SendGrid</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="host">SMTP host</label>
          <input id="host" placeholder="smtp.example.com" value={s.host ?? ''} onChange={(e) => setS({ ...s, host: e.target.value || null })} />
        </div>
        <div className="field">
          <label htmlFor="port">SMTP port</label>
          <input id="port" type="number" min="1" max="65535" step="1" value={String(s.port ?? '')} onChange={(e) => setS({ ...s, port: e.target.value ? Number(e.target.value) : null })} />
          <p className="muted" style={{ marginTop: 4, fontSize: 12 }}>
            465 (SSL) or 587 (STARTTLS). Only public hosts allowed.
          </p>
        </div>
        <div className="field">
          <label htmlFor="user">SMTP user</label>
          <input id="user" placeholder="user@example.com" value={s.user ?? ''} onChange={(e) => setS({ ...s, user: e.target.value || null })} />
        </div>
        <div className="field">
          <label htmlFor="password">SMTP password / API key</label>
          <input id="password" type="password" autoComplete="new-password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="muted" style={{ marginTop: 4, fontSize: 12 }}>
            Leave blank to keep the existing value. Never shown again after saving.
          </p>
        </div>

        <h2 style={{ marginTop: 24 }}>Sender</h2>
        <div className="field">
          <label htmlFor="fromEmail">From email</label>
          <input id="fromEmail" type="email" placeholder="no-reply@example.com" value={s.fromEmail ?? ''} onChange={(e) => setS({ ...s, fromEmail: e.target.value || null })} />
        </div>
        <div className="field">
          <label htmlFor="fromName">From name</label>
          <input id="fromName" placeholder="Qonvilo" value={s.fromName ?? ''} onChange={(e) => setS({ ...s, fromName: e.target.value || null })} />
        </div>

        <button className="btn" type="submit" disabled={busy} style={{ marginTop: 16 }}>
          {busy ? 'Saving…' : 'Save email settings'}
        </button>
      </form>
    </div>
  );
}
