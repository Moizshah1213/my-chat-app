import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { getDb, type TxDatabase } from './client.js';

/**
 * Tenant-scoped DB access (blueprint §5, layer 2 — application layer).
 *
 * Every tenant query runs inside a dedicated transaction that FIRST executes:
 *     SELECT set_config('app.workspace_id', $1, true);
 * `true` makes the setting LOCAL to this transaction/session, so it never leaks
 * to other requests reusing the connection from the pool. Because the whole
 * transaction uses one reserved connection, the setting holds for every query
 * until commit/rollback.
 *
 * Postgres RLS (layer 3) then enforces workspace_id isolation on top.
 *
 * The transaction-bound Drizzle instance is stored in AsyncLocalStorage so
 * service/repository code can call tx() without threading it through args.
 */

export interface TenantContext {
  workspaceId: string;
  db: TxDatabase;
}

const als = new AsyncLocalStorage<TenantContext>();

/**
 * Run `fn` inside a tenant-scoped transaction for the given workspace.
 * Commits on success, rolls back on error. Missing workspaceId => fail closed.
 */
export async function withTenant<T>(
  connectionString: string,
  workspaceId: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!workspaceId) {
    // Fail closed: refuse to run tenant code without a tenant context.
    throw new Error('withTenant: workspaceId is required (fail-closed)');
  }

  const db = getDb(connectionString);
  return db.transaction(async (txDb) => {
    // Transaction-local (is_local=true => auto-cleared at COMMIT/ROLLBACK, so it
    // can never leak to the next request that reuses this pooled connection).
    // Always set explicitly so a reused connection never carries a stale tenant.
    await txDb.execute(sql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`);
    return als.run({ workspaceId, db: txDb }, fn);
  });
}

/**
 * Run `fn` inside a plain transaction WITHOUT a tenant context.
 * Use ONLY for cross-tenant operations: auth (users table is global) and
 * workspace creation, where RLS policies on tenant tables must not apply.
 * Prefer withTenant for anything touching tenant-scoped tables.
 */
export async function withoutTenant<T>(
  connectionString: string,
  fn: () => Promise<T>,
): Promise<T> {
  const db = getDb(connectionString);
  return db.transaction(async (txDb) => {
    // Explicitly clear to NULL (txn-local). current_setting then returns NULL
    // => RLS policies on tenant tables match nothing (fail closed). Setting it
    // explicitly (rather than RESET) avoids the custom-GUC reset_val = '' trap.
    await txDb.execute(sql`SELECT set_config('app.workspace_id', NULL, true)`);
    return als.run({ workspaceId: '', db: txDb }, fn);
  });
}

/** Get the current tenant-scoped transaction Drizzle instance. Throws if unset. */
export function tx(): TxDatabase {
  const ctx = als.getStore();
  if (!ctx) {
    throw new Error('No tenant transaction in context. Wrap the call in withTenant().');
  }
  return ctx.db;
}

/** The transaction-bound Drizzle instance when inside withTenant/withoutTenant. */
export function currentTx(): TxDatabase {
  const ctx = als.getStore();
  if (!ctx) {
    throw new Error('No transaction in context. Wrap the call in withTenant/withoutTenant.');
  }
  return ctx.db;
}

/** Current workspace id in context, if any. */
export function currentWorkspaceId(): string | undefined {
  return als.getStore()?.workspaceId || undefined;
}

/**
 * Set app.workspace_id on the CURRENT transaction/session. Used during signup,
 * where a new workspace is created inside withoutTenant and we then need the
 * RLS context to insert the first membership — all in one atomic transaction.
 */
export async function setTenantContext(workspaceId: string): Promise<void> {
  const ctx = als.getStore();
  if (!ctx) throw new Error('setTenantContext: no transaction in context');
  await ctx.db.execute(sql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`);
}

/**
 * Set app.user_id on the current transaction. Used during auth so a signed-in
 * user can read their OWN memberships (self_membership_read RLS policy) to
 * discover/switch workspaces, without granting cross-tenant reads.
 */
export async function setUserContext(userId: string): Promise<void> {
  const ctx = als.getStore();
  if (!ctx) throw new Error('setUserContext: no transaction in context');
  await ctx.db.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
}

export { als, sql };
