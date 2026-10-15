import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema>;

/** The transaction type produced by Database.transaction — always matches drizzle. */
export type TxDatabase = Parameters<Parameters<Database['transaction']>[0]>[0];

let _client: ReturnType<typeof postgres> | undefined;
let _db: Database | undefined;

/** Strip Drizzle-only startup params that raw postgres() rejects (?schema=). */
function cleanUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.delete('schema');
  return u.toString();
}

/**
 * Create the shared low-level connection pool (app_user role, NOBYPASSRLS).
 * Tenant isolation is enforced per-transaction via set_config + RLS.
 */
export function getClient(connectionString: string): ReturnType<typeof postgres> {
  if (!_client) {
    _client = postgres(cleanUrl(connectionString), {
      max: 10,
      idle_timeout: 30,
      onnotice: () => {},
    });
  }
  return _client;
}

export function getDb(connectionString: string): Database {
  if (!_db) {
    _db = drizzle(getClient(connectionString), { schema });
  }
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.end({ timeout: 5 });
    _client = undefined;
    _db = undefined;
  }
}

