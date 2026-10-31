export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  (process.env.NODE_ENV === 'development'
    ? 'http://localhost:4000'
    : 'https://api.130.210.12.123.sslip.io');

export type Role = 'owner' | 'admin' | 'agent';
export type ConversationStatus = 'open' | 'pending' | 'closed';

export interface User {
  id: string;
  email: string;
  name: string;
  phone?: string | null;
  avatarUrl?: string | null;
  totpEnabled?: boolean;
}
export interface Session {
  accessToken: string;
  refreshToken?: string;
  twoFactorSkipped?: boolean;
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
export interface ConversationVisitor {
  id: string | null;
  name: string | null;
  email: string | null;
}
export interface Conversation {
  id: string;
  /** Derived in this client from `visitor.id` (the API returns a nested `visitor` object). */
  visitorId: string | null;
  visitor?: ConversationVisitor;
  status: ConversationStatus;
  assignedTo: string | null;
  subject: string | null;
  createdAt: string;
  closedAt: string | null;
  lastMessageAt: string;
}
export interface Message {
  id: string;
  conversationId?: string;
  body: string;
  bodyType?: 'text';
  senderType: 'agent' | 'visitor' | 'ai' | 'system';
  senderId?: string;
  createdAt: string;
  editedAt?: string | null;
}

/** The API nests the visitor as `visitor: {id,name,email}`; the UI reads `visitorId`.
 *  PATCH responses return `visitor` with all-null fields — treat that as "unknown". */
export function normalizeConversation(raw: Conversation): Conversation {
  const v = raw.visitor;
  const hasVisitor = Boolean(v && (v.id || v.name || v.email));
  return {
    ...raw,
    visitor: hasVisitor ? v : undefined,
    visitorId: raw.visitorId ?? (hasVisitor ? (v?.id ?? null) : null),
  };
}
export interface Member {
  userId: string;
  name: string | null;
  email: string;
  role: Role;
  createdAt: string;
}
export interface Invitation {
  id: string;
  email: string;
  role: Role;
  status: 'pending' | 'expired' | 'accepted';
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
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
  location: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}
export interface WidgetSettingsView {
  color: string;
  theme: 'dark' | 'light';
  backgroundColor: string;
  backgroundGradient: boolean;
  backgroundGradientColor: string;
  buttonColor: string;
  agentBubbleColor: string;
  logoUrl: string | null;
  position: 'left' | 'right';
  greeting: string | null;
  offlineMessage: string | null;
  prechatFields: WidgetPrechatField[];
  prechatEnabled: boolean;
  workingHours: Record<string, unknown>;
  quickReplies: string[];
  aiEnabled: boolean;
  aiInstructions: string | null;
  allowedDomains: string[];
  language: string;
}
export interface WidgetPrechatField {
  name: string;
  label?: string;
  type?: 'text' | 'email' | 'tel';
  required?: boolean;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Email provider settings (returned to agent dashboard). */
export interface EmailSettingsView {
  provider: 'smtp' | 'resend' | 'sendgrid';
  host: string | null;
  port: number | null;
  user: string | null;
  fromEmail: string | null;
  fromName: string | null;
  verifiedAt: string | null;
}

/** Email provider settings input (agent saves). */
export interface EmailSettingsInput {
  provider?: 'smtp' | 'resend' | 'sendgrid';
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  fromEmail?: string | null;
  fromName?: string | null;
}

/** AI assistant settings (returned to agent dashboard). Key is never included. */
export interface AiSettingsView {
  mode: 'off' | 'suggest' | 'auto';
  provider: 'openai_compatible' | 'openai' | 'anthropic';
  baseUrl: string | null;
  model: string | null;
  apiKeyLast4: string | null;
  instructions: Record<string, string>;
  temperature: number;
  maxOutputTokens: number;
  monthlyTokenCap: number;
}

/** AI assistant settings input (agent saves). */
export interface AiSettingsInput {
  mode?: 'off' | 'suggest' | 'auto';
  provider?: 'openai_compatible' | 'openai' | 'anthropic';
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  instructions?: Record<string, string>;
  temperature?: number;
  maxOutputTokens?: number;
  monthlyTokenCap?: number;
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
const REFRESH_TOKEN_KEY = 'lc_refresh';

let accessToken: string | null = null;
let refreshToken: string | null = null;

if (typeof window !== 'undefined') {
  accessToken = window.localStorage.getItem(TOKEN_KEY);
  refreshToken = window.localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setTokens(access: string | null, refresh?: string | null): void {
  accessToken = access;
  if (refresh !== undefined) {
    refreshToken = refresh;
  }
  if (typeof window === 'undefined') return;

  if (access) window.localStorage.setItem(TOKEN_KEY, access);
  else window.localStorage.removeItem(TOKEN_KEY);

  if (refresh !== undefined) {
    if (refresh) window.localStorage.setItem(REFRESH_TOKEN_KEY, refresh);
    else window.localStorage.removeItem(REFRESH_TOKEN_KEY);
  }
}

export function setAccessToken(token: string | null): void {
  setTokens(token);
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getRefreshToken(): string | null {
  return refreshToken;
}

/** Core fetch wrapper: Bearer token, credentialed, auto
 *  refresh-then-retry once on 401, uniform ApiError on failure. */
async function request<T>(path: string, init: RequestInit = {}, retryOn401 = true): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;

  const res = await fetch(API_URL + path, { ...init, headers, credentials: 'include' });
  if (res.status === 401 && retryOn401 && (accessToken || refreshToken)) {
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

/** Single-flight refresh using body-borne refreshToken to bypass cross-domain cookie blocks. */
let refreshInFlight: Promise<Session> | null = null;

export function refreshSession(): Promise<Session> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const currentRefresh = getRefreshToken();
      const res = await fetch(`${API_URL}/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ refreshToken: currentRefresh }),
        credentials: 'include',
      });
      if (!res.ok) {
        setTokens(null, null);
        throw new ApiError(res.status, 'refresh_failed', 'Session expired');
      }
      const data = (await res.json()) as Session;
      setTokens(data.accessToken, data.refreshToken);
      return data;
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function tryRefresh(): Promise<boolean> {
  try {
    await refreshSession();
    return true;
  } catch {
    return false;
  }
}

/** Typed endpoint map — one place for every dashboard call. */
export const api = {
  // --- auth ---
  login: async (email: string, password: string, totpCode?: string) => {
    const res = await request<Session | { requires2fa: true; tempToken?: string }>('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, totpCode }),
    });
    if ('accessToken' in res && res.accessToken) {
      setTokens(res.accessToken, res.refreshToken);
    }
    return res;
  },
  googleLogin: async (idToken: string) => {
    const res = await request<Session | { requires2fa: true; tempToken?: string }>('/v1/auth/google', {
      method: 'POST',
      body: JSON.stringify({ idToken }),
    }, false);
    if ('accessToken' in res && res.accessToken) {
      setTokens(res.accessToken, res.refreshToken);
    }
    return res;
  },
  startQrLogin: (pollToken: string) =>
    request<{ challengeToken: string; expiresAt: string }>(
      '/v1/auth/qr/start',
      { method: 'POST', body: JSON.stringify({ pollToken }) },
      false,
    ),
  pollQrLogin: (challengeToken: string, pollToken: string) =>
    request<
      | { status: 'pending' | 'expired' | 'consumed' }
      | ({ status: 'approved' } & Session)
    >(
      '/v1/auth/qr/poll',
      { method: 'POST', body: JSON.stringify({ challengeToken, pollToken }) },
      false,
    ),
  completeTwoFactorLogin: (tempToken: string, code: string) =>
    request<Session>('/v1/auth/2fa/verify', {
      method: 'POST',
      body: JSON.stringify({ tempToken, code }),
    }).then((session) => {
      setTokens(session.accessToken, session.refreshToken);
      return session;
    }),
  forgotPassword: (email: string) =>
    request<{ ok: true }>('/v1/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  resetPassword: (token: string, password: string) =>
    request<{ ok: true }>('/v1/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    }),
  signup: (input: { email: string; password: string; name: string; workspaceName: string }) =>
    request<{ requiresEmailVerification: true; email: string }>('/v1/auth/signup', {
      method: 'POST',
      body: JSON.stringify(input)
    }),
  verifyEmail: (token: string) =>
    request<{ ok: true }>('/v1/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  resendVerification: (email: string) =>
    request<{ ok: true }>('/v1/auth/resend-verification', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  refresh: () => refreshSession(),
  logout: async () => {
    try {
      await request<unknown>('/v1/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: getRefreshToken() }),
      });
    } finally {
      setTokens(null, null);
    }
  },

  // --- workspace + team ---
  getWorkspace: () => request<Workspace>('/v1/workspace'),
  listMembers: () => request<Member[]>('/v1/members'),
  listInvitations: () => request<Invitation[]>('/v1/invitations'),
  invite: (email: string, role: Role) =>
    request<{ invitationId: string; token: string; inviteUrl: string }>('/v1/invitations', {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    }),
  cancelInvitation: (id: string) =>
    request<{ ok: true }>(`/v1/invitations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  previewInvitation: (token: string) =>
    request<{ email: string; role: Role; workspaceName: string; expiresAt: string }>(
      `/v1/invitations/${encodeURIComponent(token)}`,
      { method: 'GET' },
    ),
  acceptInvitation: (token: string, input: { name?: string; password?: string }) =>
    request<Session>('/v1/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token, ...input }),
    }).then((session) => {
      setTokens(session.accessToken, session.refreshToken);
      return session;
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
    return request<Page<Conversation>>(`/v1/conversations${qs ? `?${qs}` : ''}`).then((p) => ({
      ...p,
      items: p.items.map(normalizeConversation),
    }));
  },
  getConversation: (id: string) =>
    request<Conversation>(`/v1/conversations/${id}`).then(normalizeConversation),
  listMessages: (id: string, before?: string) =>
    request<Page<Message>>(
      `/v1/conversations/${id}/messages${before ? `?before=${encodeURIComponent(before)}` : ''}`,
    ),
  /** Pass the SAME idempotencyKey when retrying a failed send so it can't duplicate. */
  sendMessage: (id: string, body: string, idempotencyKey: string = crypto.randomUUID()) =>
    request<Message>(`/v1/conversations/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body, idempotencyKey }),
    }),
  updateConversation: (
    id: string,
    patch: { status?: ConversationStatus; assignedTo?: string | null; subject?: string | null },
  ) =>
    request<Conversation>(`/v1/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }).then(normalizeConversation),
  deleteConversation: (id: string) =>
    request<{ ok: true }>(`/v1/conversations/${id}`, { method: 'DELETE' }),
  getNotificationPreference: (id: string) =>
    request<{ paused: boolean }>(`/v1/conversations/${id}/notifications`),
  updateNotificationPreference: (id: string, paused: boolean) =>
    request<{ paused: boolean }>(`/v1/conversations/${id}/notifications`, {
      method: 'PATCH',
      body: JSON.stringify({ paused }),
    }),
  listNotificationPreferences: () =>
    request<{ conversationIds: string[] }>('/v1/conversations/notification-preferences'),
  editMessage: (id: string, messageId: string, body: string) =>
    request<Message>(`/v1/conversations/${id}/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    }),
  deleteMessage: (id: string, messageId: string) =>
    request<{ ok: true }>(`/v1/conversations/${id}/messages/${messageId}`, { method: 'DELETE' }),

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

  // --- visitors ---
  listVisitors: () => request<VisitorSummary[]>('/v1/visitors'),
  getVisitor: (id: string) => request<VisitorDetail>(`/v1/visitors/${id}`),
  updateVisitor: (id: string, patch: { name?: string; email?: string; displayName?: string; notes?: string; tags?: string[] }) =>
    request<VisitorDetail>(`/v1/visitors/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  // --- email settings ---
  getEmailSettings: () => request<EmailSettingsView>('/v1/email-settings'),
  updateEmailSettings: (patch: EmailSettingsInput) =>
    request<{ ok: true }>('/v1/email-settings', { method: 'PATCH', body: JSON.stringify(patch) }),

  // --- AI settings ---
  getAiSettings: () => request<AiSettingsView>('/v1/ai/settings'),
  updateAiSettings: (patch: AiSettingsInput) =>
    request<{ ok: true }>('/v1/ai/settings', { method: 'PATCH', body: JSON.stringify(patch) }),

  // --- security: 2FA + sessions ---
  getProfile: () => request<Pick<User, 'id' | 'email' | 'name' | 'phone' | 'avatarUrl'> & {
    pendingEmail: string | null;
  }>('/v1/auth/profile'),
  updateProfile: (input: { name: string; phone: string | null }) =>
    request<Pick<User, 'id' | 'email' | 'name' | 'phone' | 'avatarUrl'> & {
      pendingEmail: string | null;
    }>('/v1/auth/profile', { method: 'PATCH', body: JSON.stringify(input) }),
  uploadAvatar: (mimeType: 'image/jpeg' | 'image/png' | 'image/webp', imageData: string) =>
    request<{ avatarUrl: string }>('/v1/auth/profile/avatar', {
      method: 'POST',
      body: JSON.stringify({ mimeType, imageData }),
    }),
  deleteAvatar: () => request<{ avatarUrl: null }>('/v1/auth/profile/avatar', { method: 'DELETE' }),
  requestEmailChange: (email: string, password: string) =>
    request<{ ok: true; verificationRequired: true }>('/v1/auth/profile/email', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('/v1/auth/profile/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  setup2fa: () =>
    request<{ secret: string; otpauthUrl: string }>('/v1/auth/2fa/setup', { method: 'POST' }),
  skip2fa: () =>
    request<Session>('/v1/auth/2fa/skip', { method: 'POST', body: JSON.stringify({}) }),
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

  /** "Verify installation": resolve the PUBLIC settings endpoint with this key. */
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