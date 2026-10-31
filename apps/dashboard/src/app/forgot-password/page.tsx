'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import AuthLayout from '@/components/auth-layout';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.forgotPassword(email.trim());
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not request a password reset.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <form className="auth-card" onSubmit={onSubmit}>
        <h1>Forgot password?</h1>
        {submitted ? (
          <>
            <p className="sub" role="status">
              If an account exists for this email, a secure password reset link has been sent. Check your inbox shortly.
            </p>
            <Link className="btn" href="/login">Back to sign in</Link>
          </>
        ) : (
          <>
            <p className="sub">Enter your account email and we’ll send a secure reset link.</p>
            {error && <div className="alert error" role="alert">{error}</div>}
            <div className="field">
              <label htmlFor="reset-email">Email</label>
              <input
                id="reset-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
            <p className="auth-alt"><Link href="/login">Back to sign in</Link></p>
          </>
        )}
      </form>
    </AuthLayout>
  );
}
