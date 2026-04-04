/**
 * Test database setup using testcontainers.
 *
 * Spins up a PostgreSQL container and pushes the schema directly
 * (no migration files — avoids issues with conflicting migrations).
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../database/schema';

let container: StartedPostgreSqlContainer | null = null;
let client: ReturnType<typeof postgres> | null = null;
let testDb: ReturnType<typeof drizzle> | null = null;

export async function setupTestDb(): Promise<void> {
  // Start PostgreSQL container
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('scani_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  const connectionString = container.getConnectionUri();

  // Set DATABASE_URL so modules that import connection.ts won't crash
  process.env.DATABASE_URL = connectionString;

  // Push schema using drizzle-kit programmatically isn't easy,
  // so we create tables via raw SQL from the schema definition.
  // For integration tests we use a setup script approach.
  const setupClient = postgres(connectionString, { max: 1 });
  const setupDb = drizzle(setupClient, { schema });

  // Create tables using drizzle schema push via raw SQL
  // We create the essential tables needed for tests
  await setupDb.execute(sql`
    -- Institution types
    CREATE TABLE IF NOT EXISTS institution_types (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
    );

    -- Token types
    CREATE TABLE IF NOT EXISTS token_types (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
    );

    -- Account types
    CREATE TABLE IF NOT EXISTS account_types (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
    );

    -- Institutions
    CREATE TABLE IF NOT EXISTS institutions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      type_id UUID NOT NULL REFERENCES institution_types(id),
      description TEXT,
      website TEXT,
      icon_url TEXT,
      is_active BOOLEAN DEFAULT true NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
    );

    -- Tokens
    CREATE TABLE IF NOT EXISTS tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      type_id UUID NOT NULL REFERENCES token_types(id),
      decimals INTEGER DEFAULT 2,
      icon_url TEXT,
      provider_metadata TEXT,
      is_scam_probability REAL DEFAULT 0,
      is_active BOOLEAN DEFAULT true NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
    );

    -- Users (simplified — no FK to auth.users)
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      supabase_id TEXT NOT NULL UNIQUE,
      email TEXT,
      username TEXT,
      base_currency_id UUID REFERENCES tokens(id),
      is_active BOOLEAN DEFAULT true NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
    );

    -- Accounts
    CREATE TABLE IF NOT EXISTS accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      institution_id UUID NOT NULL REFERENCES institutions(id),
      name TEXT NOT NULL,
      type_id UUID NOT NULL REFERENCES account_types(id),
      description TEXT,
      metadata JSONB DEFAULT '{}',
      is_active BOOLEAN DEFAULT true NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
    );

    -- Holdings
    CREATE TABLE IF NOT EXISTS holdings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      token_id UUID NOT NULL REFERENCES tokens(id),
      balance TEXT DEFAULT '0' NOT NULL,
      is_active BOOLEAN DEFAULT true NOT NULL,
      is_hidden BOOLEAN DEFAULT false NOT NULL,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
    );

    -- Token prices
    CREATE TABLE IF NOT EXISTS token_prices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      token_id UUID NOT NULL REFERENCES tokens(id),
      base_token_id UUID NOT NULL REFERENCES tokens(id),
      price TEXT NOT NULL,
      source TEXT,
      timestamp TIMESTAMPTZ DEFAULT now() NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now() NOT NULL
    );

    -- Seed essential data
    INSERT INTO institution_types (name, code) VALUES
      ('Bank', 'bank'),
      ('Brokerage', 'broker'),
      ('Crypto Exchange', 'crypto_exchange'),
      ('Crypto Wallet', 'crypto_wallet'),
      ('Other', 'other')
    ON CONFLICT DO NOTHING;

    INSERT INTO token_types (name, code) VALUES
      ('Cryptocurrency', 'crypto'),
      ('Stock', 'stock'),
      ('Fiat Currency', 'fiat'),
      ('Commodity', 'commodity')
    ON CONFLICT DO NOTHING;

    INSERT INTO account_types (name, code) VALUES
      ('Checking', 'checking'),
      ('Savings', 'savings'),
      ('Investment', 'investment'),
      ('Trading', 'trading')
    ON CONFLICT DO NOTHING;
  `);

  // Seed some test institutions
  await setupDb.execute(sql`
    INSERT INTO institutions (name, type_id, website, is_active)
    SELECT 'Binance', id, 'https://www.binance.com', true FROM institution_types WHERE code = 'crypto_exchange'
    ON CONFLICT DO NOTHING;

    INSERT INTO institutions (name, type_id, website, is_active)
    SELECT 'Wise', id, 'https://wise.com', true FROM institution_types WHERE code = 'bank'
    ON CONFLICT DO NOTHING;
  `);

  // Seed some test tokens
  await setupDb.execute(sql`
    INSERT INTO tokens (symbol, name, type_id, decimals)
    SELECT 'USD', 'US Dollar', id, 2 FROM token_types WHERE code = 'fiat'
    ON CONFLICT DO NOTHING;

    INSERT INTO tokens (symbol, name, type_id, decimals)
    SELECT 'BTC', 'Bitcoin', id, 8 FROM token_types WHERE code = 'crypto'
    ON CONFLICT DO NOTHING;

    INSERT INTO tokens (symbol, name, type_id, decimals)
    SELECT 'ETH', 'Ethereum', id, 18 FROM token_types WHERE code = 'crypto'
    ON CONFLICT DO NOTHING;
  `);

  await setupClient.end();

  // Create the test client
  client = postgres(connectionString, { max: 5 });
  testDb = drizzle(client, { schema });
}

export async function teardownTestDb(): Promise<void> {
  if (client) {
    await client.end();
    client = null;
  }
  if (container) {
    await container.stop();
    container = null;
  }
  testDb = null;
}

export function getTestDb() {
  if (!testDb) {
    throw new Error('Test database not initialized. Call setupTestDb() in beforeAll.');
  }
  return testDb;
}
