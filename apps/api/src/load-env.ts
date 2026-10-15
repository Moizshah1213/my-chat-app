import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load the repo-root .env regardless of the current working directory.
 * apps/api/src -> repo root is THREE levels up (src, api, apps).
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

const candidates = [join(process.cwd(), '.env'), join(root, '.env')];

for (const p of candidates) {
  if (existsSync(p)) {
    const result = loadDotenv({ path: p });
    if (!result.error) break;
  }
}
