import { getNodeEnv, postgresJsSsl } from '@scani/config';
import { postgresJsTls } from '@scani/config/postgres-direct-tls';
import { createComponentLogger, logConfig } from '@scani/logging';
import { sql } from 'drizzle-orm';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  assertNoConflictingOptionsParam,
  READ_ONLY_STARTUP_OPTION,
  resolveReadOnlyIntent,
} from './read-only';
// `./schema/index`, not `./schema` — a file named `schema.ts` would shadow the
// directory, and a stale one silently did until SC-278.
import * as schema from './schema/index';

const dbLogger = createComponentLogger('database');

// Environment variables
const DATABASE_URL = process.env.DATABASE_URL;
const NODE_ENV = getNodeEnv() || 'development';
const IS_CRON_JOB = process.env.IS_CRON_JOB === 'true'; // Set to 'true' in cron job environment

/**
 * Postgres's cap on one statement, a lock wait included, for every connection
 * this process opens. A `statement_timeout` in DATABASE_URL itself overrides it.
 */
export const STATEMENT_TIMEOUT_MS = IS_CRON_JOB ? 120_000 : 30_000;

// Database connection
let db: ReturnType<typeof drizzlePostgres>;

// All environments use PostgreSQL
if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL environment variable is required. ' +
      'Please set DATABASE_URL to a valid PostgreSQL connection string.'
  );
}

// Prepare DATABASE_URL with cron-specific parameters if running in cron context
let finalDatabaseUrl = DATABASE_URL;
if (IS_CRON_JOB) {
  const dbUrl = new URL(DATABASE_URL);

  // Add statement_timeout if not already present (2 minutes for cron jobs)
  // This prevents queries from hanging indefinitely in cron job context
  if (!dbUrl.searchParams.has('statement_timeout')) {
    dbUrl.searchParams.set('statement_timeout', String(STATEMENT_TIMEOUT_MS));
  }

  finalDatabaseUrl = dbUrl.toString();
}

// Connection pool configuration for PostgreSQL
// Render / Neon / Fly provide direct PostgreSQL connections (no PgBouncer), so
// we can use prepared statements and a reasonable connection pool size.
// Direct connections benefit from:
// - Prepared statements (faster repeated queries)
// - Type caching (fetch_types: true)
// - Larger connection pools (server-side limit, not pooler-limited)
// verify-full for every hosted database (SC-784), opened directly rather than
// upgraded in-band where the server allows it, because Bun keeps every byte an
// upgraded connection reads (SC-1440).
const tlsOptions = postgresJsTls(finalDatabaseUrl, postgresJsSsl(finalDatabaseUrl), 10_000);

// Pool size — override via `POSTGRES_POOL_MAX` if you're on a pooled
// endpoint (Neon pgBouncer caps far below direct). Default 20 matches
// direct Render / Neon / Fly.
const poolMax = (() => {
  const raw = process.env.POSTGRES_POOL_MAX;
  if (!raw) return 20;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 20;
})();

/**
 * Whether every session this process opens refuses writes (SC-422).
 *
 * Decided here, at the only moment it CAN be decided: the client is built when
 * this module loads, and a caller cannot set it afterwards. The inputs are
 * therefore argv and env — see `./read-only` for the policy and for what a
 * repair script's dry run gets for free because of it.
 */
const readOnlySession = resolveReadOnlyIntent({ argv: process.argv, env: process.env });
if (readOnlySession) assertNoConflictingOptionsParam(finalDatabaseUrl);

const connectionConfig: postgres.Options<Record<string, postgres.PostgresType>> = {
  max: poolMax, // Direct connection - can use larger pool (Render allows up to 97 connections)
  idle_timeout: 1800,
  connect_timeout: 10, // Fail fast on connection issues
  max_lifetime: 3600,
  prepare: true, // Enable prepared statements - faster for repeated queries (direct connection supports this)
  fetch_types: true, // Fetch types on connect - enables proper type handling
  ...tlsOptions,
  connection: {
    application_name: `scani-${NODE_ENV}`, // Helps identify connections in pg_stat_activity
    // Cap per-query wall-time so a runaway query can't pin a pool slot
    // indefinitely under load. Cron jobs run heavier sweeps, so they get
    // the longer ceiling (also applied via the URL param above).
    statement_timeout: STATEMENT_TIMEOUT_MS,
    // Postgres refuses the write itself, so a bug in a dry run fails with
    // 25006 instead of succeeding. `options` and not a URL param: query params
    // are spread OVER this object by postgres.js, so the URL is the one place
    // it could be replaced without anyone noticing.
    ...(readOnlySession ? { options: READ_ONLY_STARTUP_OPTION } : {}),
  },
};

