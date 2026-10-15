import { z } from 'zod';
import { MIN_PASSWORD_LENGTH, MAX_PAGE_SIZE, MESSAGE_MAX_LENGTH, ROLES } from './constants.js';

// Reject unknown fields by default (mass-assignment protection) — see §8.2.
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const emailSchema = z.string().email().max(254).toLowerCase().trim();

export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(256);

export const signupSchema = strict({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().min(1).max(120),
  workspaceName: z.string().min(1).max(120),
});

export const loginSchema = strict({
  email: emailSchema,
  password: z.string().min(1).max(256),
  // optional TOTP code when 2FA enabled — or a recovery code (xxxxx-xxxxx)
  totpCode: z
    .string()
    .min(6)
    .max(20)
    .regex(/^(\d{6}|[a-z0-9]{5}-[a-z0-9]{5})$/i, 'Expected a 6-digit code or a recovery code')
    .optional(),
});

export const verifyEmailSchema = strict({
  token: z.string().min(20).max(200),
});

export const forgotPasswordSchema = strict({ email: emailSchema });

export const resetPasswordSchema = strict({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

export const totpVerifySchema = strict({ code: z.string().regex(/^\d{6}$/) });

/** POST /v1/auth/2fa/disable — password + (TOTP or recovery) code to turn 2FA off. */
export const disable2faSchema = strict({
  password: z.string().min(1).max(256),
  code: z
    .string()
    .min(6)
    .max(20)
    .regex(/^(\d{6}|[a-z0-9]{5}-[a-z0-9]{5})$/i, 'Expected a 6-digit code or a recovery code'),
});

export const inviteSchema = strict({
  email: emailSchema,
  role: z.enum(ROLES),
});

/**
 * Public invitation-accept body: the token is the capability; name/password
 * are only required when the invitee has no account yet (enforced in the
 * service, since we can't know that before resolving the token).
 */
export const acceptInvitationSchema = strict({
  token: z.string().min(20).max(200),
  name: z.string().min(1).max(120).optional(),
  password: passwordSchema.optional(),
});

export const updateRoleSchema = strict({ role: z.enum(ROLES) });

// ---- Phase 2: widget visitors, conversations, messaging ---------------------

/**
 * POST /widget/v1/visitor_init body (public, from the embeddable widget).
 * anonymousId is a client-generated stable id (localStorage UUID); the server
 * hashes IPs, never stores raw IPs/user agents for visitors (blueprint §5).
 */
export const visitorInitSchema = strict({
  workspaceId: z.string().uuid().optional(),
  publicKey: z.string().min(8).max(64).optional(),
  anonymousId: z.string().min(8).max(64),
  name: z.string().min(1).max(120).optional(),
  email: emailSchema.optional(),
  page: z.string().max(2048).optional(),
  /** Custom visitor metadata from LiveChat.setAttributes(...) (blueprint §11):
   *  merged into visitors.meta server-side; scalar values only, capped. */
  attributes: z
    .record(
      z.string().min(1).max(64),
      z.union([z.string().max(500), z.number(), z.boolean()]),
    )
    .refine((v) => Object.keys(v).length <= 50, { message: 'Too many attributes (max 50)' })
    .optional(),
}).refine((v) => Boolean(v.workspaceId) !== Boolean(v.publicKey), {
  message: 'Provide exactly one of workspaceId or publicKey',
});

/** Conversation list query (agent inbox). Non-strict: query strings may carry
 *  client-side extras; known fields are validated, unknown ones ignored. */
export const listConversationsSchema = z.object({
  status: z.enum(['open', 'pending', 'closed']).optional(),
  assignee: z.enum(['me', 'unassigned', 'any']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
});

/** PATCH /v1/conversations/:id — assign / change status / set subject. */
export const updateConversationSchema = strict({
  status: z.enum(['open', 'pending', 'closed']).optional(),
  assignedTo: z.string().uuid().nullable().optional(),
  subject: z.string().min(1).max(200).nullable().optional(),
}).refine((v) => Object.values(v).some((x) => x !== undefined), {
  message: 'At least one field to update is required',
});

/** Message history query. `before` is an opaque cursor (older-than paging). */
export const listMessagesSchema = z.object({
  before: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
});

/** Send a message (agent REST / WS, and visitor WS). */
export const sendMessageSchema = strict({
  body: z.string().min(1).max(MESSAGE_MAX_LENGTH),
  idempotencyKey: z.string().min(1).max(64).optional(),
});

/** GET /v1/visitors — most-recently-active first, small fixed window. */
export const listVisitorsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** WS `message:send` payload: sendMessageSchema + the conversation target. */
export const wsMessageSendSchema = strict({
  conversationId: z.string().uuid(),
  body: z.string().min(1).max(MESSAGE_MAX_LENGTH),
  idempotencyKey: z.string().min(1).max(64).optional(),
});

/** WS `conversation:join` / `typing` target. */
export const conversationIdSchema = z.object({ conversationId: z.string().uuid() });

/** WS `typing` payload. */
export const wsTypingSchema = strict({
  conversationId: z.string().uuid(),
  typing: z.boolean(),
});

// ---- Phase 3: API keys + widget customization -------------------------------

/** POST /v1/api-keys — mint a new widget public key (pk_live_…). The key is
 *  public by design (it ships in embed code); scopes/secret keys (sk_…) come
 *  with the server-to-server API in a later phase. */
export const createApiKeySchema = strict({
  name: z.string().min(1).max(120),
});

/** PATCH /v1/widget/settings — widget customization (agent-managed). */
export const updateWidgetSettingsSchema = strict({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  logoUrl: z.string().url().max(2048).nullable().optional(),
  position: z.enum(['left', 'right']).optional(),
  greeting: z.string().max(500).nullable().optional(),
  offlineMessage: z.string().max(500).nullable().optional(),
  prechatFields: z.array(z.record(z.any())).max(20).optional(),
  workingHours: z.record(z.any()).optional(),
  allowedDomains: z.array(z.string().min(1).max(253)).max(50).optional(),
  language: z.string().min(2).max(10).optional(),
  aiEnabled: z.boolean().optional(),
}).refine((v) => Object.values(v).some((x) => x !== undefined), {
  message: 'At least one field to update is required',
});

/** GET /widget/v1/settings query — public widget key lookup. */
export const widgetSettingsQuerySchema = strict({
  key: z.string().min(8).max(64),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type InviteInput = z.infer<typeof inviteSchema>;
export type VisitorInitInput = z.infer<typeof visitorInitSchema>;
export type ListConversationsInput = z.infer<typeof listConversationsSchema>;
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;
export type ListMessagesInput = z.infer<typeof listMessagesSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type UpdateWidgetSettingsInput = z.infer<typeof updateWidgetSettingsSchema>;
export type WidgetSettingsQueryInput = z.infer<typeof widgetSettingsQuerySchema>;
