/**
 * Thin Postgres bootstrap for data-provider's own tables
 * (`cloud_users`, `cloud_sessions`, `cloud_accounts`, `cloud_verifications`,
 * `cloud_api_keys`, `cloud_usage_events`). Per-request usage rows are
 * written to `cloud_usage_events` in the same database.
 *
 * We intentionally do NOT reuse `@scani/db`'s singleton `db` export here:
 * that package is wired for the backend/worker's connection-monitor +
 * request-context hooks. In the data-provider, we only need a vanilla
 * drizzle client for the cloud_* tables. Keeping the client local also
 * keeps the service lean when CLOUD_MANAGEMENT_ENABLED=false (Tier 1 OSS)
 * — no DB connection is opened at all.
 */

import * as schema from '@scani/db';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

export type CloudDb = ReturnType<typeof drizzle<typeof schema>>;

let sql: ReturnType<typeof postgres> | null = null;
let dbClient: CloudDb | null = null;

export function getCloudDb(databaseUrl: string): CloudDb {
  if (dbClient) return dbClient;

  const sslMode = (() => {
    try {
      const url = new URL(databaseUrl);
      const param = url.searchParams.get('sslmode');
      if (param === 'disable') return false;
      if (param === 'require') return 'require' as const;
      const local = ['localhost', '127.0.0.1', '::1'];
      return local.includes(url.hostname) ? false : ('require' as const);
    } catch {
      return 'require' as const;
    }
  })();

  sql = postgres(databaseUrl, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: sslMode,
    connection: { application_name: 'scani-data-provider' },
  });
  dbClient = drizzle(sql, { schema });
  return dbClient;
}

export async function closeCloudDb(): Promise<void> {
  if (sql) {
    try {
      await sql.end({ timeout: 5 });
    } catch {
      /* noop */
    }
    sql = null;
    dbClient = null;
  }
}
