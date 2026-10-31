import type { AuditEntry } from './api';

const ACTION_LABELS: Record<string, string> = {
  'auth.signup': 'Created an account',
  'auth.login': 'Signed in',
  'auth.google_login': 'Signed in with Google',
  'auth.qr_login': 'Signed in with the mobile app',
  '2fa.enabled': 'Turned on two-factor authentication',
  '2fa.disabled': 'Turned off two-factor authentication',
  'sessions.revoked_all': 'Signed out other sessions',
  'members.invite': 'Invited a team member',
  'members.invitation-cancel': 'Cancelled a team invitation',
  'members.update-role': 'Changed a team member’s role',
  'members.remove': 'Removed a team member',
  'settings.update': 'Updated widget settings',
  'apikey.create': 'Created an API key',
  'apikey.revoke': 'Revoked an API key',
};

export function auditActionLabel(action: string): string {
  const knownLabel = ACTION_LABELS[action];
  if (knownLabel) return knownLabel;

  const words = action
    .replace(/[._-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return 'Updated workspace';
  return words[0]![0]!.toUpperCase() + words[0]!.slice(1) + (words.length > 1 ? ` ${words.slice(1).join(' ')}` : '');
}

export function auditDetails(entry: AuditEntry): string {
  const name = entry.meta.name;
  if (typeof name === 'string' && name.trim()) return `“${name.trim()}”`;
  if (entry.target && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.target)) return entry.target;
  return '—';
}
