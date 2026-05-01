import { createComponentLogger } from '@scani/logging';
import type { Job } from 'bullmq';
import { Container } from 'typedi';
import type { ScheduledJobDescriptor } from '../core/job-descriptor';
import { JOB_LOCK, type JobLock } from './job-lock';

const log = createComponentLogger('queue:scheduled-job-processor');

// Abstract base for cron-triggered processors. Subclasses set
// `readonly descriptor` and implement `handle(job)`. When the
// descriptor sets `lockName`, the base wraps `handle` in `JobLock` —
// two redeploys briefly running in parallel won't both fire pricing
// against the same upstream API budget.
//
// Reconcile-* style sweepers leave `lockName` undefined: they're
// idempotent re-scans and a missed lock is fine.
export abstract class ScheduledJobProcessor {
  abstract readonly descriptor: ScheduledJobDescriptor;

  protected abstract handle(job: Job): Promise<unknown>;

  async process(job: Job): Promise<unknown> {
    const lockName = this.descriptor.lockName;
    if (!lockName) {
      return await this.handle(job);
    }
    const lock = this.tryGetLock();
    if (!lock) {
      // No lock impl wired — run unlocked. OSS / dev mode without a
      // shared Postgres lock falls through here.
      return await this.handle(job);
    }
    const outcome = await lock.withLock(lockName, () => this.handle(job));
    if (!outcome.ran) {
      log.warn(
        { name: this.descriptor.name, lockName },
        '🔒 Skipped — another instance holds the lock'
      );
      return undefined;
    }
    return outcome.result;
  }

  private tryGetLock(): JobLock | null {
    try {
      return Container.get(JOB_LOCK);
    } catch {
      return null;
    }
  }
}
