import { Database } from 'bun:sqlite';
import { drizzle as drizzleSQLite } from 'drizzle-orm/bun-sqlite';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createTimer, dbLogger, logConfig } from '../utils/logger';
import * as schema from './schema';

// Environment variables
const DATABASE_URL = process.env.DATABASE_URL;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Database connection
let db: ReturnType<typeof drizzleSQLite> | ReturnType<typeof drizzlePostgres>;

if (NODE_ENV === 'production' && DATABASE_URL?.startsWith('postgres')) {
  // Production: Use Postgres with logging
  const client = postgres(DATABASE_URL, {
    onnotice: (notice) => {
      dbLogger.info({ notice }, '📢 PostgreSQL Notice');
    },
    debug: logConfig.logSqlQueries
      ? (connection, query, parameters) => {
          const timer = createTimer();
          dbLogger.debug(
            {
              connection,
              query: query.substring(0, 1000), // Limit query length in logs
              parameters: parameters?.slice(0, 10), // Limit parameters in logs
            },
            '🔍 PostgreSQL Query'
          );

          // Return a function to log the completion
          return () => {
            const duration = timer.end();
            dbLogger.debug(
              {
                duration: `${duration}ms`,
              },
              '✅ PostgreSQL Query completed'
            );
          };
        }
      : undefined,
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
    },
    '🐘 Connected to PostgreSQL database'
  );
} else {
  // Development/Test: Use SQLite with Bun's native driver
  // Resolve path relative to the project root, not the current working directory
  const fs = require('node:fs');
  const path = require('node:path');
  const projectRoot = path.resolve(__dirname, '../../../../');
  const dbPath = process.env.DB_PATH || path.join(projectRoot, 'data', 'app.db');

  // Ensure the data directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    dbLogger.info({ dir }, '📁 Created database directory');
  }

  const sqlite = new Database(dbPath);

  // Enable foreign key constraints for SQLite to support cascade deletions
  sqlite.exec('PRAGMA foreign_keys = ON');
  dbLogger.debug('🔧 Enabled SQLite foreign key constraints');

  // Enable WAL mode for better performance
  sqlite.exec('PRAGMA journal_mode = WAL');
  dbLogger.debug('📝 Enabled SQLite WAL mode');

  db = drizzleSQLite(sqlite, {
    schema,
    logger: logConfig.logSqlQueries
      ? {
          logQuery: (query, params) => {
            const timer = createTimer();
            dbLogger.debug(
              {
                query: query.substring(0, 1000),
                params: params?.slice(0, 10),
              },
              '📊 Drizzle SQLite Query'
            );

            // Note: SQLite doesn't provide async completion callback like Postgres
            const duration = timer.end();
            if (duration > 100) {
              // Log slow queries (>100ms)
              dbLogger.warn(
                {
                  duration: `${duration}ms`,
                  query: query.substring(0, 200),
                },
                '🐌 Slow SQLite Query detected'
              );
            }
          },
        }
      : false,
  });

  dbLogger.info(
    {
      path: dbPath,
      size: fs.statSync(dbPath).size,
    },
    '💾 Connected to SQLite database'
  );
}

export { db };

// Export the database instance with proper typing
export type DbType = typeof db;
