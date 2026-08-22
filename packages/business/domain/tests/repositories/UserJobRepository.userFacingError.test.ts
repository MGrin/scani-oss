import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { userFacing, userFacingMessage } from '@scani/queue';
import { eq, sql } from 'drizzle-orm';
import { UserJobRepository } from '../../src/repositories/UserJobRepository';
import { restoreContainerAfterAll } from '../../test/helpers/container';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * SC-551. `user_jobs.error` holds whatever the processor threw and is read by
 * the admin user-jobs page; `user_jobs.user_facing_error` holds only what a
 * processor marked `userFacing(...)` and is what the owner is served.
 *
 * The load-bearing test is the FIRST one, and it uses a **real**
 * `DrizzleQueryError` produced by a query that genuinely fails against this
 * database — not a hand-written string that happens to contain `select`.
 *
 * That distinction is the reason this file is here rather than in
 * `@scani/queue`. The leak was never "somebody wrote a scary-looking message":
 * it was an ordinary ORM failure, from ordinary code, whose message format is
 * decided by a dependency and could change under us. A test that asserts
 * against a string we invented would keep passing if drizzle started including
 * the connection string, the bound parameters, or the schema name.
 */

// Constructed directly rather than via `Container.get` — other suites stub
// `UserJobRepository` on the process-global container, so a lookup here can
// return whichever stub ran first (see the note in the dismiss suite).
const repo = () => new UserJobRepository();

async function seedQueuedJob(
  tx: Parameters<typeof makeUser>[0],
  jobId: string
): Promise<{ userId: string; jobId: string }> {
  const user = await makeUser(tx);
  await tx.insert(schema.userJobs).values({
    jobId,
    userId: user.id,
    jobName: 'wallet-import',
    state: 'queued',
    attemptsAllowed: 3,
    payloadSummary: {},
  });
  return { userId: user.id, jobId };
}

async function readRow(
  tx: Parameters<typeof makeUser>[0],
  jobId: string
): Promise<typeof schema.userJobs.$inferSelect | undefined> {
  const [row] = await tx.select().from(schema.userJobs).where(eq(schema.userJobs.jobId, jobId));
  return row;
}

/**
 * A genuine drizzle failure: ask this database for a column that is not there.
 *
 * Nested in `tx.transaction(...)` — a SAVEPOINT — because a failed statement
 * aborts its transaction, and `withTestDb` runs the whole test inside one. Run
 * directly, the error is real and every later statement dies with
 * `25P02 current transaction is aborted`, which reads as a broken test rather
 * than as the deliberate failure it is. Rolling back to the savepoint leaves
 * the outer transaction usable and the error object intact.
 */
async function realDrizzleQueryError(tx: Parameters<typeof makeUser>[0]): Promise<unknown> {
  try {
    await tx.transaction(async (inner) => {
      await inner.execute(sql`select "no_such_column" from "holdings" limit 1`);
    });
  } catch (err) {
    return err;
  }
  throw new Error('expected the query to fail — this test measures nothing if it does not');
}

