import { UserJobRepository } from '@scani/domain/repositories';
import { RECONCILE_ORPHANED_USER_JOBS_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:reconcile-orphaned-user-jobs');

// Rows younger than this cutoff are still "fresh" — the api may still
// be mid-`queue.add`. Only rows pending longer than this are considered
// orphaned.
const PENDING_CUTOFF_MS = 30 * 1000; // 30s

// Reconcile user_jobs rows stuck in `queued`. The api inserts the
// mirror row BEFORE queue.add(...). If the api crashes between those
// steps the row sits in `queued` forever with no BullMQ entry — `/jobs`
// shows a phantom in-flight job. We don't re-enqueue (user_jobs stores
// only payload_summary, not the full payload, so we can't replay) — we
// mark the row failed and the user retries from the UI.
@Service()
export class ReconcileOrphanedUserJobsProcessor extends ScheduledJobProcessor {
  readonly descriptor = RECONCILE_ORPHANED_USER_JOBS_SCHEDULE;

  protected async handle(): Promise<void> {
    const userJobRepo = Container.get(UserJobRepository);
    const cutoff = new Date(Date.now() - PENDING_CUTOFF_MS);
    const orphans = await userJobRepo.findOrphanedQueued(cutoff);
    if (orphans.length === 0) return;
    logger.warn(
      { count: orphans.length, cutoff: cutoff.toISOString() },
      '🔧 Reconciling orphaned user_jobs rows'
    );
    for (const row of orphans) {
      try {
        await userJobRepo.markFailed(
          row.jobId,
          'Enqueue reconciler: job was never delivered to Redis (api likely crashed between DB insert and queue.add). Retry from the UI.',
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
          { jobId: row.jobId, error: err instanceof Error ? err.message : String(err) },
          'Failed to mark orphaned user_job as failed — will retry next tick'
        );
      }
    }
  }
}
