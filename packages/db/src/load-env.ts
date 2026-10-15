import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load the repo-root .env regardless of the current working directory, so that
 * `pnpm --filter @livechat/db <script>` (which cds into the package) still sees
 * the shared root environment file.
 */
const here = dirname(fileURLToPath(import.meta.url));
// packages/db/src -> repo root requires THREE levels up (src, db, packages).
const root = resolve(here, '..', '..', '..');

const candidates = [join(process.cwd(), '.env'), join(root, '.env')];

for (const p of candidates) {
  if (existsSync(p)) {
    const result = loadDotenv({ path: p });
    if (!result.error) break;
  }
}
