'use client';

import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { BRAND } from '@/config/brand';

export default function TwoFactorSetupModal() {
  const { markTwoFactorEnabled, signOut, skipTwoFactorForSession } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const modalRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const dialog = modalRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), summary, a[href]',
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    const initialFocus = setup
      ? modalRef.current?.querySelector<HTMLElement>('#authenticator-code')
      : modalRef.current?.querySelector<HTMLElement>('button:not([disabled])');
    initialFocus?.focus();
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [setup, recoveryCodes]);

  async function beginSetup() {
    setError('');
    setBusy(true);
    try {
      setSetup(await api.setup2fa());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start authenticator setup.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetup(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await api.enable2fa(code.trim());
      setRecoveryCodes(result.recoveryCodes);
      setSetup(null);
      setCode('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That authenticator code was not accepted.');
    } finally {
      setBusy(false);
    }
  }

  async function onSkip() {
    setError('');
    setBusy(true);
    try {
      await skipTwoFactorForSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not skip setup for this session.');
    } finally {
      setBusy(false);
    }
  }

  async function onSignOut() {
    await signOut();
    window.location.replace('/login');
  }

  return (
    <div className="two-factor-modal-backdrop">
      <section
        ref={modalRef}
        className="two-factor-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="two-factor-title"
        aria-describedby="two-factor-description"
      >
        <div className="lg big brand-mark-logo">
          <img src={BRAND.mark} alt="" aria-hidden="true" />
        </div>
        <p className="security-eyebrow">ACCOUNT SECURITY</p>
        <h1 id="two-factor-title">
          {recoveryCodes ? 'Save your recovery codes' : 'Set up two-factor authentication'}
        </h1>
        {recoveryCodes ? (
          <>
            <p className="sub" id="two-factor-description">
              Two-factor authentication is enabled. Save these one-time codes somewhere secure; they will not be shown again.
            </p>
            <div className="security-setup-codes mono">
              {recoveryCodes.map((recoveryCode) => <code key={recoveryCode}>{recoveryCode}</code>)}
            </div>
            <button
              className="btn"
              type="button"
              onClick={markTwoFactorEnabled}
              style={{ width: '100%' }}
            >
              I saved the codes — continue
            </button>
          </>
        ) : setup ? (
          <>
            <p className="sub" id="two-factor-description">
              Scan this code in Google Authenticator or another TOTP app, then enter its 6-digit code.
            </p>
            <div className="totp-qr">
              <QRCodeSVG value={setup.otpauthUrl} size={192} level="M" includeMargin />
            </div>
            <details className="totp-manual">
              <summary>Set up manually</summary>
              <p className="muted">Enter this key in your authenticator app:</p>
              <code>{setup.secret}</code>
            </details>
            <form onSubmit={confirmSetup}>
              <div className="field">
                <label htmlFor="authenticator-code">Authenticator code</label>
                <input
                  id="authenticator-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  pattern="[0-9]{6}"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="6-digit code"
                  required
                />
              </div>
              <button className="btn" type="submit" disabled={busy || code.length !== 6} style={{ width: '100%' }}>
                {busy ? 'Checking code…' : 'Verify and secure account'}
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="sub" id="two-factor-description">
              Two-factor authentication is required for continued dashboard access. You can skip for this sign-in session, but setup will be required again after signing out.
            </p>
            <button className="btn" type="button" onClick={() => void beginSetup()} disabled={busy} style={{ width: '100%' }}>
              {busy ? 'Preparing setup…' : 'Set up authenticator'}
            </button>
          </>
        )}
        {error && <div className="alert error" role="alert">{error}</div>}
        {!recoveryCodes && (
          <button className="auth-alt auth-back-button" type="button" onClick={() => void onSkip()} disabled={busy}>
            Skip for now
          </button>
        )}
        <button className="auth-alt auth-back-button two-factor-signout" type="button" onClick={() => void onSignOut()} disabled={busy}>
          Sign out
        </button>
      </section>
    </div>
  );
}