describe('a real ORM failure never becomes something the owner is shown', () => {
  test('THE DEFECT: the raw SQL is stored for operators and withheld from the owner', async () => {
    await withTestDb(async (tx) => {
      const err = await realDrizzleQueryError(tx);

      // The instrument's own control. If drizzle ever stops putting the
      // statement in the message, this assertion fails and tells us the test
      // is no longer exercising the leak — rather than passing vacuously.
      const raw = err instanceof Error ? err.message : String(err);
      expect(raw).toContain('select');
      expect(raw).toContain('no_such_column');

      // Nobody marked it, so nobody may read it.
      expect(userFacingMessage(err)).toBeNull();

      const { jobId } = await seedQueuedJob(tx, 'wallet-import_u_real_drizzle');
      await repo().markFailed(
        jobId,
        raw,
        { attemptsMade: 1, attemptsAllowed: 3, userFacingError: userFacingMessage(err) },
        tx
      );

      const row = await readRow(tx, jobId);
      // Operator: everything, verbatim.
      expect(row?.error).toContain('no_such_column');
      // Owner: nothing at all. Not a truncation, not a summary — the column
      // the api serves is null, and the client falls back to its translated
      // failure category.
      expect(row?.userFacingError).toBeNull();
    });
  });

  test('a marked message is stored for the owner and the raw one is still kept', async () => {
    await withTestDb(async (tx) => {
      const copy = 'The original file is no longer stored. Delete it and upload it again.';
      const err = userFacing(new Error(copy));
      const { jobId } = await seedQueuedJob(tx, 'wallet-import_u_marked');

      await repo().markFailed(
        jobId,
        copy,
        { attemptsMade: 1, attemptsAllowed: 3, userFacingError: userFacingMessage(err) },
        tx
      );

      const row = await readRow(tx, jobId);
      expect(row?.userFacingError).toBe(copy);
      expect(row?.error).toBe(copy);
    });
  });

  test('a later unmarked attempt clears the previous one’s sentence', async () => {
    // The one a future reader will want to soften, because keeping the older,
    // friendlier message looks kinder. It is a lie: attempt 2 failed for a
    // different reason, and leaving attempt 1's sentence over it tells the
    // owner something that is no longer true of their job.
    await withTestDb(async (tx) => {
      const { jobId } = await seedQueuedJob(tx, 'wallet-import_u_two_attempts');

      await repo().markFailed(
        jobId,
        'Your API key was rejected.',
        { attemptsMade: 1, attemptsAllowed: 3, userFacingError: 'Your API key was rejected.' },
        tx
      );
      // `markFailed` guards on a non-terminal state, so put the row back into
      // one — that is what BullMQ's retry does before attempt 2 runs.
      await tx
        .update(schema.userJobs)
        .set({ state: 'active' })
        .where(eq(schema.userJobs.jobId, jobId));
      await repo().markFailed(
        jobId,
        'Failed query: select "id" from "holdings"',
        { attemptsMade: 2, attemptsAllowed: 3, userFacingError: null },
        tx
      );

      const row = await readRow(tx, jobId);
      expect(row?.error).toContain('Failed query');
      expect(row?.userFacingError).toBeNull();
    });
  });

  test('a death does not overwrite the attempt that already vouched for a sentence', async () => {
    await withTestDb(async (tx) => {
      const copy = 'Your API key was rejected.';
      const { jobId } = await seedQueuedJob(tx, 'wallet-import_u_dead_after_marked');

      await repo().markFailed(
        jobId,
        copy,
        { attemptsMade: 1, attemptsAllowed: 3, userFacingError: copy },
        tx
      );
      await repo().markDead(
        jobId,
        {
          reason: 'unrecoverable',
          error: 'generic terminal text',
          userFacingError: null,
          attemptsMade: 1,
          attemptsAllowed: 3,
        },
        tx
      );

      const row = await readRow(tx, jobId);
      expect(row?.userFacingError).toBe(copy);
      expect(row?.deadAt).not.toBeNull();
    });
  });

  test('a job that dies before any attempt still gets its sentence', async () => {
    // A payload that fails validation throws before any other lifecycle event
    // exists, so `markDead` is the only write it ever gets. If the COALESCE
    // were read as "never write on death", this row would have nothing.
    await withTestDb(async (tx) => {
      const copy = 'That wallet address is not one we can read.';
      const { jobId } = await seedQueuedJob(tx, 'wallet-import_u_dead_first');

      await repo().markDead(
        jobId,
        {
          reason: 'unrecoverable',
          error: copy,
          userFacingError: copy,
          attemptsMade: 0,
          attemptsAllowed: 3,
        },
        tx
      );

      expect((await readRow(tx, jobId))?.userFacingError).toBe(copy);
    });
  });
});
