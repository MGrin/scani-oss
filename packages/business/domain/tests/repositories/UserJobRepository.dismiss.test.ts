import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { UserJobRepository } from '../../src/repositories/UserJobRepository';
import { restoreContainerAfterAll } from '../../test/helpers/container';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * SC-292. Two document uploads failed permanently on 2026-08-11 and left no
 * record any reader can see: four DLQ entries, two documents, every one
 * `failedReason: "The specified key does not exist."`, and not one matching
 * row in `user_jobs`. Across all time every `document-parse` row is
 * `completed` — not because the job has never failed, but because the rows
 * that recorded failures were deleted.
 *
 * The rows were not written late. The enqueue mirror inserts BEFORE
 * `queue.add`, so a row exists from the moment a job is accepted. They were
 * removed afterwards by `jobs.remove`, which was a hard DELETE.
 *
 * That made a dismissal indistinguishable from an upload that never happened,
 * while the user still held the document — instance 15 of the absence-vs-
 * refusal class. Dismissal is a REFUSAL, and a refusal has to leave a mark.
 *
 * **The test that fails on the old behaviour is the first one**: after
 * dismissing, the row must still be there. Under `deleteFailed` it was gone,
 * and no query could distinguish it from a job that never existed.
 */

// Constructed directly, NOT via `Container.get`. Three other suites do
// `Container.set(UserJobRepository, {…stub})` and typedi's container is shared
// across files in one `bun test` process, so a Container lookup here returns
// whichever stub ran first — every test in this file failed that way in a full
// run while passing in isolation. The repository's only dependency is the db
// handle it resolves per call, so `new` is both safe and honest.
const repo = () => new UserJobRepository();

async function seedFailedJob(
  tx: Parameters<typeof makeUser>[0],
  jobId: string,
  over: Partial<typeof schema.userJobs.$inferInsert> = {}
): Promise<{ userId: string; jobId: string }> {
  const user = await makeUser(tx);
  await tx.insert(schema.userJobs).values({
    jobId,
    userId: user.id,
    jobName: 'document-parse',
    state: 'failed',
    attemptsMade: 2,
    attemptsAllowed: 2,
    payloadSummary: { originalFilename: 'invoice.pdf', sourceKind: 'upload' },
    error: 'The specified key does not exist.',
    deadAt: new Date('2026-08-11T12:00:00Z'),
    failureReason: 'unrecoverable',
    ...over,
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

describe('dismissing a failed job does not erase it', () => {
  test('THE DEFECT: the row survives the dismissal', async () => {
    await withTestDb(async (tx) => {
      // The real shape: a document-parse that died on the missing temp key.
      const { userId, jobId } = await seedFailedJob(tx, 'document-parse_u_abc_e71304e7');

      const ok = await repo().dismissFailed(userId, jobId, tx);
      expect(ok).toBe(true);

      // Under the old `deleteFailed` this was `undefined`, and the only
      // remaining evidence of the upload was a DLQ entry no user can see.
      const row = await readRow(tx, jobId);
      expect(row).toBeDefined();
      expect(row?.dismissedAt).not.toBeNull();
      // Everything that says WHAT failed is still on the row.
      expect(row?.error).toBe('The specified key does not exist.');
      expect(row?.state).toBe('failed');
      expect(row?.payloadSummary).toMatchObject({ originalFilename: 'invoice.pdf' });
    });
  });

  test('the detail lookup still returns it — the record is retrievable', async () => {
    await withTestDb(async (tx) => {
      const { userId, jobId } = await seedFailedJob(tx, 'job-detail-visible');
      await repo().dismissFailed(userId, jobId, tx);

      const found = await repo().findOneMine(userId, jobId, tx);
      expect(found).not.toBeNull();
      expect(found?.dismissedAt).not.toBeNull();
    });
  });
});

describe('the user still gets the empty list they asked for', () => {
  test('a dismissed job leaves the jobs list', async () => {
    await withTestDb(async (tx) => {
      const { userId, jobId } = await seedFailedJob(tx, 'job-hidden-from-list');

      const before = await repo().findMine(userId, {}, tx);
      expect(before.map((j) => j.jobId)).toContain(jobId);

      await repo().dismissFailed(userId, jobId, tx);

      const after = await repo().findMine(userId, {}, tx);
      expect(after.map((j) => j.jobId)).not.toContain(jobId);
    });
  });

  test('and leaves the dead-job review feed, because dismissing IS dealing with it', async () => {
    await withTestDb(async (tx) => {
      const { userId, jobId } = await seedFailedJob(tx, 'job-hidden-from-feed');

      const before = await repo().findDeadUnacknowledged(userId, 50, tx);
      expect(before.map((j) => j.jobId)).toContain(jobId);

      await repo().dismissFailed(userId, jobId, tx);

      const after = await repo().findDeadUnacknowledged(userId, 50, tx);
      expect(after.map((j) => j.jobId)).not.toContain(jobId);
    });
  });

  test('an undismissed failure is still listed — hiding is not blanket', async () => {
    // Without this the two tests above would pass on a query that returns
    // nothing at all.
    await withTestDb(async (tx) => {
      const { userId, jobId } = await seedFailedJob(tx, 'job-still-listed');
      const rows = await repo().findMine(userId, {}, tx);
      expect(rows.map((j) => j.jobId)).toContain(jobId);
    });
  });
});

describe('what dismissal refuses to do', () => {
  test('a job that is not failed cannot be dismissed', async () => {
    await withTestDb(async (tx) => {
      const { userId, jobId } = await seedFailedJob(tx, 'job-active', {
        state: 'active',
        deadAt: null,
      });
      expect(await repo().dismissFailed(userId, jobId, tx)).toBe(false);
      expect((await readRow(tx, jobId))?.dismissedAt).toBeNull();
    });
  });

  test("another user cannot dismiss someone else's job", async () => {
    await withTestDb(async (tx) => {
      const { jobId } = await seedFailedJob(tx, 'job-other-user');
      const stranger = await makeUser(tx);
      expect(await repo().dismissFailed(stranger.id, jobId, tx)).toBe(false);
      expect((await readRow(tx, jobId))?.dismissedAt).toBeNull();
    });
  });

  test('a second dismissal is a no-op and does not move the timestamp', async () => {
    await withTestDb(async (tx) => {
      const { userId, jobId } = await seedFailedJob(tx, 'job-double-dismiss');
      expect(await repo().dismissFailed(userId, jobId, tx)).toBe(true);
      const first = (await readRow(tx, jobId))?.dismissedAt;

      // Idempotent: the router turns `false` into "already dismissed", and
      // overwriting would lose when the user actually saw it.
      expect(await repo().dismissFailed(userId, jobId, tx)).toBe(false);
      expect((await readRow(tx, jobId))?.dismissedAt).toEqual(first!);
    });
  });
});
