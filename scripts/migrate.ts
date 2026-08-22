/**
 * SC-518. `bun run db:migrate` applies TWO schemas:
 *
 *   1. the application schema, via Drizzle (`@scani/db`)
 *   2. BullMQ's queue schema, via `runQueueMigrations` (`@scani/queue`)
 *
 * Both belong in the same deployment step, before any app starts. BullMQ's
 * docs are explicit that its migration is not applied on connect, and the api
 * and worker deploy CONCURRENTLY — a process that migrated at boot would race
 * the one that did not, on a repo where `migrate` already runs first and alone
 * for exactly this reason.
 *
 * It lives in `scripts/` rather than inside `@scani/db` so that package does
 * not gain a dependency on `bullmq` — the direction runs business -> infra, and
 * the queue's schema is the queue's own business.
 *
 * SC-535. This is also the entrypoint `packages/infra/db/Dockerfile.migrate`
 * compiles into `scani/migrate`, which is the ONLY migrator a self-hoster
 * runs. It therefore has to work with no `bun` on the box and no
 * `node_modules` beside it, which is why the Drizzle step is an in-process
 * call rather than the `Bun.spawn` it used to be. Keeping the image and
 * `bun run db:migrate` on the same entrypoint is the point: the previous
 * arrangement compiled the Drizzle migrator directly, so the image was the one
 * caller that never reached the queue schema and a self-hoster's first enqueue
 * failed with `schema "bullmq" is not initialized`.
 *
 * Arguments (`--allow-remote <host>`, `--assume-applied-through <id>`) are read
 * off `process.argv` by the Drizzle step itself; the queue step reads
 * DATABASE_URL like everything else.
 */
import { runDrizzleMigrations } from '@scani/db/migrate';
import { runQueueMigrations } from '@scani/queue';

const code = await runDrizzleMigrations();
if (code !== 0) {
  console.error(
    `migrate: application schema failed (exit ${code}) — not touching the queue schema`
  );
  process.exit(code);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('migrate: DATABASE_URL is not set — cannot migrate the queue schema');
  process.exit(1);
}

await runQueueMigrations(url);
console.log('migrate: application + queue schemas applied');
