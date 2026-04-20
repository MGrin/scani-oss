import { UserJobRepository } from '@scani/domain/repositories';
import { createComponentLogger } from '@scani/logging';
import type { Job, Queue } from 'bullmq';
import { Container } from 'typedi';

const logger = createComponentLogger('processor:reconcile-orphaned-user-jobs');

/**
 * Rows younger than this cutoff are still "fresh" — the backend may still
 * be mid-`queue.add`. Only rows that have been pending longer than this
 * are considered orphaned.
 */
const PENDING_CUTOFF_MS = 30 * 1000; // 30s

/**
 * Reconcile `user_jobs` rows stuck in `queued` state.
 *
 * Scenario: the backend's `enqueueJob` helper inserts the mirror row
 * BEFORE calling `queue.add(...)` so the worker's lifecycle writes always
 * find their target. If the backend process crashes between those two
 * steps the row sits in `queued` forever with no BullMQ entry — the `/jobs`
 * UI shows a phantom in-flight job and the top-nav badge never
 * decrements.
 *
 * This processor scans for such rows and marks them `failed` with a
 * human-readable reason so the UI surfaces the failure. We deliberately
 * don't re-enqueue: `user_jobs` stores only `payload_summary`, not the
 * full job payload, so we have nothing to replay. The user sees "enqueue
 * failed" and can retry from the UI.
 */
export function buildReconcileOrphanedUserJobsProcessor(_queue: Queue) {
  return async function processReconcileOrphanedUserJobs(_job: Job): Promise<void> {
    const userJobRepo = Container.get(UserJobRepository);

    const cutoff = new Date(Date.now() - PENDING_CUTOFF_MS);
    const orphans = await userJobRepo.findOrphanedQueued(cutoff);

    if (orphans.length === 0) {
      return;
    }

    logger.warn(
      { count: orphans.length, cutoff: cutoff.toISOString() },
      '🔧 Reconciling orphaned user_jobs rows'
    );

    for (const row of orphans) {
      try {
        await userJobRepo.markFailed(
          row.jobId,
          'Enqueue reconciler: job was never delivered to Redis (backend likely crashed between DB insert and queue.add). Retry from the UI.',
          {
            attemptsMade: 0,
            attemptsAllowed: row.attemptsAllowed,
          }
        );
        logger.info(
          { jobId: row.jobId, jobName: row.jobName, userId: row.userId },
          'Marked orphaned user_job as failed'
        );
      } catch (err) {
        logger.error(
          {
            jobId: row.jobId,
            error: err instanceof Error ? err.message : String(err),
          },
          'Failed to mark orphaned user_job as failed — will retry next tick'
        );
      }
    }
  };
}
