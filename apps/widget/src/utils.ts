import type { WidgetSettings } from './types.js';

/** RFC4122 v4 (crypto.randomUUID with a Math.random fallback for old browsers). */
export function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function storage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode — widget still works for this session */
  }
}

/** Working-hours shape: { days: { mon: ['09:00','17:00'], … } }. Missing days
 *  entry = closed that day; no `days` key = hours not configured (always open). */
export function isOffline(workingHours: WidgetSettings['workingHours']): boolean {
  const days = (workingHours as { days?: Record<string, [string, string]> } | undefined)?.days;
  if (!days) return false;
  const now = new Date();
  const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const today = names[now.getDay()];
  const range = today ? days[today] : undefined;
  if (!range || !range[0] || !range[1]) return true;
  const mins = now.getHours() * 60 + now.getMinutes();
  const toMins = (hhmm: string) => {
    const [h, m] = hhmm.split(':');
    return (Number(h) || 0) * 60 + (Number(m) || 0);
  };
  return mins < toMins(range[0]) || mins >= toMins(range[1]);
}
