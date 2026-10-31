'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import AuthLayout from '@/components/auth-layout';

export default function VerifyEmailPage() {
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const startedToken = useRef('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const verificationToken = params.get('token') ?? '';
    setToken(verificationToken);
    setEmail(params.get('email') ?? '');
    if (!verificationToken || startedToken.current === verificationToken) return;
    startedToken.current = verificationToken;
    setBusy(true);
    void api.verifyEmail(verificationToken)
      .then(() => {
        setVerified(true);
        setNotice('Your email is verified. You can now sign in to your workspace.');
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'This verification link is invalid or expired.');
      })
      .finally(() => setBusy(false));
  }, []);

  async function onVerify() {
    setError('');
    setBusy(true);
    try {
      await api.verifyEmail(token);
      setVerified(true);
      setNotice('Your email is verified. You can now sign in to your workspace.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This verification link is invalid or expired.');
    } finally {
      setBusy(false);
    }
  }

  async function onResend(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await api.resendVerification(email.trim());
      setNotice('If this account still needs verification, a fresh link has been sent.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resend the verification email.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <section className="auth-card">
        <h1>{verified ? 'Email verified' : 'Verify your email'}</h1>
        {verified ? (
          <>
            <p className="sub">{notice}</p>
            <Link className="btn" href="/login?emailVerified=1">Continue to sign in</Link>
          </>
        ) : (
          <>
            <p className="sub">
              {busy && token
                ? 'Confirming your email address…'
                : token
                  ? 'This confirmation link could not be verified. You can request a fresh link below.'
                  : 'Open the confirmation link sent to your email. If you cannot find it, request another link below.'}
            </p>
            {error && <div className="alert error" role="alert">{error}</div>}
            {notice && <div className="alert" role="status">{notice}</div>}
            {token && error && (
              <button className="btn s" type="button" onClick={() => void onVerify()} disabled={busy} style={{ width: '100%' }}>
                {busy ? 'Verifying…' : 'Try this link again'}
              </button>
            )}
            {(!token || error) && (
              <form onSubmit={onResend}>
                <div className="field">
                  <label htmlFor="verify-email-address">Email address</label>
                  <input
                    id="verify-email-address"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </div>
                <button className="btn s" type="submit" disabled={busy} style={{ width: '100%' }}>
                  {busy ? 'Sending…' : 'Resend verification link'}
                </button>
              </form>
            )}
            <p className="auth-alt"><Link href="/login">Back to sign in</Link></p>
          </>
        )}
      </section>
    </AuthLayout>
  );
}
