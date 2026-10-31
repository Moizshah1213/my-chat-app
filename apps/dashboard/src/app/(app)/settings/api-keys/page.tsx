'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  ShieldCheck,
  X,
} from 'lucide-react';
import { api, type ApiKeyView } from '@/lib/api';

/** API keys: mint (key shown once), list, revoke. */
export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyView[]>([]);
  const [name, setName] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newKeyVisible, setNewKeyVisible] = useState(true);
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(() => new Set());
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
      setNewKeyVisible(true);
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

  function toggleKeyVisibility(id: string) {
    setVisibleKeys((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="page api-keys-page">
      {error && <div className="alert error" role="alert">{error}</div>}

      {newKey && (
        <section className="api-key-created" role="status">
          <div className="api-key-created-icon"><KeyRound size={17} /></div>
          <div className="api-key-created-content">
            <div className="api-key-created-heading">
              <strong>Widget key created</strong>
              <span>Copy and store it now. It won’t be shown again.</span>
            </div>
            <div className="api-key-created-key">
              <code className="api-key-created-value">
                {newKeyVisible ? newKey : `${newKey.slice(0, 9)}${'•'.repeat(16)}`}
              </code>
              <button
                className="api-key-visibility"
                type="button"
                aria-label={newKeyVisible ? 'Hide API key' : 'Show API key'}
                title={newKeyVisible ? 'Hide API key' : 'Show API key'}
                onClick={() => setNewKeyVisible((visible) => !visible)}
              >
                {newKeyVisible ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          <button
            className="api-key-created-dismiss"
            type="button"
            aria-label="Dismiss key notice"
            onClick={() => setNewKey('')}
          >
            <X size={16} />
          </button>
        </section>
      )}

      <section className="card api-key-create-card">
        <div className="api-key-section-heading">
          <div className="api-key-section-icon"><Plus size={17} /></div>
          <div>
            <h2>Create a widget key</h2>
            <p className="muted">Create one key for each website or environment.</p>
          </div>
        </div>
        <form className="api-key-create-form" onSubmit={onCreate}>
          <label className="field">
            <span>Key name</span>
            <input
              placeholder="e.g. Marketing site"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </label>
          <button className="btn" type="submit" disabled={busy}>
            <Plus size={15} />
            {busy ? 'Creating…' : 'Create key'}
          </button>
        </form>
        <p className="api-key-create-note">
          Revoking a key immediately disables the widget anywhere that key is installed.
        </p>
      </section>

      <section className="card api-key-list-card">
        <div className="api-key-section-heading api-key-list-heading">
          <div className="api-key-section-icon"><ShieldCheck size={17} /></div>
          <div>
            <h2>Your widget keys</h2>
            <p className="muted">Check installation status or revoke keys you no longer use.</p>
          </div>
        </div>
        {keys.length > 0 ? (
          <div className="api-key-table-wrap">
            <table className="list api-key-table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Public key</th>
                  <th>Status</th>
                  <th>Last used</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id}>
                    <td className="api-key-name-cell">
                      <span className="api-key-row-icon"><KeyRound size={14} /></span>
                      <span>{key.name}</span>
                    </td>
                    <td>
                      <div className="api-key-key-cell">
                        <code className="api-key-masked">
                          {visibleKeys.has(key.id) ? key.publicKey : `${key.publicKey.slice(0, 9)}${'•'.repeat(16)}`}
                        </code>
                        <button
                          className="api-key-visibility"
                          type="button"
                          aria-label={visibleKeys.has(key.id) ? `Hide ${key.name} key` : `Show ${key.name} key`}
                          title={visibleKeys.has(key.id) ? 'Hide key' : 'Show key'}
                          onClick={() => toggleKeyVisibility(key.id)}
                        >
                          {visibleKeys.has(key.id) ? <EyeOff size={15} /> : <Eye size={15} />}
                        </button>
                      </div>
                    </td>
                    <td>
                      {key.revokedAt ? (
                        <span className="api-key-status revoked">Revoked</span>
                      ) : (
                        <span className="api-key-status active">Active</span>
                      )}
                    </td>
                    <td className="api-key-last-used">
                      {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'Never'}
                    </td>
                    <td className="api-key-actions">
                      <button
                        className="btn s sm"
                        disabled={verifying === key.id}
                        onClick={() => void onVerify(key)}
                      >
                        {verifying === key.id ? 'Checking…' : 'Verify'}
                      </button>
                      {!key.revokedAt && (
                        <button
                          className="btn s sm api-key-revoke"
                          onClick={() => void onRevoke(key.id)}
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="api-key-empty">
            <div><KeyRound size={19} /></div>
            <strong>No widget keys yet</strong>
            <span>Create a key above to connect your website to this workspace.</span>
          </div>
        )}
        {verifyResult && (
          <div className={`api-key-verify-result ${verifyResult.ok ? 'success' : 'error'}`} role="status">
            {verifyResult.ok ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
            <div>
              <strong>
                {verifyResult.ok ? 'Installation verified' : 'Installation needs attention'} · {verifyResult.keyName}
              </strong>
              <span>{verifyResult.detail}</span>
            </div>
          </div>
        )}
      </section>

      <section className="card api-key-embed-card">
        <div className="api-key-section-heading">
          <div className="api-key-section-icon"><Code2 size={17} /></div>
          <div>
            <h2>Install the widget</h2>
            <p className="muted">Add this snippet before the closing <code>&lt;/body&gt;</code> tag.</p>
          </div>
        </div>
        <pre className="code api-key-embed-code">
{`<script src="${process.env.NEXT_PUBLIC_WIDGET_URL ?? 'https://cdn.example.com'}/widget.js"
        data-public-key="qvse_…"
        data-api-url="${process.env.NEXT_PUBLIC_API_URL ?? 'https://api.example.com'}"
        async></script>`}
        </pre>
        <p className="api-key-embed-footnote">Replace <code>qvse_…</code> with the public key for this website.</p>
      </section>
    </div>
  );
}
