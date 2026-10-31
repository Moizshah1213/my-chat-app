'use client';

import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { api, API_URL } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function ProfilePage() {
  const { updateUser } = useAuth();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [avatarPreview, setAvatarPreview] = useState('');
  const [currentEmail, setCurrentEmail] = useState('');
  const [email, setEmail] = useState('');
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [emailPassword, setEmailPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    api.getProfile().then((profile) => {
      if (!active) return;
      const parts = (profile.name ?? '').trim().split(/\s+/).filter(Boolean);
      setFirstName(parts.shift() ?? '');
      setLastName(parts.join(' '));
      setPhone(profile.phone ?? '');
      setAvatarUrl(profile.avatarUrl ?? '');
      setAvatarPreview(profile.avatarUrl ?? '');
      setCurrentEmail(profile.email);
      setPendingEmail(profile.pendingEmail);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : 'Could not load your profile.');
    });
    return () => {
      active = false;
    };
  }, []);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const profile = await api.updateProfile({
        name: [firstName.trim(), lastName.trim()].filter(Boolean).join(' '),
        phone: phone.trim() || null,
      });
      setPendingEmail(profile.pendingEmail);
      updateUser({
        name: profile.name ?? '',
        phone: profile.phone,
        avatarUrl: profile.avatarUrl,
      });
      setNotice('Profile saved.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save your profile.');
    } finally {
      setBusy(false);
    }
  }

  async function uploadPhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError('');
    setNotice('');
    const mimeType = file.type;
    if (mimeType !== 'image/jpeg' && mimeType !== 'image/png' && mimeType !== 'image/webp') {
      setError('Choose a JPEG, PNG, or WebP image.');
      return;
    }
    if (file.size > 1_000_000) {
      setError('Profile photos must be smaller than 1 MB.');
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Could not read the selected photo.'));
        reader.onload = () => typeof reader.result === 'string'
          ? resolve(reader.result)
          : reject(new Error('Could not read the selected photo.'));
        reader.readAsDataURL(file);
      });
      const imageData = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const { avatarUrl: uploadedUrl } = await api.uploadAvatar(mimeType, imageData);
      setAvatarUrl(uploadedUrl);
      setAvatarPreview(uploadedUrl);
      updateUser({ avatarUrl: uploadedUrl });
      setNotice('Profile photo updated.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not upload the selected photo.');
    } finally {
      setBusy(false);
    }
  }

  async function removePhoto() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.deleteAvatar();
      setAvatarUrl('');
      setAvatarPreview('');
      updateUser({ avatarUrl: null });
      setNotice('Profile photo removed.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not remove the profile photo.');
    } finally {
      setBusy(false);
    }
  }

  async function requestEmailChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.requestEmailChange(email, emailPassword);
      setPendingEmail(email.trim());
      setEmailPassword('');
      setNotice('Check your new email address to verify the change.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not request an email change.');
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');
    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setNotice('Password changed. Other active sessions have been signed out.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not change your password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert success">{notice}</div>}

      <div className="profile-primary-grid">
      <form className="card security-card profile-details-card" onSubmit={(event) => void saveProfile(event)}>
        <div className="profile-details-heading">
          <div>
            <h2>Personal details</h2>
            <p className="muted">Update the details shown to your team.</p>
          </div>
        </div>
        <div className="profile-photo-picker">
          <span className="av profile-photo-preview">
            {avatarPreview
              ? <img src={avatarPreview.startsWith('/') ? `${API_URL}${avatarPreview}` : avatarPreview} alt="" />
              : `${firstName.slice(0, 1)}${lastName.slice(0, 1)}`.trim() || '?'}
          </span>
          <div className="profile-photo-copy">
            <div className="profile-photo-actions">
              <label className="btn s profile-photo-button">
                {busy ? 'Uploading…' : 'Choose photo'}
                <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void uploadPhoto(event)} disabled={busy} />
              </label>
              {avatarUrl && <button className="btn s" type="button" onClick={() => void removePhoto()} disabled={busy}>Remove</button>}
            </div>
            <span className="muted small">JPEG, PNG or WebP · max 1 MB</span>
          </div>
        </div>
        <div className="profile-details-grid">
          <div className="field">
            <label htmlFor="firstName">First name</label>
            <input id="firstName" autoComplete="given-name" value={firstName} onChange={(event) => setFirstName(event.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="lastName">Last name</label>
            <input id="lastName" autoComplete="family-name" value={lastName} onChange={(event) => setLastName(event.target.value)} />
          </div>
          <div className="field profile-phone-field">
            <label htmlFor="phone">Phone number</label>
            <input id="phone" type="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} />
          </div>
        </div>
        <div className="profile-details-footer">
          <button className="btn" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>
        </div>
      </form>

      <form className="card security-card" onSubmit={(event) => void requestEmailChange(event)}>
        <h2>Email address</h2>
        <p className="muted">A verification link will be sent to the new address before it is applied.</p>
        <p className="muted">Current email · {currentEmail || 'Loading…'}</p>
        <div className="field">
          <label htmlFor="profileEmail">New email address</label>
          <input id="profileEmail" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="emailPassword">Current password</label>
          <input id="emailPassword" type="password" autoComplete="current-password" value={emailPassword} onChange={(event) => setEmailPassword(event.target.value)} required />
        </div>
        {pendingEmail && <p className="muted">Verification pending for {pendingEmail}.</p>}
        <button className="btn s" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send verification email'}</button>
      </form>
      </div>

      <form className="card security-card" onSubmit={(event) => void changePassword(event)}>
        <h2>Change password</h2>
        <div className="field">
          <label htmlFor="currentPassword">Current password</label>
          <input id="currentPassword" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required />
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="newPassword">New password</label>
            <input id="newPassword" type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="confirmPassword">Confirm new password</label>
            <input id="confirmPassword" type="password" autoComplete="new-password" minLength={12} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required />
          </div>
        </div>
        <button className="btn s" type="submit" disabled={busy}>{busy ? 'Changing…' : 'Change password'}</button>
      </form>
    </div>
  );
}
