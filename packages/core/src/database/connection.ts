import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { startDbSpan } from '../lib/sentry';
import { createTimer, dbLogger, logConfig } from '../utils/logger';
import * as schema from './schema';

// Environment variables
const DATABASE_URL = process.env.DATABASE_URL;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Database connection pool configuration with validation
// Optimized for Render free tier and Supabase connection pooler
const MAX_CONNECTIONS = process.env.DB_MAX_CONNECTIONS
  ? Math.max(1, parseInt(process.env.DB_MAX_CONNECTIONS, 10) || 10)
  : 10; // Reduced from 50 to 10 - Render free tier has limited connections
const IDLE_TIMEOUT = process.env.DB_IDLE_TIMEOUT
  ? Math.max(0, parseInt(process.env.DB_IDLE_TIMEOUT, 10) || 10)
  : 10; // Keep connections alive for 10s - balance between resource usage and connection reuse
const CONNECT_TIMEOUT = process.env.DB_CONNECT_TIMEOUT
  ? Math.max(1, parseInt(process.env.DB_CONNECT_TIMEOUT, 10) || 15)
  : 15; // Increased to 15s - Render free tier can be slow on cold starts
const MAX_LIFETIME = process.env.DB_MAX_LIFETIME
  ? Math.max(0, parseInt(process.env.DB_MAX_LIFETIME, 10) || 1800)
  : 60 * 15; // 15 minutes (reduced from 30) - recycle connections more frequently on free tier
const PREPARE = process.env.DB_PREPARE === 'true'; // Disable prepared statements by default

// Database connection
let db: ReturnType<typeof drizzlePostgres>;

// All environments use PostgreSQL
if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL environment variable is required. ' +
      'Please set DATABASE_URL to a valid PostgreSQL connection string.'
  );
}

// Detect if using Supabase pooler and add SSL configuration
const isSupabasePooler = DATABASE_URL.includes('.pooler.supabase.com');
const connectionConfig: postgres.Options<Record<string, postgres.PostgresType>> = {
  max: MAX_CONNECTIONS, // Maximum number of connections in the pool
  // idle_timeout: IDLE_TIMEOUT, // Close idle connections after this many seconds
  // connect_timeout: CONNECT_TIMEOUT, // Fail connection after this many seconds
  // max_lifetime: MAX_LIFETIME, // Close connections after this many seconds (prevents connection leaks)
  // prepare: PREPARE, // Use prepared statements for better performance (disabled if behind PgBouncer)
  // Connection optimization for Supabase pooler
  fetch_types: false, // Skip type fetching on connect - faster connection establishment
  // SSL configuration - required for Supabase
  // ssl: isSupabasePooler ? 'require' : false,
  // Retry configuration for transient errors
  connection: {
    application_name: `scani-${NODE_ENV}`, // Helps identify connections in pg_stat_activity
  },
  onnotice: (notice) => {
    dbLogger.info({ notice }, '📢 PostgreSQL Notice');
  },
  debug: (connection, query, parameters) => {
    const timer = createTimer();
    const operation = query.trim().split(' ')[0]?.toUpperCase() || 'QUERY';

    return startDbSpan(operation, undefined, query, parameters, () => {
      if (logConfig.logSqlQueries) {
        dbLogger.debug(
          {
            connection,
            query: query.substring(0, 1000), // Limit query length in logs
            parameters: parameters?.slice(0, 10), // Limit parameters in logs
          },
          '🔍 PostgreSQL Query'
        );
      }

      // Return a function to log the completion
      return () => {
        const duration = timer.end();
        if (logConfig.logSqlQueries) {
          dbLogger.debug(
            {
              duration: `${duration}ms`,
            },
            '✅ PostgreSQL Query completed'
          );
        }
      };
    });
  },
};

const client = postgres(DATABASE_URL, connectionConfig);

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
    isSupabasePooler,
    poolConfig: {
      // max: MAX_CONNECTIONS,
      // idleTimeout: `${IDLE_TIMEOUT}s`,
      // connectTimeout: `${CONNECT_TIMEOUT}s`,
      // maxLifetime: `${MAX_LIFETIME}s`,
      // prepare: PREPARE,
      // fetchTypes: false,
      // ssl: isSupabasePooler ? 'require' : false,
    },
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
    maxConnections: MAX_CONNECTIONS,
    idleTimeout: IDLE_TIMEOUT,
    connectTimeout: CONNECT_TIMEOUT,
    maxLifetime: MAX_LIFETIME,
    prepare: PREPARE,
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
