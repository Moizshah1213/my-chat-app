export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export type Role = 'owner' | 'admin' | 'agent';
export type ConversationStatus = 'open' | 'pending' | 'closed';

export interface User {
  id: string;
  email: string;
  name: string;
  totpEnabled?: boolean;
}
export interface Session {
  accessToken: string;
  user: User;
  workspaceId: string;
  role: Role;
}
export interface Workspace {
  id: string;
  name: string;
  slug: string;
  plan: string;
}
export interface Conversation {
  id: string;
  visitorId: string | null;
  status: ConversationStatus;
  assignedTo: string | null;
  subject: string | null;
  createdAt: string;
  closedAt: string | null;
  lastMessageAt: string;
}
export interface Message {
  id: string;
  body: string;
  senderType: 'agent' | 'visitor';
  createdAt: string;
}
export interface Member {
  userId: string;
  role: Role;
  createdAt: string;
}
export interface ApiKeyView {
  id: string;
  name: string;
  publicKey: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export interface AuditEntry {
  id: number;
  actorId: string | null;
  action: string;
  target: string | null;
  ip: string | null;
  createdAt: string;
  meta: Record<string, unknown>;
}
export interface VisitorSummary {
  id: string;
  name: string | null;
  email: string | null;
  firstSeen: string;
  lastSeen: string;
  meta: Record<string, unknown>;
}
export interface VisitorDetail extends VisitorSummary {
  conversations: {
    id: string;
    status: ConversationStatus;
    subject: string | null;
    assignedTo: string | null;
    lastMessageAt: string;
    createdAt: string;
  }[];
}
export interface LoginSession {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}
export interface WidgetSettingsView {
  color: string;
  logoUrl: string | null;
  position: 'left' | 'right';
  greeting: string | null;
  offlineMessage: string | null;
  prechatFields: unknown[];
  workingHours: Record<string, unknown>;
  aiEnabled: boolean;
  aiInstructions: string | null;
  allowedDomains: string[];
  language: string;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const TOKEN_KEY = 'lc_access';
let accessToken: string | null = null;
if (typeof window !== 'undefined') {
  accessToken = window.localStorage.getItem(TOKEN_KEY);
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
  if (typeof window === 'undefined') return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Core fetch wrapper: Bearer token, credentialed (refresh cookie), auto
 *  refresh-then-retry once on 401, uniform ApiError on failure. */
async function request<T>(path: string, init: RequestInit = {}, retryOn401 = true): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;

  const res = await fetch(API_URL + path, { ...init, headers, credentials: 'include' });
  if (res.status === 401 && retryOn401 && accessToken) {
    if (await tryRefresh()) return request<T>(path, init, false);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string; details?: unknown };
    } | null;
    throw new ApiError(
      res.status,
      body?.error?.code ?? 'unknown',
      body?.error?.message ?? res.statusText,
      body?.error?.details,
    );
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function tryRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/v1/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { accessToken: string };
    setAccessToken(data.accessToken);
    return true;
  } catch {
    return false;
  }
}

