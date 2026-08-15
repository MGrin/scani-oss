import { describe, expect, test } from 'bun:test';
import { UserJobRepository } from '@scani/domain/repositories';
import { QueueClient } from '@scani/queue';
import { Container } from 'typedi';
import { ReconcileOrphanedUserJobsProcessor } from '../../src/processors/reconcile-orphaned-user-jobs';

/**
 * This reconciler's verdict became *terminal* in SC-153: it now writes
 * `dead_at`, which tells the user "this never ran and never will". That raises
 * the cost of being wrong — and it could be wrong, because "queued for more
 * than 30 seconds" is also what a job waiting behind a busy worker looks like.
 * So it asks Redis first, and these tests pin both halves.
 */

interface DeadCall {
  jobId: string;
  meta: { reason: string; error: string; attemptsMade: number; attemptsAllowed: number };
}

function harness(options: { orphans: unknown[]; liveJobIds?: string[] }) {
  const deadCalls: DeadCall[] = [];
  const live = new Set(options.liveJobIds ?? []);

  Container.set(UserJobRepository, {
    findOrphanedQueued: async () => options.orphans,
    markDead: async (jobId: string, meta: DeadCall['meta']) => {
      deadCalls.push({ jobId, meta });
      return true;
    },
  } as unknown as UserJobRepository);

  Container.set(QueueClient, {
    get: () => ({
      getJob: async (jobId: string) => (live.has(jobId) ? { id: jobId } : undefined),
    }),
  } as unknown as QueueClient);

  const processor = new ReconcileOrphanedUserJobsProcessor();
  Container.set(ReconcileOrphanedUserJobsProcessor, processor);
  return { processor, deadCalls };
}

const orphan = (jobId: string) => ({
  jobId,
  userId: 'user-1',
  jobName: 'wallet-import',
  attemptsAllowed: 3,
});

// `handle` is protected — the scheduled-job base calls it. Reaching it
// directly keeps the test on the reconciliation logic rather than on the
// advisory-lock wrapper, which has its own coverage.
const run = (processor: ReconcileOrphanedUserJobsProcessor) =>
  (processor as unknown as { handle: () => Promise<void> }).handle();

describe('ReconcileOrphanedUserJobsProcessor', () => {
  test('marks a row dead when the queue has never heard of the job', async () => {
    const { processor, deadCalls } = harness({ orphans: [orphan('job-1')] });

    await run(processor);

    expect(deadCalls).toHaveLength(1);
    expect(deadCalls[0]?.jobId).toBe('job-1');
    expect(deadCalls[0]?.meta.reason).toBe('never_delivered');
    // The user needs to know nothing ran — that is what makes it safe to
    // start again from scratch.
    expect(deadCalls[0]?.meta.error).toContain('start it again');
    expect(deadCalls[0]?.meta.attemptsMade).toBe(0);
  });

  test('leaves a row alone when BullMQ still holds the job', async () => {
    // Queued behind a busy worker, not orphaned. Declaring this one dead
    // would be the same false claim the ticket exists to remove, pointed the
    // other way.
    const { processor, deadCalls } = harness({
      orphans: [orphan('job-1')],
      liveJobIds: ['job-1'],
    });

    await run(processor);

    expect(deadCalls).toHaveLength(0);
  });

  test('sorts a mixed batch, and one bad row does not stop the rest', async () => {
    const { processor, deadCalls } = harness({
      orphans: [orphan('job-1'), orphan('job-2'), orphan('job-3')],
      liveJobIds: ['job-2'],
    });

    await run(processor);

    expect(deadCalls.map((c) => c.jobId)).toEqual(['job-1', 'job-3']);
  });

  test('does nothing at all when there are no orphans', async () => {
    const { processor, deadCalls } = harness({ orphans: [] });
    await run(processor);
    expect(deadCalls).toHaveLength(0);
  });
});
