import { UserJobRepository } from '@scani/domain/repositories';
import { RECONCILE_ORPHANED_USER_JOBS_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { QueueClient, ScheduledJobProcessor } from '@scani/queue';
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
// mark the row dead and the user starts it again from the UI.
@Service()
export class ReconcileOrphanedUserJobsProcessor extends ScheduledJobProcessor {
  readonly descriptor = RECONCILE_ORPHANED_USER_JOBS_SCHEDULE;

  protected async handle(): Promise<void> {
    const userJobRepo = Container.get(UserJobRepository);
    const queue = Container.get(QueueClient).get();
    const cutoff = new Date(Date.now() - PENDING_CUTOFF_MS);
    const orphans = await userJobRepo.findOrphanedQueued(cutoff);
    if (orphans.length === 0) return;
    logger.warn(
      { count: orphans.length, cutoff: cutoff.toISOString() },
      '🔧 Reconciling orphaned user_jobs rows'
    );
    for (const row of orphans) {
      try {
        // "Queued for more than 30s" is not the same claim as "never
        // delivered" — a job can sit in the waiting set that long simply
        // because every slot is busy, and this processor's whole output is a
        // *terminal* verdict now (SC-153). Ask the queue before declaring one:
        // if BullMQ still holds the job, the row is behind, not orphaned.
        const live = await queue.getJob(row.jobId);
        if (live) continue;

        const marked = await userJobRepo.markDead(row.jobId, {
          reason: 'never_delivered',
          error:
            'Enqueue reconciler: job was never delivered to the queue (api likely crashed between DB insert and queue.add). Nothing ran; start it again from where you began it.',
          attemptsMade: 0,
          attemptsAllowed: row.attemptsAllowed,
        });
        if (!marked) continue;
        logger.info(
          { jobId: row.jobId, jobName: row.jobName, userId: row.userId },
          'Marked orphaned user_job as dead'
        );
      } catch (err) {
        logger.error(
          { jobId: row.jobId, error: err instanceof Error ? err.message : String(err) },
          'Failed to mark orphaned user_job as dead — will retry next tick'
        );
      }
    }
  }
}