/** Typed endpoint map — one place for every dashboard call. */
export const api = {
  // --- auth ---
  login: (email: string, password: string, totpCode?: string) =>
    request<Session | { requires2fa: true }>('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, totpCode }),
    }),
  signup: (input: { email: string; password: string; name: string; workspaceName: string }) =>
    request<Session>('/v1/auth/signup', { method: 'POST', body: JSON.stringify(input) }),
  refresh: () => request<Session>('/v1/auth/refresh', { method: 'POST' }),
  logout: () => request<unknown>('/v1/auth/logout', { method: 'POST' }),

  // --- workspace + team ---
  getWorkspace: () => request<Workspace>('/v1/workspace'),
  listMembers: () => request<Member[]>('/v1/members'),
  invite: (email: string, role: Role) =>
    request<{ invitationId: string; token: string }>('/v1/invitations', {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    }),
  updateRole: (userId: string, role: Role) =>
    request<{ ok: true }>(`/v1/members/${userId}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }),
  removeMember: (userId: string) =>
    request<{ ok: true }>(`/v1/members/${userId}`, { method: 'DELETE' }),

  // --- conversations ---
  listConversations: (params: {
    status?: ConversationStatus;
    assignee?: 'me' | 'unassigned' | 'any';
    cursor?: string;
    limit?: number;
  } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.assignee) q.set('assignee', params.assignee);
    if (params.cursor) q.set('cursor', params.cursor);
    if (params.limit) q.set('limit', String(params.limit));
    const qs = q.toString();
    return request<Page<Conversation>>(`/v1/conversations${qs ? `?${qs}` : ''}`);
  },
  getConversation: (id: string) => request<Conversation>(`/v1/conversations/${id}`),
  listMessages: (id: string, before?: string) =>
    request<Page<Message>>(
      `/v1/conversations/${id}/messages${before ? `?before=${encodeURIComponent(before)}` : ''}`,
    ),
  sendMessage: (id: string, body: string) =>
    request<Message>(`/v1/conversations/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),
  updateConversation: (
    id: string,
    patch: { status?: ConversationStatus; assignedTo?: string | null; subject?: string | null },
  ) =>
    request<Conversation>(`/v1/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  // --- api keys ---
  listApiKeys: () => request<ApiKeyView[]>('/v1/api-keys'),
  createApiKey: (name: string) =>
    request<ApiKeyView>('/v1/api-keys', { method: 'POST', body: JSON.stringify({ name }) }),
  revokeApiKey: (id: string) =>
    request<{ ok: true; revokedAt: string }>(`/v1/api-keys/${id}`, { method: 'DELETE' }),

  // --- widget settings ---
  getWidgetSettings: () => request<WidgetSettingsView>('/v1/widget/settings'),
  updateWidgetSettings: (patch: Partial<WidgetSettingsView>) =>
    request<WidgetSettingsView>('/v1/widget/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  // --- audit log ---
  listAuditLogs: (limit = 100) =>
    request<AuditEntry[]>(`/v1/audit-logs?limit=${limit}`),

  // --- visitors (blueprint §12) ---
  listVisitors: () => request<VisitorSummary[]>('/v1/visitors'),
  getVisitor: (id: string) => request<VisitorDetail>(`/v1/visitors/${id}`),

  // --- security: 2FA + sessions (blueprint §7.1/§12) ---
  setup2fa: () =>
    request<{ secret: string; otpauthUrl: string }>('/v1/auth/2fa/setup', { method: 'POST' }),
  enable2fa: (code: string) =>
    request<{ recoveryCodes: string[] }>('/v1/auth/2fa/verify', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  disable2fa: (password: string, code: string) =>
    request<{ ok: true }>('/v1/auth/2fa/disable', {
      method: 'POST',
      body: JSON.stringify({ password, code }),
    }),
  listSessions: () => request<LoginSession[]>('/v1/auth/sessions'),
  revokeSession: (id: string) =>
    request<{ ok: true }>(`/v1/auth/sessions/${id}`, { method: 'DELETE' }),
  logoutAll: () => request<{ revoked: number }>('/v1/auth/logout-all', { method: 'POST' }),

  /** "Verify installation": resolve the PUBLIC settings endpoint with this key.
   *  No auth — mirrors exactly what an embedded widget does on page load. */
  checkWidgetKey: async (
    publicKey: string,
  ): Promise<{ ok: boolean; status: number; detail: string }> => {
    const res = await fetch(
      `${API_URL}/widget/v1/settings?key=${encodeURIComponent(publicKey)}`,
      { headers: { accept: 'application/json' } },
    );
    if (res.ok) {
      return { ok: true, status: res.status, detail: 'Key resolves and serves widget settings.' };
    }
    if (res.status === 403) {
      return {
        ok: false,
        status: res.status,
        detail:
          'Key is valid, but this origin is not in the allowed-domains list (expected until you add your site domain in Widget Settings).',
      };
    }
    return {
      ok: false,
      status: res.status,
      detail: `Key rejected (${res.status}) — unknown, revoked, or malformed.`,
    };
  },
};
