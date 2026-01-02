import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { dbLogger, logConfig } from '../utils/logger';
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

// Detect if using Supabase pooler and add SSL configuration
// For Supabase transaction pooler (port 6543), use a SMALL connection pool
// The pooler itself handles scaling - large client pools cause connection exhaustion
const connectionConfig: postgres.Options<Record<string, postgres.PostgresType>> = {
  max: 1, // Use single connection per client - Supabase pooler handles scaling
  idle_timeout: 20, // Close idle connections after 20 seconds
  connect_timeout: 10, // Keep timeouts short to fail fast
  max_lifetime: 60 * 30, // 30 minutes max lifetime for connections
  prepare: false, // Disable prepared statements - required for Supabase transaction pooler
  fetch_types: false, // Skip type fetching on connect - faster connection establishment
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

dbLogger.info(
  {
    url: DATABASE_URL.replace(/:[^:@]*@/, ':***@'), // Hide password in logs
    environment: NODE_ENV,
  },
  '🐘 Connected to PostgreSQL database'
);
export { db, client };

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
  // postgres.js doesn't expose pool stats directly, but we can provide config info
  return {
    fetchTypes: false,
    // Note: postgres.js doesn't expose active/idle connection counts
    // For that, you'd need to query pg_stat_activity
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
