import { neon } from '@neondatabase/serverless';
import { getDatabaseUrl } from '../neon';

/**
 * Shared Neon SQL connection for every `clients/db/*` module. The lazy
 * resolver mirrors the original `appDb.ts` pattern — `getDatabaseUrl`
 * pulls the connection string out of Neon's API once, the `neon(url)`
 * client is then memoized per process.
 */

type Sql = ReturnType<typeof neon>;
let sql: Sql | null = null;

export async function getSql(): Promise<Sql> {
  if (sql) return sql;
  const url = await getDatabaseUrl();
  sql = neon(url);
  return sql;
}
