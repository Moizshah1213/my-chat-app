import { customType } from 'drizzle-orm/pg-core';

/**
 * citext (case-insensitive text) custom column type.
 * The pg `citext` extension is enabled in migration 0001.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});
