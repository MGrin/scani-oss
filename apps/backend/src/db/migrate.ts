import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const NODE_ENV = process.env.NODE_ENV || 'development';
const DATABASE_URL = process.env.DATABASE_URL;

async function runMigrations() {
  console.log('Running migrations...');

  if (NODE_ENV === 'production' && DATABASE_URL?.startsWith('postgres')) {
    // Production: Use Postgres
    const client = postgres(DATABASE_URL);
    const db = drizzlePostgres(client);

    await migratePostgres(db, { migrationsFolder: './apps/backend/src/db/migrations' });
    await client.end();

    console.log('✅ Postgres migrations completed successfully!');
  } else {
    // Development/Test: Use SQLite
    const dbPath = process.env.DB_PATH || './data/app.db';

    // Ensure the data directory exists
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const sqlite = new Database(dbPath);
    const db = drizzle(sqlite);

    await migrate(db, { migrationsFolder: './apps/backend/src/db/migrations' });
    sqlite.close();

    console.log('✅ SQLite migrations completed successfully!');
  }
}

// Run migrations if this file is executed directly
if (import.meta.main) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('❌ Migration failed:', error);
      process.exit(1);
    });
}

export { runMigrations };
