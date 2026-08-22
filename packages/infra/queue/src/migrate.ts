import { createComponentLogger } from '@scani/logging';
import { runMigrations } from 'bullmq';
import { Pool } from 'pg';

const log = createComponentLogger('queue:migrate');

export const DEFAULT_QUEUE_SCHEMA = 'bullmq';

/**
 * Create or upgrade BullMQ's Postgres schema.
 *
 * BullMQ deliberately does NOT migrate on connect — its docs are explicit that
 * this belongs in one deployment step. That is why this lives here and is
 * called from `bun run db:migrate` alongside the Drizzle migrations, rather
 * than from an app's boot: the api and the worker deploy concurrently, and a
 * process that migrated on start would race the one that did not.
 *
 * Safe to call repeatedly. BullMQ's migrator is idempotent and takes a
 * transaction-scoped advisory lock namespaced per schema, so many instances
 * starting at once still migrate exactly once.
 *
 * This package owns it rather than `@scani/db` because `@scani/db` must not
 * depend on `bullmq` — the dependency runs business -> infra, and the queue's
 * schema is the queue's business.
 */
export async function runQueueMigrations(
  connectionString: string,
  schema: string = DEFAULT_QUEUE_SCHEMA
): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    const client = await pool.connect();
    try {
      await client.query(
        `CREATE SCHEMA IF NOT EXISTS ${JSON.stringify(schema).replace(/"/g, '"')}`
      );
      await client.query(`SET search_path TO ${schema}`);
      await runMigrations(client as never);
      log.info({ schema }, '📦 BullMQ schema migrated');
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
