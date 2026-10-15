'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type WidgetSettingsView } from '@/lib/api';

const EMPTY: WidgetSettingsView = {
  color: '#4f46e5',
  logoUrl: null,
  position: 'right',
  greeting: null,
  offlineMessage: null,
  prechatFields: [],
  workingHours: {},
  aiEnabled: false,
  aiInstructions: null,
  allowedDomains: [],
  language: 'en',
};

/** Widget customization: appearance, copy, and the site allowlist. */
export default function WidgetSettingsPage() {
  const [form, setForm] = useState<WidgetSettingsView>(EMPTY);
  const [domains, setDomains] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await api.getWidgetSettings();
      setForm(s);
      setDomains(s.allowedDomains.join('\n'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const set = <K extends keyof WidgetSettingsView>(key: K, value: WidgetSettingsView[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSaved(false);
    setBusy(true);
    try {
      const updated = await api.updateWidgetSettings({
        color: form.color,
        position: form.position,
        greeting: form.greeting || null,
        offlineMessage: form.offlineMessage || null,
        logoUrl: form.logoUrl || null,
        language: form.language,
        allowedDomains: domains
          .split('\n')
          .map((d) => d.trim())
          .filter(Boolean),
      });
      setForm(updated);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="topbar">
        <h1>Widget Settings</h1>
      </div>
      <div className="content">
        {error && <div className="alert error">{error}</div>}
        {saved && <div className="alert success">Settings saved.</div>}
        <form className="card" onSubmit={onSave}>
          <h2>Appearance</h2>
          <div className="form-row">
            <div className="field">
              <label htmlFor="color">Brand color</label>
              <input
                id="color"
                type="color"
                value={form.color}
                onChange={(e) => set('color', e.target.value)}
                style={{ height: 38, padding: 3 }}
              />
            </div>
            <div className="field">
              <label htmlFor="position">Position</label>
              <select
                id="position"
                value={form.position}
                onChange={(e) => set('position', e.target.value as 'left' | 'right')}
              >
                <option value="right">Bottom right</option>
                <option value="left">Bottom left</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="language">Language</label>
              <input
                id="language"
                maxLength={10}
                value={form.language}
                onChange={(e) => set('language', e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="logo">Logo URL</label>
            <input
              id="logo"
              placeholder="https://…/logo.png"
              value={form.logoUrl ?? ''}
              onChange={(e) => set('logoUrl', e.target.value || null)}
            />
          </div>

          <h2 style={{ marginTop: 20 }}>Copy</h2>
          <div className="field">
            <label htmlFor="greeting">Greeting (chat header title)</label>
            <input
              id="greeting"
              maxLength={500}
              placeholder="Chat with us"
              value={form.greeting ?? ''}
              onChange={(e) => set('greeting', e.target.value || null)}
            />
          </div>
          <div className="field">
            <label htmlFor="offline">Offline message</label>
            <input
              id="offline"
              maxLength={500}
              placeholder="We're away — leave a message!"
              value={form.offlineMessage ?? ''}
              onChange={(e) => set('offlineMessage', e.target.value || null)}
            />
          </div>

          <h2 style={{ marginTop: 20 }}>Security</h2>
          <div className="field">
            <label htmlFor="domains">Allowed domains (one per line, <code>*.example.com</code> supported)</label>
            <textarea
              id="domains"
              rows={4}
              placeholder={'example.com\n*.staging.example.com'}
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
            />
          </div>
          <p className="muted">
            When set, the widget only loads on these origins. Leave empty to allow anywhere.
          </p>

          <button className="btn" type="submit" disabled={busy} style={{ marginTop: 8 }}>
            {busy ? 'Saving…' : 'Save settings'}
          </button>
        </form>

        <div className="card">
          <h2>Live preview</h2>
          <div
            style={{
              position: 'relative',
              height: 280,
              background: '#f1f5f9',
              borderRadius: 10,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                position: 'absolute',
                bottom: 76,
                ...(form.position === 'left' ? { left: 16 } : { right: 16 }),
                width: 250,
                background: '#fff',
                borderRadius: 12,
                boxShadow: '0 10px 34px rgba(15,23,42,.22)',
                overflow: 'hidden',
                fontSize: 13,
              }}
            >
              <div
                style={{
                  background: form.color,
                  color: '#fff',
                  padding: '10px 12px',
                  fontWeight: 600,
                  display: 'flex',
                  justifyContent: 'space-between',
                }}
              >
                <span>{form.greeting ?? 'Chat with us'}</span>
                <span aria-hidden>×</span>
              </div>
              <div style={{ padding: 12, minHeight: 96, color: '#475569' }}>
                {form.offlineMessage && (
                  <div
                    style={{
                      background: '#fef3c7',
                      color: '#92400e',
                      padding: '6px 8px',
                      borderRadius: 8,
                    }}
                  >
                    {form.offlineMessage}
                  </div>
                )}
                <div
                  style={{
                    background: '#eef2ff',
                    padding: '8px 10px',
                    borderRadius: '10px 10px 10px 2px',
                    marginTop: 8,
                  }}
                >
                  Hi! How can we help today?
                </div>
              </div>
              <div style={{ borderTop: '1px solid #e2e8f0', padding: '8px 12px', color: '#94a3b8' }}>
                Type a message…
              </div>
            </div>
            <div
              style={{
                position: 'absolute',
                bottom: 16,
                ...(form.position === 'left' ? { left: 16 } : { right: 16 }),
                width: 48,
                height: 48,
                borderRadius: '50%',
                background: form.color,
                color: '#fff',
                display: 'grid',
                placeItems: 'center',
                boxShadow: '0 8px 18px rgba(15,23,42,.3)',
                fontSize: 20,
              }}
              aria-hidden
            >
              💬
            </div>
          </div>
          <p className="muted" style={{ marginBottom: 0, marginTop: 10 }}>
            Preview updates live as you edit — save to apply it to the real widget.
          </p>
        </div>
      </div>
    </>
  );
}
