'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type WidgetSettingsView } from '@/lib/api';

const EMPTY: WidgetSettingsView = {
  color: '#e8562b',
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
    <div className="page split">
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
          <div className="wp">
            <div className="wb" style={{ bottom: 76, ...(form.position === 'left' ? { left: 16 } : { right: 16 }) }}>
              <header style={{ background: form.color }}>
                <span>{form.greeting ?? 'Chat with us'}</span>
                <span aria-hidden>×</span>
              </header>
              <div className="wbody">
                {form.offlineMessage && <div className="wwarn">{form.offlineMessage}</div>}
                <div className="wbub">Hi! How can we help today?</div>
              </div>
              <footer>Type a message…</footer>
            </div>
            <div className="wfab" style={{ background: form.color, ...(form.position === 'left' ? { left: 16 } : { right: 16 }) }} aria-hidden>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              </svg>
            </div>
          </div>
          <p className="muted" style={{ marginBottom: 0, marginTop: 10 }}>
            Preview updates live as you edit — save to apply it to the real widget.
          </p>
        </div>
      </div>
    );
}
