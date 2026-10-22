'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { BRAND } from '@/config/brand';

export default function SignupPage() {
  const { signUp } = useAuth();
  const router = useRouter();
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    workspaceName: '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await signUp(form);
      router.replace('/overview');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign up failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={onSubmit}>
        <div className="lg big">{BRAND.product.charAt(0)}</div>
        <h1>Create your workspace</h1>
        <p className="sub">One line of code adds live chat to your site.</p>
        {error && <div className="alert error">{error}</div>}
        <div className="field">
          <label htmlFor="name">Your name</label>
          <input id="name" required value={form.name} onChange={set('name')} />
        </div>
        <div className="field">
          <label htmlFor="email">Work email</label>
          <input id="email" type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
            value={form.password}
            onChange={set('password')}
          />
        </div>
        <div className="field">
          <label htmlFor="workspace">Workspace name</label>
          <input id="workspace" required value={form.workspaceName} onChange={set('workspaceName')} />
        </div>
        <button className="btn" style={{ width: '100%' }} disabled={busy} type="submit">
          {busy ? 'Creating…' : 'Create workspace'}
        </button>
        <p className="auth-alt">
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
