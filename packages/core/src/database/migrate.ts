#!/usr/bin/env node

/**
 * Custom migration script that uses the application's database connection.
 * Uses a dedicated single connection for migrations to avoid conflicts.
 *
 * Unlike drizzle-kit migrate which uses its own pg connection pool,
 * this script uses our optimized postgres.js connection settings.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runMigrations() {
  const DATABASE_URL = process.env.DATABASE_URL;

  if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL environment variable is required');
    process.exit(1);
  }

  console.log('🔄 Starting database migrations...');
  console.log('📍 Using direct PostgreSQL connection (Render)');

  // Create a migration-specific client
  // Migrations use a single dedicated connection to avoid conflicts
  const migrationClient = postgres(DATABASE_URL, {
    max: 1, // Single connection for migrations - avoids conflicts
    idle_timeout: 30,
    connect_timeout: 10, // Fail fast if connection issues
    max_lifetime: 60 * 60, // 1 hour max lifetime
    prepare: true, // Enable prepared statements (direct connection)
    fetch_types: true, // Fetch types for proper type handling
    ssl: 'require', // Required for Render PostgreSQL
    connection: {
      application_name: 'scani-migrations', // Helps identify migration connections in pg_stat_activity
    },
    onnotice: () => {}, // Suppress notices during migration
  });

  const db = drizzle(migrationClient);

  try {
    // Run migrations from the migrations folder
    const migrationsFolder = join(__dirname, 'migrations');
    console.log(`📂 Migrations folder: ${migrationsFolder}`);

    await migrate(db, { migrationsFolder });

    console.log('✅ Migrations completed successfully');

    // Close the connection
    await migrationClient.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);

    // Ensure connection is closed on error
    try {
      await migrationClient.end();
    } catch (closeError) {
      console.error('Failed to close connection:', closeError);
    }

    process.exit(1);
  }
}

// Run migrations
runMigrations();
