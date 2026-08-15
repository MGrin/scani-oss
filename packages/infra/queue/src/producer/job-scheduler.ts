import { createComponentLogger } from '@scani/logging';
import type { JobsOptions } from 'bullmq';
import { Container, Service } from 'typedi';
import type { ScheduledJobDescriptor } from '../core/job-descriptor';
import { QueueClient } from './queue-client';

const log = createComponentLogger('queue:scheduler');

const SCHEDULER_KEY_PREFIX = 'scheduler:';

// Default keep policy: 100 completed (count cap), 24 h failed (age cap).
// The previous absolute `removeOnFail: 500` produced pathological states —
// once 500 failures piled up (e.g. an every-minute reconciler crashing for
// ~6 h after a botched deploy), the failed set silently truncated and lost
// the older records. Age-based capping self-heals without ever deleting
// recent failures.
const DEFAULT_SCHEDULED_JOB_OPTS: JobsOptions = {
  removeOnComplete: 100,
  removeOnFail: { age: 24 * 60 * 60 },
  // Repeatable jobs had no attempts (BullMQ default 1), so a single
  // transient Neon CONNECTION_CLOSED dead-lettered immediately. Retry
  // long enough to outlast a serverless cold start.
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
};

// Registers BullMQ repeatable schedules from a list of descriptors and
// reconciles orphans (deletes any scheduler not in the current list).
//
// Today's worker calls `upsertJobScheduler` per redeploy but never
// removes deleted schedulers — they keep firing forever. `upsertAll`
// is the reconcile-or-die alternative.
@Service()
export class JobScheduler {
  private readonly queueClient = Container.get(QueueClient);

  async upsertAll(descriptors: readonly ScheduledJobDescriptor[]): Promise<void> {
    const queue = this.queueClient.get();
    const wantedKeys = new Set(descriptors.map((d) => SCHEDULER_KEY_PREFIX + d.name));

    // Snapshot the armed occurrence of every scheduler BEFORE upserting.
    // `upsertJobScheduler` deletes whatever job the scheduler currently has
    // parked in delayed/prioritized/wait and re-arms from `now` (see
    // `addJobScheduler` in bullmq), so an occurrence that came due while no
    // worker was alive is destroyed here — no error, no heartbeat, no retry.
    // Deploys replace the worker machine, so any deploy landing on a job's
    // cron minute silently eats that night's run.
    const armedBefore = new Map<string, number>();
    for (const existing of await queue.getJobSchedulers()) {
      if (existing.key && typeof existing.next === 'number') {
        armedBefore.set(existing.key, existing.next);
      }
    }

    const upsertStartedAt = Date.now();
    const missed: Array<{ descriptor: ScheduledJobDescriptor; dueAt: number }> = [];

    for (const d of descriptors) {
      const key = SCHEDULER_KEY_PREFIX + d.name;
      await queue.upsertJobScheduler(
        key,
        { pattern: d.cron, tz: d.timezone ?? 'UTC' },
        { name: d.name, data: {}, opts: d.defaultOpts ?? DEFAULT_SCHEDULED_JOB_OPTS }
      );
      log.info({ name: d.name, pattern: d.cron, tz: d.timezone ?? 'UTC' }, '📅 Scheduled');

      const dueAt = armedBefore.get(key);
      if (dueAt !== undefined && dueAt <= upsertStartedAt) {
        missed.push({ descriptor: d, dueAt });
      }
    }

    // Reconcile: drop any scheduler that's no longer in the descriptor
    // list. Without this, removing a job from source leaves the BullMQ
    // scheduler firing forever — which then routes to a missing
    // processor and fails every minute.
    const existing = await queue.getJobSchedulers();
    for (const job of existing) {
      const key = job.key;
      if (!key || wantedKeys.has(key)) continue;
      if (!key.startsWith(SCHEDULER_KEY_PREFIX)) continue;
      try {
        await queue.removeJobScheduler(key);
        log.warn({ key }, '🗑️  Removed orphaned scheduler');
      } catch (err) {
        log.error(
          { key, error: err instanceof Error ? err.message : String(err) },
          'Failed to remove orphaned scheduler'
        );
      }
    }

    await this.replayMissed(missed);
  }

  // Re-enqueue each occurrence the upsert above destroyed. The job id is
  // derived from the missed fire time so two machines booting off the same
  // rolling deploy converge on one job rather than double-running (BullMQ
  // ignores an add whose custom id already exists — and rejects ids
  // containing a colon, hence the dashes).
  private async replayMissed(
    missed: ReadonlyArray<{ descriptor: ScheduledJobDescriptor; dueAt: number }>
  ): Promise<void> {
    if (missed.length === 0) return;
    const queue = this.queueClient.get();
    for (const { descriptor, dueAt } of missed) {
      const jobId = `catchup-${descriptor.name}-${dueAt}`;
      try {
        await queue.add(
          descriptor.name,
          {},
          { ...(descriptor.defaultOpts ?? DEFAULT_SCHEDULED_JOB_OPTS), jobId }
        );
        log.warn(
          { name: descriptor.name, dueAt: new Date(dueAt).toISOString(), jobId },
          '⏪ Replaying scheduled run that came due while no worker was running'
        );
      } catch (err) {
        // A failed replay must not abort registration of the remaining
        // schedules — a worker with no schedules is far worse than one
        // missed catch-up.
        log.error(
          { name: descriptor.name, jobId, error: err instanceof Error ? err.message : String(err) },
          'Failed to replay missed scheduled run'
        );
      }
    }
  }
}
