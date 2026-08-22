import { createComponentLogger } from '@scani/logging';
import { type Job, UnrecoverableError } from 'bullmq';
import { Container } from 'typedi';
import type { UserJobDescriptor } from '../core/job-descriptor';
import {
  DURABLE_RESULT_MAX_BYTES,
  ResultTruncator,
  readTruncationNotice,
  WIRE_RESULT_MAX_BYTES,
} from '../core/result-truncator';
import type { JobEventPayload, LifecycleEvent, ProcessorContext, UserJobBase } from '../core/types';
import { userFacingMessage } from '../core/user-facing';
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

    // Cancellation gate. BullMQ v6 removed `Job#discard()`, which is what the
    // cancel route used to stop an ACTIVE job from retrying — an active job
    // cannot be removed from the queue, so `remove()` throws and `discard()`
    // was the only lever. User jobs retry for real (`transaction-import` has
    // `attempts: 4`), so losing it would mean a cancelled import runs again,
    // side effects and all, after the user asked it to stop.
    //
    // Asking the durable mirror is stronger than `discard()` was: it aborts
    // this attempt too, not just the retries. `UnrecoverableError` is what
    // tells BullMQ not to schedule another one.
    const cancelMirror = this.tryGetMirror();
    if (await cancelMirror?.isCancelled?.(jobId)) {
      log.info({ jobId, name: this.descriptor.name }, '🛑 Job cancelled by owner — not running');
      throw new UnrecoverableError(`Job ${jobId} was cancelled by its owner`);
    }
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
      reportStatus: async (message: string) => {
        // BullMQ `updateProgress` accepts string|object as well as
        // number; passing the message through means the queue admin
        // dashboard also surfaces the latest phase.
        await job.updateProgress({ statusMessage: message });
        await this.fire({
          type: 'progress',
          jobId,
          userId: data.userId,
          jobName: this.descriptor.name,
          progress: 0,
          statusMessage: message,
        });
        await this.publish(data.userId, jobId, { state: 'progress', statusMessage: message });
      },
    };

    try {
      const result = await this.handle(data, ctx);
      // Two copies, two budgets. The durable row is what the review UI
      // reads and what a confirm mutation replays from, so it holds the
      // real payload; the WS copy only has to survive until the page
      // refetches, and pushing a megabyte of wallet candidates at every
      // open tab is what the 32 KB cap was actually protecting against.
      // Sharing one budget between them is what made a 2,766-token
      // wallet unimportable (SC-145).
      const durable = this.descriptor.sanitizeResult
        ? this.descriptor.sanitizeResult(result)
        : new ResultTruncator(DURABLE_RESULT_MAX_BYTES).truncate(result);
      const wire = new ResultTruncator(WIRE_RESULT_MAX_BYTES).truncate(durable);
      // The DURABLE budget being hit is a different event from the wire one
      // and the only one worth a log line. The wire copy is trimmed on almost
      // every wallet import by design; the durable copy is what the review UI
      // renders and what `confirmHoldings` replays, so dropping a field there
      // means a user cannot import something — the SC-145 failure, one size
      // up. It was silent: the omission was recorded in the user's own row
      // and nowhere else, so "no one has hit 2 MB yet" was an assumption
      // rather than an observation.
      //
      // SC-155 weighed moving these payloads out of the row entirely and
      // decided against it at this scale; this is the trigger that would
      // reopen that. Deferring a decision without an alarm attached is how it
      // gets deferred forever.
      const dropped = readTruncationNotice(durable);
      if (dropped) {
        log.warn(
          {
            jobId,
            userId: data.userId,
            name: this.descriptor.name,
            omittedFields: dropped.omittedFields,
            originalBytes: dropped.originalBytes,
            maxBytes: DURABLE_RESULT_MAX_BYTES,
          },
          'Durable job result exceeded its budget — fields dropped (SC-155)'
        );
      }
      await this.fire({
        type: 'completed',
        jobId,
        userId: data.userId,
        jobName: this.descriptor.name,
        result: durable,
      });
      await this.publish(data.userId, jobId, { state: 'completed', result: wire });
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      // Two audiences, two values, and the split is the whole point (SC-551).
      //
      // `fire` carries the RAW message to the durable row. That is not an
      // oversight to tidy up later: `user_jobs.error` is rendered by the admin
      // user-jobs page, and BullMQ keeps its own `failed_reason` for the queue
      // and DLQ pages. Redacting here would fix the product surface by blinding
      // the people whose job is to read these.
      //
      // `publish` goes over Redis pub/sub to that one user's browser. No
      // operator ever reads a WS frame, so it carries only what a processor
      // marked `userFacing(...)`. Unmarked, the client shows the translated
      // failure category (`jobFailureSentence`, SC-424) and no internal text.
      const ownerMessage = userFacingMessage(err);
      await this.fire({
        type: 'failed',
        jobId,
        userId: data.userId,
        jobName: this.descriptor.name,
        error: errorMessage,
        userFacingError: ownerMessage,
        attemptsMade,
        attemptsAllowed,
      });
      await this.publish(data.userId, jobId, {
        state: 'failed',
        error: ownerMessage ?? undefined,
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
