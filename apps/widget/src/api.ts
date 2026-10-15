import type { LiveChatUser, VisitorInitResult, WidgetSettings } from './types.js';

/** GET /widget/v1/settings?key=pk_… — public bootstrap config. */
export async function fetchSettings(apiUrl: string, publicKey: string): Promise<WidgetSettings> {
  const res = await fetch(`${apiUrl}/widget/v1/settings?key=${encodeURIComponent(publicKey)}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`settings fetch failed (${res.status})`);
  return (await res.json()) as WidgetSettings;
}

/** POST /widget/v1/visitor_init — find-or-create visitor + conversation, mint token. */
export async function visitorInit(
  apiUrl: string,
  publicKey: string,
  anonymousId: string,
  user?: LiveChatUser,
  attributes?: Record<string, unknown>,
): Promise<VisitorInitResult> {
  const res = await fetch(`${apiUrl}/widget/v1/visitor_init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      publicKey,
      anonymousId,
      name: user?.name,
      email: user?.email,
      page: typeof location !== 'undefined' ? location.href : undefined,
      ...(attributes && Object.keys(attributes).length > 0 ? { attributes } : {}),
    }),
  });
  if (!res.ok) throw new Error(`visitor_init failed (${res.status})`);
  return (await res.json()) as VisitorInitResult;
}
