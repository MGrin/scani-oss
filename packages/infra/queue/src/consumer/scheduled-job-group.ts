import { withDeadline } from '@scani/deadline';
import { createComponentLogger } from '@scani/logging';
import { withSpan } from '@scani/logging/sentry';
import type { Job } from 'bullmq';
import { Container } from 'typedi';
import type { ScheduledJobGroupDescriptor } from '../core/job-descriptor';
import { JOB_HEARTBEAT_WRITER, type JobHeartbeatWriter } from './job-heartbeat-writer';
import type { ScheduledJobProcessor } from './scheduled-job-processor';

const log = createComponentLogger('queue:scheduled-job-group');

export type StepStatus = 'ok' | 'failed' | 'timed-out' | 'locked' | 'not-today';

export interface StepOutcome {
  status: StepStatus;
  attempts: number;
  durationMs: number;
  error?: string;
}

export interface GroupRunSummary {
  group: string;
  steps: Array<StepOutcome & { name: string }>;
}

interface GroupProgress {
  steps: Record<string, StepOutcome>;
}

export interface GroupRetry {
  attempts: number;
  backoffMs: (failedAttempt: number) => number;
}

// The retry every scheduled job had as a BullMQ job (attempts 3, exponential
// from 5s), now applied per step inside the run so a group never re-runs a
// step that already succeeded.
const DEFAULT_RETRY: GroupRetry = {
  attempts: 3,
  backoffMs: (failedAttempt) => 5000 * 2 ** (failedAttempt - 1),
};

const DEFAULT_STEP_TIMEOUT_MS = 30 * 60 * 1000;

const DONE: ReadonlySet<StepStatus> = new Set(['ok', 'not-today']);

class StepTimeoutError extends Error {}

/**
 * Runs one grouped schedule (SC-1688): its steps in order, each through its
 * own processor's lock, jitter and heartbeat. A failing, timed-out or locked
 * step is recorded and the next one runs. The outcome of every step is written
 * to the job's progress as soon as it is known, so a re-attempt of the same
 * occurrence (a stall, a redeploy) skips what already succeeded. The group
 * itself never throws, so BullMQ never re-runs it as a whole.
 */
export class ScheduledJobGroupProcessor {
  private readonly processors = new Map<string, ScheduledJobProcessor>();
  private readonly retry: GroupRetry;
  private readonly onStepFailure?: (step: string, err: Error, job: Job) => void;

  constructor(
    readonly descriptor: ScheduledJobGroupDescriptor,
    processors: readonly ScheduledJobProcessor[],
    opts: {
      retry?: GroupRetry;
      onStepFailure?: (step: string, err: Error, job: Job) => void;
    } = {}
  ) {
    for (const p of processors) this.processors.set(p.descriptor.name, p);
    const missing = descriptor.steps.filter((s) => !this.processors.has(s.name)).map((s) => s.name);
    if (missing.length > 0) {
      throw new Error(
        `Group '${descriptor.name}' names steps with no processor: ${missing.join(', ')}`
      );
    }
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.onStepFailure = opts.onStepFailure;
  }

  async process(job: Job): Promise<GroupRunSummary> {
    const startedAt = new Date();
    const progress: GroupProgress = { steps: { ...readProgress(job.progress) } };
    const summary: GroupRunSummary = { group: this.descriptor.name, steps: [] };

    for (const step of this.descriptor.steps) {
      const earlier = progress.steps[step.name];
      if (earlier && DONE.has(earlier.status)) {
        summary.steps.push({ name: step.name, ...earlier });
        continue;
      }
      const outcome =
        step.runOn && !step.runOn(startedAt)
          ? { status: 'not-today' as const, attempts: 0, durationMs: 0 }
          : await withSpan({ name: step.name, op: 'queue.step', source: 'task' }, () =>
              this.runStep(step.name, step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS, job)
            );
      progress.steps[step.name] = outcome;
      summary.steps.push({ name: step.name, ...outcome });
      await this.saveProgress(job, progress);
    }

    const failed = summary.steps.filter((s) => s.status === 'failed' || s.status === 'timed-out');
    await this.recordGroupHeartbeat(
      startedAt,
      failed.map((s) => s.name),
      summary.steps.length
    );
    log.info(
      {
        group: this.descriptor.name,
        steps: summary.steps.map((s) => `${s.name}:${s.status}`),
        durationMs: Date.now() - startedAt.getTime(),
      },
      failed.length === 0 ? '✅ Group ran' : '⚠️ Group ran with failed steps'
    );
    return summary;
  }

  private async runStep(name: string, timeoutMs: number, job: Job): Promise<StepOutcome> {
    const processor = this.processors.get(name) as ScheduledJobProcessor;
    const started = Date.now();
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
      try {
        const { ran } = await withDeadline(
          processor.runAsStep(job),
          timeoutMs,
          () => new StepTimeoutError(`step '${name}' passed its ${timeoutMs}ms limit`)
        );
        return {
          status: ran ? 'ok' : 'locked',
          attempts: attempt,
          durationMs: Date.now() - started,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // A timed-out attempt is still running; a second one would race it.
        if (err instanceof StepTimeoutError) {
          this.reportFailure(name, lastError, job);
          return {
            status: 'timed-out',
            attempts: attempt,
            durationMs: Date.now() - started,
            error: lastError.message,
          };
        }
        if (attempt < this.retry.attempts) {
          await new Promise((resolve) => setTimeout(resolve, this.retry.backoffMs(attempt)));
        }
      }
    }
    this.reportFailure(name, lastError as Error, job);
    return {
      status: 'failed',
      attempts: this.retry.attempts,
      durationMs: Date.now() - started,
      error: lastError?.message,
    };
  }

  private reportFailure(step: string, err: Error, job: Job): void {
    log.error({ group: this.descriptor.name, step, err: err.message }, '❌ Group step failed');
    try {
      this.onStepFailure?.(step, err, job);
    } catch (hookErr) {
      log.warn(
        { step, err: hookErr instanceof Error ? hookErr.message : hookErr },
        'Step failure hook threw (ignored)'
      );
    }
  }

  private async saveProgress(job: Job, progress: GroupProgress): Promise<void> {
    try {
      await job.updateProgress(progress as unknown as object);
    } catch (err) {
      // Losing the record only costs re-running steps on a re-attempt;
      // it must not stop the run.
      log.warn(
        { group: this.descriptor.name, err: err instanceof Error ? err.message : err },
        'Group progress write failed (ignored)'
      );
    }
  }

  private async recordGroupHeartbeat(startedAt: Date, failed: string[], total: number) {
    let writer: JobHeartbeatWriter;
    try {
      writer = Container.get(JOB_HEARTBEAT_WRITER);
    } catch {
      return;
    }
    try {
      await writer.record({
        jobName: this.descriptor.name,
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        success: failed.length === 0,
        errorMessage:
          failed.length === 0
            ? undefined
            : `${failed.length} of ${total} steps failed: ${failed.join(', ')}`,
      });
    } catch (err) {
      log.warn(
        { group: this.descriptor.name, err: err instanceof Error ? err.message : err },
        'Group heartbeat write failed (ignored)'
      );
    }
  }
}

function readProgress(progress: unknown): Record<string, StepOutcome> {
  if (progress && typeof progress === 'object' && 'steps' in progress) {
    const steps = (progress as { steps: unknown }).steps;
    if (steps && typeof steps === 'object') return steps as Record<string, StepOutcome>;
  }
  return {};
}
