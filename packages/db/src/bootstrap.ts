import './load-env.js';
import postgres from 'postgres';

/**
 * One-time infra bootstrap. Connects as the SUPERUSER (BOOTSTRAP_DATABASE_URL)
 * ONLY to create:
 *   - the migration owner role (app_migrator) — owns tables, defines RLS
 *   - the runtime role (app_user) — NOBYPASSRLS, non-superuser (least privilege)
 *   - the application databases (livechat + livechat_test)
 *
 * After this runs, the app never connects as superuser again. Re-runnable.
 *
 * Passwords are read from the runtime/migration URLs so there is a single source
 * of truth. In production, use a secret manager; these are dev defaults.
 */

const APPS = ['livechat', 'livechat_test'];
const MIGRATION_ROLE = 'app_migrator';
const RUNTIME_ROLE = 'app_user';

function creds(urlStr: string | undefined): { user: string; password: string } {
  if (!urlStr) throw new Error('URL not provided');
  const u = new URL(urlStr);
  return { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}

function cleanUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.delete('schema');
  return u.toString();
}

async function main() {
  const bootUrl = process.env.BOOTSTRAP_DATABASE_URL;
  if (!bootUrl) throw new Error('BOOTSTRAP_DATABASE_URL not set');

  const runtime = creds(process.env.DATABASE_URL);
  const migration = creds(process.env.MIGRATION_DATABASE_URL);

  const sql = postgres(cleanUrl(bootUrl), { max: 1, onnotice: () => {} });

  console.log('Creating roles...');
  // Migration owner role (owns schema objects).
  await sql.unsafe(
    `DO $$ BEGIN
       CREATE ROLE ${MIGRATION_ROLE} LOGIN PASSWORD '${migration.password}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     EXCEPTION WHEN duplicate_object THEN
       ALTER ROLE ${MIGRATION_ROLE} LOGIN PASSWORD '${migration.password}';
     END $$;`,
  );
  // Runtime role (least privilege, NOBYPASSRLS => RLS always enforced).
  await sql.unsafe(
    `DO $$ BEGIN
       CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${runtime.password}'
         NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
     EXCEPTION WHEN duplicate_object THEN
       ALTER ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${runtime.password}';
     END $$;`,
  );

  for (const dbName of APPS) {
    console.log(`Preparing database ${dbName}...`);
    const exists = await sql`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (exists.length === 0) {
      await sql.unsafe(`CREATE DATABASE ${dbName} OWNER ${MIGRATION_ROLE}`);
    }
  }

  // Connect to the primary DB to set schema ownership + grants.
  const appUrl = cleanUrl(bootUrl.replace(/\/[^/]+$/, `/${APPS[0]}`));
  const appSql = postgres(appUrl, { max: 1, onnotice: () => {} });

  await appSql.unsafe(`GRANT ALL ON SCHEMA public TO ${MIGRATION_ROLE}`);
  await appSql.unsafe(`GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}`);
  // Make app_migrator the owner of the public schema so it can run migrations.
  await appSql.unsafe(`ALTER SCHEMA public OWNER TO ${MIGRATION_ROLE}`);

  await appSql.end();
  await sql.end();
  console.log('Bootstrap complete. Now run: pnpm db:migrate');
}

main().catch((err) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
