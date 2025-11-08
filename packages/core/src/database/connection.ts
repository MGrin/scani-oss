import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { startDbSpan } from '../lib/sentry';
import { createTimer, dbLogger, logConfig } from '../utils/logger';
import * as schema from './schema';

// Environment variables
const DATABASE_URL = process.env.DATABASE_URL;
const NODE_ENV = process.env.NODE_ENV || 'development';

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
  },
  '🐘 Connected to PostgreSQL database'
);
export { db };

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
