import { createComponentLogger } from '@scani/logging';
import { Container, Service } from 'typedi';
import type { ScheduledJobDescriptor } from '../core/job-descriptor';
import { QueueClient } from './queue-client';

const log = createComponentLogger('queue:scheduler');

const SCHEDULER_KEY_PREFIX = 'scheduler:';

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

    // Upsert every wanted schedule first.
    //
    // Default keep policy: 100 completed (count cap), 24 h failed (age
    // cap). The previous absolute `removeOnFail: 500` produced
    // pathological states — once 500 failures piled up (e.g. an
    // every-minute reconciler crashing for ~6 h after a botched
    // deploy), the failed set silently truncated and lost the older
    // records. Age-based capping self-heals without ever deleting
    // recent failures.
    for (const d of descriptors) {
      await queue.upsertJobScheduler(
        SCHEDULER_KEY_PREFIX + d.name,
        { pattern: d.cron, tz: d.timezone ?? 'UTC' },
        {
          name: d.name,
          data: {},
          opts: d.defaultOpts ?? {
            removeOnComplete: 100,
            removeOnFail: { age: 24 * 60 * 60 },
          },
        }
      );
      log.info({ name: d.name, pattern: d.cron, tz: d.timezone ?? 'UTC' }, '📅 Scheduled');
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
  }
}
