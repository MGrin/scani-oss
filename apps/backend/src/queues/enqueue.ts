/**
 * Composition root for user-job enqueue — pairs the generic
 * `createEnqueue` (in `@scani/queue`) with the backend's
 * `UserJobRepository` writes. The business logic (deterministic jobId,
 * dedup, retry policy, payload summarization) lives in the queue
 * package; this file just wires those hooks to domain state.
 */

import { UserJobRepository } from '@scani/domain/repositories';
import { createEnqueue } from '@scani/queue/enqueue';
import Container from 'typedi';
import { getQueue } from './client';

export { computeJobId } from '@scani/queue/enqueue';

function userJobRepo(): UserJobRepository {
  return Container.get(UserJobRepository);
}

export const enqueueJob = createEnqueue({
  getQueue,
  // Persist the mirror row BEFORE enqueue so the worker's lifecycle writes
  // always find their target. Idempotent on jobId (onConflictDoNothing)
  // because BullMQ dedupes re-adds with the same jobId — the second
  // enqueue call must not 409 on the row insert.
  onEnqueued: async (job) => {
    await userJobRepo().insertEnqueued({
      jobId: job.jobId,
      userId: job.userId,
      jobName: job.jobName,
      payloadSummary: job.payloadSummary,
      attemptsAllowed: job.attemptsAllowed,
    });
  },
  // Record enqueue failures on the row so the UI can surface them instead
  // of leaving a phantom `queued` row.
  onEnqueueFailed: async (jobId, err, meta) => {
    await userJobRepo().markFailed(jobId, err.message, {
      attemptsMade: 0,
      attemptsAllowed: meta.attemptsAllowed,
    });
  },
});
