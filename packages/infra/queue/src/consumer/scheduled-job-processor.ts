import { createComponentLogger } from '@scani/logging';
import type { Job } from 'bullmq';
import { Container } from 'typedi';
import type { ScheduledJobDescriptor } from '../core/job-descriptor';
import { JOB_HEARTBEAT_WRITER, type JobHeartbeatWriter } from './job-heartbeat-writer';
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
    await this.applyJitter();
    const lockName = this.descriptor.lockName;
    const startedAt = new Date();
    let success = false;
    let errorMessage: string | undefined;
    try {
      if (!lockName) {
        const result = await this.handle(job);
        success = true;
        return result;
      }
      const lock = this.tryGetLock();
      if (!lock) {
        // No lock impl wired — run unlocked. OSS / dev mode without a
        // shared Postgres lock falls through here.
        const result = await this.handle(job);
        success = true;
        return result;
      }
      const outcome = await lock.withLock(lockName, () => this.handle(job));
      if (!outcome.ran) {
        log.warn(
          { name: this.descriptor.name, lockName },
          '🔒 Skipped — another instance holds the lock'
        );
        // Treat lock-skipped as a non-failure: the OTHER worker that
        // owns the lock will record its own success heartbeat. We
        // don't update the heartbeat here so a stuck worker holding
        // the lock without progress is still detectable.
        return undefined;
      }
      success = true;
      return outcome.result;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      // Record heartbeat for both successful runs and failures (but
      // not for lock-skips above — they early-return with success
      // still false, so the writer correctly captures the failed gap).
      // Skip when we never reached handle() (lock-skip path) by
      // checking that either success was set or an error was thrown.
      if (success || errorMessage !== undefined) {
        await this.recordHeartbeat({
          jobName: this.descriptor.name,
          startedAt,
          durationMs: Date.now() - startedAt.getTime(),
          success,
          errorMessage,
        });
      }
    }
  }

  private async applyJitter(): Promise<void> {
    const jitterMs = this.descriptor.jitterMs;
    if (!jitterMs || jitterMs <= 0) return;
    const wait = Math.floor(Math.random() * jitterMs);
    if (wait <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  private tryGetLock(): JobLock | null {
    try {
      return Container.get(JOB_LOCK);
    } catch {
      return null;
    }
  }

  private tryGetHeartbeatWriter(): JobHeartbeatWriter | null {
    try {
      return Container.get(JOB_HEARTBEAT_WRITER);
    } catch {
      return null;
    }
  }

  private async recordHeartbeat(input: {
    jobName: string;
    startedAt: Date;
    durationMs: number;
    success: boolean;
    errorMessage?: string;
  }): Promise<void> {
    const writer = this.tryGetHeartbeatWriter();
    if (!writer) return;
    try {
      await writer.record(input);
    } catch (err) {
      // Heartbeat write failure must never escape — the actual job
      // either succeeded or already threw. A failed heartbeat is
      // logged and dropped; the next run will overwrite it.
      log.warn(
        { name: this.descriptor.name, err: err instanceof Error ? err.message : err },
        'Heartbeat write failed (ignored)'
      );
    }
  }
}
