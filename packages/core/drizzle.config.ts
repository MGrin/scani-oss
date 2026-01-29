import type { Config } from 'drizzle-kit';

/**
 * Database URL for Drizzle Kit (schema generation only).
 *
 * NOTE: This config is ONLY used for `drizzle-kit generate` (schema → SQL).
 * Migrations should use the custom migrate.ts script which uses the
 * application's proper Supabase pooler configuration.
 *
 * For migrations, use: bun run db:migrate
 */
function getDatabaseUrl(): string {
  const baseUrl = process.env.DATABASE_URL || '';

  if (!baseUrl) {
    return '';
  }

  return baseUrl;
}

export default {
  schema: './src/database/schema.ts',
  out: './src/database/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: getDatabaseUrl(),
  },
  verbose: true,
  strict: true,
} satisfies Config;
