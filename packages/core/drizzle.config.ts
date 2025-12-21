import type { Config } from 'drizzle-kit';

// Add connection timeout parameters for deployment environments
// This helps prevent ETIMEDOUT errors during Render deployments
function getDatabaseUrl(): string {
  const baseUrl = process.env.DATABASE_URL || '';

  if (!baseUrl) {
    return '';
  }

  // Parse URL to check if it already has query parameters
  const url = new URL(baseUrl);

  // Add connection timeout parameters if not already present
  // These values are higher than runtime to accommodate slower build environments
  if (!url.searchParams.has('connect_timeout')) {
    url.searchParams.set('connect_timeout', '60'); // 60 seconds for initial connection
  }
  if (!url.searchParams.has('statement_timeout')) {
    url.searchParams.set('statement_timeout', '120000'); // 120 seconds (in milliseconds)
  }
  if (!url.searchParams.has('idle_in_transaction_session_timeout')) {
    url.searchParams.set('idle_in_transaction_session_timeout', '120000'); // 120 seconds
  }

  return url.toString();
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
