'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type ApiKeyView } from '@/lib/api';

/** API keys: mint (key shown once), list, revoke. */
export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyView[]>([]);
  const [name, setName] = useState('');
  const [newKey, setNewKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<{
    keyName: string;
    ok: boolean;
    detail: string;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      setKeys(await api.listApiKeys());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load keys');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError('');
    setBusy(true);
    try {
      const key = await api.createApiKey(name.trim());
      setNewKey(key.publicKey);
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create key');
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(id: string) {
    setError('');
    try {
      await api.revokeApiKey(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke');
    }
  }

  /** "Verify installation" — resolve the public settings endpoint like a real widget. */
  async function onVerify(key: ApiKeyView) {
    setError('');
    setVerifying(key.id);
    setVerifyResult(null);
    try {
      const result = await api.checkWidgetKey(key.publicKey);
      setVerifyResult({ keyName: key.name, ok: result.ok, detail: result.detail });
    } catch (err) {
      setVerifyResult({
        keyName: key.name,
        ok: false,
        detail: err instanceof Error ? err.message : 'Check failed',
      });
    } finally {
      setVerifying(null);
    }
  }

  return (
    <>
      <div className="topbar">
        <h1>API Keys</h1>
      </div>
      <div className="content">
        {error && <div className="alert error">{error}</div>}
        {newKey && (
          <div className="alert success">
            <strong>Key created — copy it now:</strong>
            <div className="mono" style={{ marginTop: 6, wordBreak: 'break-all' }}>
              {newKey}
            </div>
            <button className="btn secondary small" style={{ marginTop: 8 }} onClick={() => setNewKey('')}>
              Dismiss
            </button>
          </div>
        )}

        <div className="card">
          <h2>Mint a widget key</h2>
          <form onSubmit={onCreate} style={{ display: 'flex', gap: 10 }}>
            <div className="field" style={{ flex: 1, marginBottom: 0 }}>
              <input
                placeholder="e.g. Marketing site"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <button className="btn" type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create key'}
            </button>
          </form>
          <p className="muted" style={{ marginBottom: 0, marginTop: 10 }}>
            The key ships in your website&apos;s embed snippet. Revoking it instantly disables the
            widget on every site using it.
          </p>
        </div>

        <div className="card">
          <h2>Keys</h2>
          <table className="list">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Status</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td className="mono">{k.publicKey.slice(0, 22)}…</td>
                  <td>
                    {k.revokedAt ? (
                      <span className="badge revoked">revoked</span>
                    ) : (
                      <span className="badge open">active</span>
                    )}
                  </td>
                  <td className="muted">
                    {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'never'}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button
                      className="btn secondary small"
                      style={{ marginRight: 8 }}
                      disabled={verifying === k.id}
                      onClick={() => void onVerify(k)}
                    >
                      {verifying === k.id ? 'Checking…' : 'Verify'}
                    </button>
                    {!k.revokedAt && (
                      <button className="btn danger small" onClick={() => void onRevoke(k.id)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {keys.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    No keys yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {verifyResult && (
            <div
              className={`alert ${verifyResult.ok ? 'success' : 'error'}`}
              style={{ marginTop: 12, marginBottom: 0 }}
            >
              <strong>
                {verifyResult.ok ? '✓ Looks good' : '⚠ Not ready'} — {verifyResult.keyName}:
              </strong>{' '}
              {verifyResult.detail}
            </div>
          )}
        </div>

        <div className="card">
          <h2>Embed snippet</h2>
          <p className="muted">Paste this on every page, just before &lt;/body&gt;:</p>
          <pre
            className="mono"
            style={{ background: '#0f172a', color: '#e2e8f0', padding: 14, borderRadius: 8, overflowX: 'auto' }}
          >
{`<script src="${process.env.NEXT_PUBLIC_WIDGET_URL ?? 'https://cdn.example.com'}/widget.js"
        data-public-key="pk_…"
        data-api-url="${process.env.NEXT_PUBLIC_API_URL ?? 'https://api.example.com'}"
        async></script>`}
          </pre>
        </div>
      </div>
    </>
  );
}
