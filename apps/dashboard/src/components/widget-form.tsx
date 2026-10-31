'use client';

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'lc-visitor-identity';

export interface VisitorIdentity {
  name: string;
  email: string;
}

interface WidgetFormProps {
  /** Fired when the visitor submits name + email (inject into visitor tracking). */
  onIdentify?: (identity: VisitorIdentity) => void;
  placeholderName?: string;
  placeholderEmail?: string;
}

/**
 * Pre-chat capture form: asks for visitor name + email before chat loads.
 * Values persist in localStorage (fallback) so they survive a reload and can
 * be injected into visitor tracking via `onIdentify`.
 */
export function WidgetForm({
  onIdentify,
  placeholderName = 'Your name',
  placeholderEmail = 'you@example.com',
}: WidgetFormProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'saved'>('idle');

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<VisitorIdentity>;
        if (parsed.name) setName(parsed.name);
        if (parsed.email) setEmail(parsed.email);
      }
    } catch {}
  }, []);

  const persist = useCallback((n: string, e: string) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: n, email: e }));
    } catch {}
  }, []);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName || !trimmedEmail) return;
    persist(trimmedName, trimmedEmail);
    setStatus('saved');
    onIdentify?.({ name: trimmedName, email: trimmedEmail });
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <h2>Start a chat</h2>
      <p className="muted" style={{ marginBottom: 12 }}>
        Enter your details so we know who you are.
      </p>
      <div className="field">
        <label htmlFor="widget-name">Name</label>
        <input
          id="widget-name"
          placeholder={placeholderName}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="widget-email">Email</label>
        <input
          id="widget-email"
          type="email"
          placeholder={placeholderEmail}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <button className="btn" type="submit" style={{ marginTop: 8 }}>
        {status === 'saved' ? 'Saved' : 'Start chat'}
      </button>
      <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
        Your details are stored locally in your browser.
      </p>
    </form>
  );
}
