import './load-env.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/**
 * Versioned SQL migration runner.
 *
 * Connects as the migration owner role (app_migrator) which OWNS the tables and
 * therefore can create/alter them and define RLS policies. The runtime role
 * (app_user) cannot.
 *
 * Migrations are applied in filename order and tracked in schema_migrations.
 * Idempotent: each file uses IF NOT EXISTS / DROP IF EXISTS.
 */

const here = dirname(fileURLToPath(import.meta.url));

function cleanUrl(url: string): string {
  // postgres() rejects the Drizzle-style ?schema=public startup param.
  const u = new URL(url);
  u.searchParams.delete('schema');
  return u.toString();
}

async function main() {
  const isTest = process.argv.includes('--test');
  const url = isTest
    ? process.env.TEST_MIGRATION_DATABASE_URL
    : process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error(isTest ? 'TEST_MIGRATION_DATABASE_URL not set' : 'MIGRATION_DATABASE_URL not set');

  const sql = postgres(cleanUrl(url), { max: 1, onnotice: () => {} });

  // Tracking table (owned by migration role).
  await sql`CREATE SCHEMA IF NOT EXISTS public`;
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const dir = join(here, 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    (await sql`SELECT filename FROM schema_migrations`).map((r) => r.filename as string),
  );

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  = ${file} (already applied)`);
      continue;
    }
    const ddl = readFileSync(join(dir, file), 'utf8');
    console.log(`  -> applying ${file}`);
    // postgres.js simple protocol can run multiple statements; use unsafe on the
    // whole file (it's our own trusted, versioned SQL, not user input).
    await sql.unsafe(ddl);
    await sql`INSERT INTO schema_migrations (filename) VALUES (${file})
              ON CONFLICT (filename) DO NOTHING`;
  }

  await sql.end();
  console.log('Migrations complete.');
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
