import type { Config } from 'drizzle-kit';

export default {
  schema: './apps/backend/src/db/schema.ts',
  out: './apps/backend/src/db/migrations',
  dialect:
    process.env.NODE_ENV === 'production' && process.env.DATABASE_URL?.startsWith('postgres')
      ? 'postgresql'
      : 'sqlite',
  dbCredentials:
    process.env.NODE_ENV === 'production' && process.env.DATABASE_URL?.startsWith('postgres')
      ? {
          url: process.env.DATABASE_URL || '',
        }
      : {
          url: process.env.DB_PATH || './data/app.db',
        },
  verbose: true,
  strict: true,
} satisfies Config;
