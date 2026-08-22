/**
 * SC-518. `bun run db:migrate` now applies TWO schemas:
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
 * This wrapper exists rather than chaining with `&&` because the deploy calls
 * `bun run db:migrate -- --allow-remote "$host"`, and `&&` in a package script
 * would hand those arguments to the whole chain. Args are forwarded to the
 * Drizzle step only; the queue step reads DATABASE_URL like everything else.
 *
 * It lives in `scripts/` rather than inside `@scani/db` so that package does
 * not gain a dependency on `bullmq` — the direction runs business -> infra, and
 * the queue's schema is the queue's own business.
 */
import { runQueueMigrations } from '@scani/queue';

const args = process.argv.slice(2);

const drizzle = Bun.spawn(['bun', 'run', '--cwd', 'packages/infra/db', 'db:migrate', ...args], {
  stdout: 'inherit',
  stderr: 'inherit',
});
const code = await drizzle.exited;
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