const client = postgres(finalDatabaseUrl, connectionConfig);

/**
 * A client of exactly one connection, for one session advisory lock
 * (SC-1613). A lock on a pooled connection that dies goes back into the pool
 * dead, and the next query on it crashes the process from postgres.js's write
 * timer. Its own client is ended instead, and it has no idle or lifetime
 * timer, either of which would close the session and free the lock unseen.
 */
export function createSessionLockClient(onclose: () => void) {
  return postgres(finalDatabaseUrl, {
    ...connectionConfig,
    max: 1,
    idle_timeout: 0,
    max_lifetime: 0,
    onclose,
  });
}

db = drizzlePostgres(client, {
  schema,
  logger: logConfig.logSqlQueries
    ? {
        logQuery: (query, params) => {
          dbLogger.debug(
            {
              query: query.substring(0, 1000),
              params: params?.slice(0, 10),
            },
            '📊 Drizzle PostgreSQL Query'
          );
        },
      }
    : false,
});

// Neon-pooler warning: Neon's managed pgBouncer endpoint (`*-pooler.neon.tech`
// or `?pgbouncer=true`) caps concurrent app connections far below what a
// direct endpoint allows. Our `max: 20` config assumes a direct endpoint —
// on a pooled endpoint those 20 slots become a hard ceiling against an
// already-narrow pooler budget, with deadlock-ish symptoms when all
// workers ramp up. Warn loudly at boot so the operator sees it in logs.
(() => {
  try {
    const host = new URL(finalDatabaseUrl).host.toLowerCase();
    const looksPooled = host.includes('-pooler.') || /[?&]pgbouncer=true/i.test(finalDatabaseUrl);
    if (looksPooled) {
      dbLogger.warn(
        {
          host,
          configuredMax: connectionConfig.max,
        },
        '⚠️  DATABASE_URL appears to be a pooled endpoint (Neon pgBouncer). ' +
          'Current pool `max` was tuned for direct connections — consider setting ' +
          'POSTGRES_POOL_MAX=5 in env if you see connection-exhaustion errors.'
      );
    }
  } catch {
    // Bad URL — the earlier validations already blew up; nothing to do.
  }
})();

dbLogger.info(
  {
    url: DATABASE_URL.replace(/:[^:@]*@/, ':***@'), // Hide password in logs
    environment: NODE_ENV,
  },
  '🐘 Connected to PostgreSQL database'
);

if (readOnlySession) {
  dbLogger.warn(
    { url: DATABASE_URL.replace(/:[^:@]*@/, ':***@') },
    '🔒 Read-only session: every write will be refused by Postgres. ' +
      'Confirm it with assertSessionReadOnly — a config is not a session.'
  );
}

export { client, db };

/**
 * Whether this process's sessions refuse writes. Read it to EXPLAIN the mode;
 * `assertSessionReadOnly` is what proves it.
 */
export const isReadOnlySession = readOnlySession;

// Type-safe database instance
export type DbType = typeof db;

// Alias for compatibility with existing code
export function getDb() {
  return db;
}

/**
 * Get database connection pool statistics
 * Useful for monitoring and debugging connection issues
 */
export function getConnectionStats() {
  // postgres.js doesn't expose live pool metrics, but at minimum we should
  // report the *actual* configuration we handed to the driver, not made-up
  // numbers. Active/idle counts still require a pg_stat_activity query.
  return {
    maxConnections: connectionConfig.max,
    idleTimeout: connectionConfig.idle_timeout,
    connectTimeout: connectionConfig.connect_timeout,
    maxLifetime: connectionConfig.max_lifetime,
    fetchTypes: connectionConfig.fetch_types,
    prepare: connectionConfig.prepare,
  };
}

/** Active Scani sessions across this database, excluding this diagnostic query. */
export async function getActiveConnectionsCount(): Promise<number | null> {
  try {
    const result = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND application_name LIKE 'scani-%'
        AND state = 'active' AND pid <> pg_backend_pid()
    `);
    return result[0]?.count ?? null;
  } catch (error) {
    dbLogger.warn({ error }, 'Failed to read active database sessions');
    return null;
  }
}
