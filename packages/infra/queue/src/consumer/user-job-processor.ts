import { createComponentLogger } from '@scani/logging';
import type { Job } from 'bullmq';
import { Container } from 'typedi';
import type { UserJobDescriptor } from '../core/job-descriptor';
import { ResultTruncator } from '../core/result-truncator';
import type { JobEventPayload, LifecycleEvent, ProcessorContext, UserJobBase } from '../core/types';
import { RedisLifecyclePublisher } from '../lifecycle/redis-lifecycle-publisher';
import { LIFECYCLE_MIRROR, type LifecycleMirror } from './lifecycle-mirror';

const log = createComponentLogger('queue:user-job-processor');

// Abstract base for user-initiated processors. Subclasses set
// `readonly descriptor` (the per-job catalog entry) and implement
// `handle(data, ctx)` — everything else (zod validation, lifecycle
// publish, error reporting, result truncation) is owned by the base.
//
// CRITICAL: `process()` re-throws caught errors WITHOUT wrapping so
// BullMQ's `UnrecoverableError` retains its instanceof identity. Wrapping
// would break BullMQ's retry-policy detection.
export abstract class UserJobProcessor<TPayload extends UserJobBase, TResult = unknown> {
  abstract readonly descriptor: UserJobDescriptor<TPayload, TResult>;

  protected abstract handle(data: TPayload, ctx: ProcessorContext): Promise<TResult>;

  async process(job: Job): Promise<TResult> {
    const parseResult = this.descriptor.schema.safeParse(job.data);
    if (!parseResult.success) {
      const issues = parseResult.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      const msg = `Invalid payload for job '${this.descriptor.name}' (id=${job.id}): ${issues}`;
      log.error(
        { jobId: job.id, name: this.descriptor.name, issues },
        '❌ Payload validation failed'
      );
      throw new Error(msg);
    }
    const data = parseResult.data;
    const jobId = String(job.id);
    const attemptsAllowed = (job.opts.attempts as number | undefined) ?? 1;
    const attemptsMade = job.attemptsMade + 1;

    // DB write before WS publish — inverting would leak phantom-active
    // events while the durable mirror still reads 'queued'.
    await this.fire({
      type: 'active',
      jobId,
      userId: data.userId,
      jobName: this.descriptor.name,
      attemptsMade,
    });
    await this.publish(data.userId, jobId, { state: 'active', attemptsMade, attemptsAllowed });

    const ctx: ProcessorContext = {
      job,
      reportProgress: async (progress: number) => {
        const clamped = Math.min(1, Math.max(0, progress));
        await job.updateProgress(clamped);
        await this.fire({
          type: 'progress',
          jobId,
          userId: data.userId,
          jobName: this.descriptor.name,
          progress: clamped,
        });
        await this.publish(data.userId, jobId, { state: 'progress', progress: clamped });
      },
    };

    try {
      const result = await this.handle(data, ctx);
      const sanitized = this.descriptor.sanitizeResult
        ? this.descriptor.sanitizeResult(result)
        : new ResultTruncator().truncate(result);
      await this.fire({
        type: 'completed',
        jobId,
        userId: data.userId,
        jobName: this.descriptor.name,
        result: sanitized,
      });
      await this.publish(data.userId, jobId, { state: 'completed', result: sanitized });
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await this.fire({
        type: 'failed',
        jobId,
        userId: data.userId,
        jobName: this.descriptor.name,
        error: errorMessage,
        attemptsMade,
        attemptsAllowed,
      });
      await this.publish(data.userId, jobId, {
        state: 'failed',
        error: errorMessage,
        attemptsMade,
        attemptsAllowed,
      });
      throw err;
    }
  }

  private async fire(event: LifecycleEvent): Promise<void> {
    const mirror = this.tryGetMirror();
    if (!mirror) return;
    try {
      await mirror.onLifecycle(event);
    } catch (err) {
      log.error(
        {
          jobId: event.jobId,
          name: event.jobName,
          op: event.type,
          error: err instanceof Error ? err.message : String(err),
        },
        'LifecycleMirror handler failed — job continues'
      );
    }
  }

  private async publish(userId: string, jobId: string, payload: JobEventPayload): Promise<void> {
    try {
      await Container.get(RedisLifecyclePublisher).publish(userId, jobId, payload);
    } catch (err) {
      log.warn(
        { jobId, userId, error: err instanceof Error ? err.message : String(err) },
        'Failed to publish job event — best-effort'
      );
    }
  }

  private tryGetMirror(): LifecycleMirror | null {
    try {
      return Container.get(LIFECYCLE_MIRROR);
    } catch {
      return null;
    }
  }
}
