#!/usr/bin/env node

/**
 * Custom migration script that uses the application's database connection.
 * Uses a dedicated single connection for migrations to avoid conflicts.
 *
 * Unlike drizzle-kit migrate which uses its own pg connection pool,
 * this script uses our optimized postgres.js connection settings.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from monorepo root (packages/core/src/database -> root)
const monorepoRoot = resolve(__dirname, '../../../../');
const envPath = join(monorepoRoot, '.env');

if (existsSync(envPath)) {
  // Bun has built-in .env loading, but we need to load from a specific path
  const envFile = Bun.file(envPath);
  const envContent = await envFile.text();

  // Parse and set environment variables (only if not already set)
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      const value = valueParts.join('=');
      if (key && value && !process.env[key]) {
        process.env[key] = value;
      }
    }
  }
  console.log(`📁 Loaded environment from ${envPath}`);
}

async function runMigrations() {
  const DATABASE_URL = process.env.DATABASE_URL;

  if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL environment variable is required');
    process.exit(1);
  }

  console.log('🔄 Starting database migrations...');

  // Decide SSL mode from the URL (sslmode=disable for local dev, otherwise
  // default to require for hosted Postgres). Explicit sslmode in the URL wins.
  const sslMode = (() => {
    try {
      const url = new URL(DATABASE_URL);
      const param = url.searchParams.get('sslmode');
      if (param === 'disable') return false;
      if (param === 'require' || param === 'verify-full' || param === 'verify-ca')
        return 'require' as const;
      // No sslmode in URL: default to require except for local loopback hosts.
      const local = ['localhost', '127.0.0.1', '::1'];
      return local.includes(url.hostname) ? false : ('require' as const);
    } catch {
      return 'require' as const;
    }
  })();

  console.log(`📍 PostgreSQL connection (ssl=${sslMode})`);

  // Create a migration-specific client
  // Migrations use a single dedicated connection to avoid conflicts
  const migrationClient = postgres(DATABASE_URL, {
    max: 1, // Single connection for migrations - avoids conflicts
    idle_timeout: 30,
    connect_timeout: 10, // Fail fast if connection issues
    max_lifetime: 60 * 60, // 1 hour max lifetime
    prepare: true, // Enable prepared statements (direct connection)
    fetch_types: true, // Fetch types for proper type handling
    ssl: sslMode,
    connection: {
      application_name: 'scani-migrations', // Helps identify migration connections in pg_stat_activity
    },
    onnotice: () => {}, // Suppress notices during migration
  });

  const db = drizzle(migrationClient);

  try {
    // Source-run (`bun src/migrate.ts`): SQL files sit next to this script
    // at `__dirname/migrations`. Compiled-run (`bun build --compile`): the
    // binary lives at `/app/migrate` and the SQL folder is COPYed to
    // `/app/migrations` by Dockerfile.migrate. Fall back to the binary's
    // own directory when the source-relative path is gone.
    const candidates = [
      join(__dirname, 'migrations'),
      join(dirname(process.execPath), 'migrations'),
    ];
    const migrationsFolder = candidates.find((p) => existsSync(p));
    if (!migrationsFolder) {
      throw new Error(`Migrations folder not found. Checked:\n  - ${candidates.join('\n  - ')}`);
    }
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
