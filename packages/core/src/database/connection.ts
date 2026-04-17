import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { dbLogger, logConfig } from '../utils/logger';
import { recordQueryExecuted } from './connection-monitor';
import * as schema from './schema';

// Environment variables
const DATABASE_URL = process.env.DATABASE_URL;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_CRON_JOB = process.env.IS_CRON_JOB === 'true'; // Set to 'true' in cron job environment

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
    dbUrl.searchParams.set('statement_timeout', '120000'); // 120 seconds in milliseconds
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
const sslMode: postgres.Options<Record<string, postgres.PostgresType>>['ssl'] = (() => {
  try {
    const url = new URL(finalDatabaseUrl);
    const param = url.searchParams.get('sslmode');
    if (param === 'disable') return false;
    if (param === 'require' || param === 'verify-ca' || param === 'verify-full') return 'require';
    const local = ['localhost', '127.0.0.1', '::1'];
    return local.includes(url.hostname) ? false : 'require';
  } catch {
    return 'require';
  }
})();

const connectionConfig: postgres.Options<Record<string, postgres.PostgresType>> = {
  max: 20, // Direct connection - can use larger pool (Render allows up to 97 connections)
  idle_timeout: 120, // Must exceed longest operation (wallet import ~75s) to avoid postgres.js negative timeout warnings
  connect_timeout: 10, // Fail fast on connection issues
  max_lifetime: 600, // 10 minutes — recycle connections regularly
  prepare: true, // Enable prepared statements - faster for repeated queries (direct connection supports this)
  fetch_types: true, // Fetch types on connect - enables proper type handling
  ssl: sslMode,
  connection: {
    application_name: `scani-${NODE_ENV}`, // Helps identify connections in pg_stat_activity
  },
};

const client = postgres(finalDatabaseUrl, connectionConfig);

db = drizzlePostgres(client, {
  schema,
  logger: logConfig.logSqlQueries
    ? {
        logQuery: (query, params) => {
          const startTime = Date.now();

          dbLogger.debug(
            {
              query: query.substring(0, 1000),
              params: params?.slice(0, 10),
            },
            '📊 Drizzle PostgreSQL Query'
          );

          // Record query execution for monitoring
          // Note: We don't have exact duration here since Drizzle doesn't provide it
          // This is a best-effort approximation
          const duration = Date.now() - startTime;
          recordQueryExecuted(undefined, query, duration);
        },
      }
    : false,
});

dbLogger.info(
  {
    url: DATABASE_URL.replace(/:[^:@]*@/, ':***@'), // Hide password in logs
    environment: NODE_ENV,
  },
  '🐘 Connected to PostgreSQL database'
);

export { client, db };

// Type-safe database instance
export type DbType = typeof db;

// Helper function to get database with proper typing
export function getTypedDb() {
  return db as ReturnType<typeof drizzlePostgres>;
}

// Alias for compatibility with existing code
export function getDb() {
  return db;
}

// Export schema for convenience
export { schema };

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

/**
 * Get active database connections count from PostgreSQL
 * Useful for monitoring connection pool usage
 */
export async function getActiveConnectionsCount(): Promise<number> {
  try {
    const result = await db.execute<{ count: number }>(
      // Query pg_stat_activity for connections from this application
      // biome-ignore lint/suspicious/noExplicitAny: Raw SQL query with unknown result type
      `SELECT COUNT(*) as count FROM pg_stat_activity WHERE application_name LIKE 'scani-%'` as any
    );
    // biome-ignore lint/suspicious/noExplicitAny: Result type varies by query
    return (result as any)?.rows?.[0]?.count || 0;
  } catch (error) {
    dbLogger.warn({ error }, 'Failed to get active connections count');
    return 0;
  }
}

// Export connection monitoring utilities
export {
  endConnectionTracking,
  getConnectionMonitoringStats,
  recordConnectionAcquired,
  recordConnectionReleased,
  recordQueryExecuted,
  startConnectionTracking,
} from './connection-monitor';
