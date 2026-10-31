'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { api, ApiError, setTokens } from '@/lib/api';
import type { Session } from '@/lib/api';
import AuthLayout from '@/components/auth-layout';
import { Eye, EyeOff } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import GoogleSignInButton from '@/components/google-sign-in-button';

type QrPollResult =
  | { status: 'pending' | 'expired' | 'consumed' }
  | ({ status: 'approved' } & Session);

export default function LoginPage() {
  const { signIn, signInWithGoogle, completeTwoFactorLogin, acceptQrLogin } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [needs2fa, setNeeds2fa] = useState(false);
  const [tempToken, setTempToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [passwordReset, setPasswordReset] = useState(false);
  const [verificationRequired, setVerificationRequired] = useState(false);
  const [verificationNotice, setVerificationNotice] = useState('');
  const [qrMode, setQrMode] = useState(false);

  const onQrApproved = useCallback((result: Extract<QrPollResult, { status: 'approved' }>) => {
    const { status: _status, ...session } = result;
    setTokens(session.accessToken, session.refreshToken);
    acceptQrLogin(session);
    const requestedPath = new URLSearchParams(window.location.search).get('next');
    router.replace(requestedPath?.startsWith('/') && !requestedPath.startsWith('//') ? requestedPath : '/overview');
  }, [acceptQrLogin, router]);

  useEffect(() => {
    setPasswordReset(new URLSearchParams(window.location.search).get('passwordReset') === '1');
    setVerificationNotice(new URLSearchParams(window.location.search).get('emailVerified') === '1'
      ? 'Email verified. You can now sign in.'
      : '');
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setVerificationNotice('');
    setVerificationRequired(false);
    setBusy(true);
    try {
      if (needs2fa) {
        await completeTwoFactorLogin(tempToken, totpCode.trim());
      } else {
        const result = await signIn(email, password);
        if (result && 'requires2fa' in result && result.requires2fa) {
          setTempToken(result.tempToken);
          setNeeds2fa(true);
          setError('');
          return;
        }

        if (result && 'requires2faSetup' in result && result.requires2faSetup) {
          const requestedPath = new URLSearchParams(window.location.search).get('next');
          router.replace(requestedPath?.startsWith('/') && !requestedPath.startsWith('//') ? requestedPath : '/overview');
          return;
        }
      }
      const requestedPath = new URLSearchParams(window.location.search).get('next');
      router.replace(requestedPath?.startsWith('/') && !requestedPath.startsWith('//') ? requestedPath : '/overview');
    } catch (err) {
      if (needs2fa && err instanceof ApiError) setTotpCode('');
      if (err instanceof ApiError && err.status === 403 && err.message.toLowerCase().includes('verify your email')) {
        setVerificationRequired(true);
      }
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }

  }

  const onGoogleCredential = useCallback(async (credential: string) => {
    setError('');
    setBusy(true);
    try {
      const result = await signInWithGoogle(credential);
      if (result && 'requires2fa' in result && result.requires2fa) {
        setTempToken(result.tempToken);
        setNeeds2fa(true);
        return;
      }
      const requestedPath = new URLSearchParams(window.location.search).get('next');
      router.replace(requestedPath?.startsWith('/') && !requestedPath.startsWith('//') ? requestedPath : '/overview');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed');
    } finally {
      setBusy(false);
    }
  }, [router, signInWithGoogle]);

  async function onResendVerification() {
    setError('');
    setVerificationNotice('');
    setBusy(true);
    try {
      await api.resendVerification(email.trim());
      setVerificationNotice('If this account still needs verification, a new link has been sent.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resend the verification email.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      {qrMode ? (
        <QrLoginCard onBack={() => setQrMode(false)} onApproved={onQrApproved} />
      ) : <form className="auth-card" onSubmit={onSubmit}>
        <h1>Sign in</h1>
        <p className="sub">Welcome back to your live chat dashboard.</p>
        {passwordReset && <div className="alert success" role="status">Password reset successfully. Sign in with your new password.</div>}
        {error && <div className="alert error" role="alert">{error}</div>}
        {verificationNotice && <div className="alert" role="status">{verificationNotice}</div>}
        {!needs2fa && <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>}
        {!needs2fa && <div className="field">
          <label htmlFor="password">Password</label>
          <div className="auth-password-input">
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              className="auth-password-toggle"
              type="button"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              onClick={() => setShowPassword((visible) => !visible)}
            >
              {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
        </div>}
        {needs2fa && (
          <div className="field">
            <label htmlFor="totp">Two-factor code</label>
            <input
              id="totp"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={20}
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              placeholder="6-digit code or recovery code"
              required
            />
            <p className="muted small">Enter your Google Authenticator code or a recovery code.</p>
          </div>
        )}
        <button className="btn" style={{ width: '100%' }} disabled={busy} type="submit">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {!needs2fa && (
          <>
            <div className="auth-divider"><span>or continue with</span></div>
            <GoogleSignInButton
              disabled={busy}
              onCredential={onGoogleCredential}
              onError={setError}
            />
          </>
        )}
        {!needs2fa && <p className="auth-alt"><Link href="/forgot-password">Forgot password?</Link></p>}
        {!needs2fa && (
          <button className="auth-alt auth-back-button" type="button" onClick={() => setQrMode(true)}>
            Sign in with the mobile app
          </button>
        )}
        {verificationRequired && (
          <button className="auth-alt auth-back-button" type="button" onClick={() => void onResendVerification()} disabled={busy || !email.trim()}>
            {busy ? 'Sending…' : 'Resend verification email'}
          </button>
        )}
        {needs2fa && (
          <button className="auth-alt auth-back-button" type="button" onClick={() => {
            setNeeds2fa(false);
            setTempToken('');
            setTotpCode('');
            setError('');
          }}>
            Back to sign in
          </button>
        )}
        <p className="auth-alt">
          No account? <Link href="/signup">Create one</Link>
        </p>
      </form>
      }
    </AuthLayout>
  );
}

function QrLoginCard({
  onBack,
  onApproved,
}: {
  onBack: () => void;
  onApproved: (result: Extract<QrPollResult, { status: 'approved' }>) => void;
}) {
  const [challenge, setChallenge] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [restartKey, setRestartKey] = useState(0);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let polling = false;
    setLoading(true);
    setError('');
    setChallenge('');

    async function start() {
      try {
        const bytes = new Uint8Array(32);
        window.crypto.getRandomValues(bytes);
        const pollToken = btoa(String.fromCharCode(...bytes))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
        const result = await api.startQrLogin(pollToken);
        if (!active) return;
        setChallenge(JSON.stringify({
          type: 'qonvilo.dashboard-login',
          challengeToken: result.challengeToken,
        }));
        setLoading(false);
        timer = window.setInterval(async () => {
          if (polling) return;
          polling = true;
          try {
            const status = await api.pollQrLogin(result.challengeToken, pollToken) as QrPollResult;
            if (!active) return;
            if (status.status === 'approved') {
              if (timer !== undefined) window.clearInterval(timer);
              onApproved(status);
            } else if (status.status === 'expired' || status.status === 'consumed') {
              if (timer !== undefined) window.clearInterval(timer);
              setRestartKey((value) => value + 1);
            }
          } catch (reason) {
            if (active) setError(reason instanceof Error ? reason.message : 'Could not check the sign-in request.');
          } finally {
            polling = false;
          }
        }, 2500);
      } catch (reason) {
        if (active) {
          setError(reason instanceof Error ? reason.message : 'Could not create a QR sign-in request.');
          setLoading(false);
        }
      }
    }

    void start();
    return () => {
      active = false;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [restartKey, onApproved]);

  return (
    <div className="auth-card qr-login-card">
      <h1>Sign in with your phone</h1>
      <p className="sub">Open Qonvilo Mobile, scan this code, and approve the dashboard sign-in.</p>
      {error ? <div className="alert error" role="alert">{error}</div> : null}
      {loading ? (
        <div className="qr-login-loading" role="status">Creating a secure sign-in request…</div>
      ) : challenge ? (
        <div className="qr-login-code">
          <QRCodeSVG value={challenge} size={216} includeMargin />
        </div>
      ) : null}
      <p className="qr-login-hint">The code expires in 3 minutes and refreshes automatically.</p>
      <button className="auth-alt auth-back-button" type="button" onClick={onBack}>
        Use email and password instead
      </button>
    </div>
  );
}
