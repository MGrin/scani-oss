#!/usr/bin/env node

/**
 * Custom migration script that uses the application's database connection.
 * This ensures migrations use the proper Supabase pooler configuration
 * (prepare: false, fetch_types: false, small connection pool).
 *
 * Unlike drizzle-kit migrate which uses its own pg connection pool,
 * this script reuses our optimized postgres.js connection.
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
  console.log('📍 Using Supabase pooler-optimized connection settings');

  // Create a migration-specific client with Supabase pooler settings
  // These settings match the application's connection configuration
  const migrationClient = postgres(DATABASE_URL, {
    max: 1, // Single connection for migrations - pooler handles scaling
    idle_timeout: 20,
    connect_timeout: 10, // Fail fast if connection issues
    max_lifetime: 60 * 30, // 30 minutes max lifetime for connections
    prepare: false, // Required for Supabase transaction pooler
    fetch_types: false, // Skip type fetching for faster connection
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
