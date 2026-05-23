import type { Config } from 'drizzle-kit';

/**
 * Database URL for Drizzle Kit (schema generation only).
 *
 * NOTE: This config is ONLY used for `drizzle-kit generate` (schema → SQL).
 * Migrations should use the custom migrate.ts script which uses the
 * application's proper PostgreSQL connection configuration.
 *
 * For migrations, use: bun run db:migrate
 */
function getDatabaseUrl(): string {
  const baseUrl = process.env.DATABASE_URL || '';

  if (!baseUrl) {
    return '';
  }

  const url = new URL(baseUrl);
  if (!url.searchParams.has('sslmode')) {
    url.searchParams.set('sslmode', 'require');
  }
  return url.toString();
}

export default {
  schema: './src/schema/index.ts',
  out: './src/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: getDatabaseUrl(),
    ssl: 'require',
  },
  verbose: true,
  strict: true,
} satisfies Config;
