import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  varchar,
  index,
  uniqueIndex,
  serial,
} from 'drizzle-orm/pg-core';
import { citext } from './citext.js';

// Inferred row + insert types for consumers.
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type EmailToken = typeof emailTokens.$inferSelect;
export type InvationToken = typeof invitationTokens.$inferSelect;

/**
 * Global (NOT tenant-scoped) tables: users, workspaces, and auth-support tokens.
 * These are governed by normal grants + app logic, not RLS workspace policies.
 */

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  totpSecretEnc: text('totp_secret_enc'), // AES-256-GCM encrypted at rest
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  recoveryCodesHash: text('recovery_codes_hash'), // JSON array of argon2 hashes
  name: text('name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  failedLogins: integer('failed_logins').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
});

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: varchar('slug', { length: 63 }).notNull().unique(),
  plan: text('plan').notNull().default('free'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    familyId: uuid('family_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedBy: uuid('replaced_by'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    familyIdx: index('refresh_tokens_family_idx').on(t.familyId),
    hashIdx: uniqueIndex('refresh_tokens_hash_idx').on(t.tokenHash),
    userIdx: index('refresh_tokens_user_idx').on(t.userId),
  }),
);

export const emailTokens = pgTable(
  'email_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // 'verify' | 'reset'
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hashIdx: uniqueIndex('email_tokens_hash_idx').on(t.tokenHash),
    userIdx: index('email_tokens_user_idx').on(t.userId),
  }),
);


// ---------------------------------------------------------------------------
// Tenant-scoped (all carry workspace_id NOT NULL + RLS in 0003_rls.sql)
// ---------------------------------------------------------------------------

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // owner | admin | agent
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    wsUserUnique: uniqueIndex('memberships_ws_user_unique').on(t.workspaceId, t.userId),
    userIdx: index('memberships_user_idx').on(t.userId),
    wsIdx: index('memberships_ws_idx').on(t.workspaceId),
  }),
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: citext('email').notNull(),
    role: text('role').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hashIdx: uniqueIndex('invitations_hash_idx').on(t.tokenHash),
    wsIdx: index('invitations_ws_idx').on(t.workspaceId),
  }),
);

/**
 * Global (NOT tenant-scoped) pointer from an opaque invitation token to its
 * invitation + workspace. Needed because `invitations` itself is RLS-protected:
 * the public accept endpoint must resolve the token before any tenant context
 * exists. Deleted when the invitation is consumed (single use).
 */
export const invitationTokens = pgTable('invitation_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  invitationId: uuid('invitation_id')
    .notNull()
    .references(() => invitations.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const widgetSettings = pgTable('widget_settings', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  color: text('color').notNull().default('#4f46e5'),
  logoUrl: text('logo_url'),
  position: text('position').notNull().default('right'),
  greeting: text('greeting'),
  offlineMessage: text('offline_message'),
  prechatFields: jsonb('prechat_fields').notNull().default([]),
  workingHours: jsonb('working_hours').notNull().default({}),
  aiEnabled: boolean('ai_enabled').notNull().default(false),
  aiInstructions: text('ai_instructions'),
  allowedDomains: text('allowed_domains').array().notNull().default([]),
  language: text('language').notNull().default('en'),
});

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    publicKey: text('public_key').notNull(),
    secretHash: text('secret_hash'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    publicKeyUnique: uniqueIndex('api_keys_public_key_unique').on(t.publicKey),
    wsIdx: index('api_keys_ws_idx').on(t.workspaceId),
  }),
);

export const visitors = pgTable(
  'visitors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    anonId: text('anon_id').notNull(),
    name: text('name'),
    email: citext('email'),
    ipHash: text('ip_hash'),
    country: text('country'),
    userAgent: text('user_agent'),
    firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
    meta: jsonb('meta').notNull().default({}),
  },
  (t) => ({
    wsAnonUnique: uniqueIndex('visitors_ws_anon_unique').on(t.workspaceId, t.anonId),
    wsIdx: index('visitors_ws_idx').on(t.workspaceId),
  }),
);


export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    visitorId: uuid('visitor_id'),
    status: text('status').notNull().default('open'), // open | pending | closed
    assignedTo: uuid('assigned_to'),
    subject: text('subject'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    wsStatusLastIdx: index('conversations_ws_status_last_idx').on(
      t.workspaceId,
      t.status,
      t.lastMessageAt,
    ),
    wsIdx: index('conversations_ws_idx').on(t.workspaceId),
  }),
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderType: text('sender_type').notNull(), // visitor | agent | ai | system
    senderId: uuid('sender_id'),
    body: text('body').notNull(),
    bodyType: text('body_type').notNull().default('text'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    idempotencyKey: text('idempotency_key'),
  },
  (t) => ({
    wsConvCreatedIdx: index('messages_ws_conv_created_idx').on(
      t.workspaceId,
      t.conversationId,
      t.createdAt,
    ),
    wsIdx: index('messages_ws_idx').on(t.workspaceId),
    idemIdx: uniqueIndex('messages_ws_idem_unique').on(t.workspaceId, t.idempotencyKey),
  }),
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: serial('id').primaryKey(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    target: text('target'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    meta: jsonb('meta').notNull().default({}),
  },
  (t) => ({
    wsIdx: index('audit_logs_ws_idx').on(t.workspaceId),
  }),
);

