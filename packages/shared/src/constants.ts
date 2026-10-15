/**
 * Shared constants for the live chat SaaS.
 * Product name is a placeholder; the real value comes from env PRODUCT_NAME.
 */

export const ROLES = ['owner', 'admin', 'agent'] as const;
export type Role = (typeof ROLES)[number];

/** Capability -> minimum role that may perform it. Deny by default. */
export const ROLE_CAPABILITIES = {
  'workspace:read': ['owner', 'admin', 'agent'],
  'workspace:update': ['owner', 'admin'],
  'workspace:delete': ['owner'],
  'billing:manage': ['owner'],
  'members:read': ['owner', 'admin'],
  'members:invite': ['owner', 'admin'],
  'members:update-role': ['owner'],
  'members:remove': ['owner', 'admin'],
  'apikeys:read': ['owner', 'admin'],
  'apikeys:manage': ['owner', 'admin'],
  'audit:read': ['owner', 'admin'],
  'conversations:read': ['owner', 'admin', 'agent'],
  'conversations:write': ['owner', 'admin', 'agent'],
  'settings:update': ['owner', 'admin'],
} as const satisfies Record<string, Role[]>;

export type Capability = keyof typeof ROLE_CAPABILITIES;

export function roleCan(role: Role, capability: Capability): boolean {
  const allowed: readonly Role[] = ROLE_CAPABILITIES[capability];
  return allowed.includes(role);
}

// Token lifetimes (seconds)
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 10-15 min per blueprint
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const EMAIL_VERIFY_TTL_SECONDS = 24 * 60 * 60;
export const PASSWORD_RESET_TTL_SECONDS = 30 * 60; // 30 min per blueprint
export const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const VISITOR_TOKEN_TTL_SECONDS = 24 * 60 * 60; // 1-24h

// Limits
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;
export const MESSAGE_MAX_LENGTH = 4000; // chars per chat message

// Error codes (consistent wire format)
export const ErrorCodes = {
  VALIDATION_FAILED: 'validation_failed',
  UNAUTHENTICATED: 'unauthenticated',
  INVALID_CREDENTIALS: 'invalid_credentials',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  RATE_LIMITED: 'rate_limited',
  TENANT_REQUIRED: 'tenant_required',
  INTERNAL: 'internal_error',
} as const;
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
