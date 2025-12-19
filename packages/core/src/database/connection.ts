import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { startDbSpan } from '../lib/sentry';
import { createTimer, dbLogger, logConfig } from '../utils/logger';
import * as schema from './schema';

// Environment variables
const DATABASE_URL = process.env.DATABASE_URL;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Database connection pool configuration with validation
const MAX_CONNECTIONS = process.env.DB_MAX_CONNECTIONS
  ? Math.max(1, parseInt(process.env.DB_MAX_CONNECTIONS, 10) || 20)
  : 20; // Increased from default 10
const IDLE_TIMEOUT = process.env.DB_IDLE_TIMEOUT
  ? Math.max(0, parseInt(process.env.DB_IDLE_TIMEOUT, 10) || 30)
  : 30; // 30 seconds
const CONNECT_TIMEOUT = process.env.DB_CONNECT_TIMEOUT
  ? Math.max(1, parseInt(process.env.DB_CONNECT_TIMEOUT, 10) || 30)
  : 30; // 30 seconds - increased for Supabase pooler stability
const MAX_LIFETIME = process.env.DB_MAX_LIFETIME
  ? Math.max(0, parseInt(process.env.DB_MAX_LIFETIME, 10) || 1800)
  : 60 * 30; // 30 minutes

// Database connection
let db: ReturnType<typeof drizzlePostgres>;

// All environments use PostgreSQL
if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL environment variable is required. ' +
      'Please set DATABASE_URL to a valid PostgreSQL connection string.'
  );
}

const client = postgres(DATABASE_URL, {
  max: MAX_CONNECTIONS, // Maximum number of connections in the pool
  idle_timeout: IDLE_TIMEOUT, // Close idle connections after this many seconds
  connect_timeout: CONNECT_TIMEOUT, // Fail connection after this many seconds
  max_lifetime: MAX_LIFETIME, // Close connections after this many seconds (prevents connection leaks)
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
});

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
    poolConfig: {
      max: MAX_CONNECTIONS,
      idleTimeout: `${IDLE_TIMEOUT}s`,
      connectTimeout: `${CONNECT_TIMEOUT}s`,
      maxLifetime: `${MAX_LIFETIME}s`,
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
    // Note: postgres.js doesn't expose active/idle connection counts
    // For that, you'd need to query pg_stat_activity
  };
}
