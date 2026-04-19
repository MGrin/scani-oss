/**
 * Shared wrapper for user-initiated BullMQ processors.
 *
 * Handles the parts that every user-job processor needs:
 *   - zod parse the payload (typed + validated at the boundary),
 *   - publish `active` / `progress` / `completed` / `failed` events over
 *     Redis pub/sub so the frontend's job-status hook updates the modal,
 *   - timing + structured logs,
 *   - rethrow on failure so BullMQ honours the retry policy.
 *
 * Scheduled jobs (no `userId` in payload) do not use this wrapper — they
 * run via plain functions from `@scani/cron`.
 */

import type { JobLifecycleState } from '@scani/core/queues/job-events';
import { publishJobEvent } from '@scani/core/queues/job-events';
import { createComponentLogger } from '@scani/core/utils/logger';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { ZodType } from 'zod';

const logger = createComponentLogger('worker:processor');

export interface ProcessorContext {
  job: Job;
  /** Publish a progress update (0..1). Best-effort. */
  reportProgress: (progress: number) => Promise<void>;
}

export interface CreateProcessorOptions<T extends { userId: string }, R> {
  name: string;
  schema: ZodType<T>;
  publisher: Redis;
  handler: (data: T, ctx: ProcessorContext) => Promise<R>;
}

export function createUserJobProcessor<T extends { userId: string }, R>(
  options: CreateProcessorOptions<T, R>
): (job: Job) => Promise<R> {
  const { name, schema, publisher, handler } = options;

  return async (job: Job): Promise<R> => {
    const started = Date.now();
    const parseResult = schema.safeParse(job.data);
    if (!parseResult.success) {
      const issues = parseResult.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      const errMessage = `Invalid payload for job '${name}' (id=${job.id}): ${issues}`;
      logger.error({ jobId: job.id, name, issues }, '❌ Payload validation failed');
      // Can't publish — we don't have a userId.
      throw new Error(errMessage);
    }
    const data = parseResult.data;

    await publishIgnoringErrors(publisher, data.userId, String(job.id), {
      state: 'active',
      attemptsMade: job.attemptsMade + 1,
      attemptsAllowed: job.opts.attempts ?? 1,
    });

    const ctx: ProcessorContext = {
      job,
      reportProgress: async (progress: number) => {
        const clamped = Math.min(1, Math.max(0, progress));
        await job.updateProgress(clamped);
        await publishIgnoringErrors(publisher, data.userId, String(job.id), {
          state: 'progress',
          progress: clamped,
        });
      },
    };

    try {
      const result = await handler(data, ctx);
      await publishIgnoringErrors(publisher, data.userId, String(job.id), {
        state: 'completed',
        result,
      });
      logger.info(
        { jobId: job.id, name, durationMs: Date.now() - started },
        '✅ User job completed'
      );
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await publishIgnoringErrors(publisher, data.userId, String(job.id), {
        state: 'failed',
        error: errorMessage,
        attemptsMade: job.attemptsMade + 1,
        attemptsAllowed: job.opts.attempts ?? 1,
      });
      logger.error(
        {
          jobId: job.id,
          name,
          error: errorMessage,
          durationMs: Date.now() - started,
        },
        '❌ User job failed'
      );
      throw err;
    }
  };
}

async function publishIgnoringErrors(
  publisher: Redis,
  userId: string,
  jobId: string,
  payload: {
    state: JobLifecycleState;
    progress?: number;
    result?: unknown;
    error?: string;
    attemptsMade?: number;
    attemptsAllowed?: number;
  }
): Promise<void> {
  try {
    await publishJobEvent(publisher, userId, jobId, payload);
  } catch (err) {
    logger.warn(
      { jobId, userId, error: err instanceof Error ? err.message : String(err) },
      'Failed to publish job event — best-effort, continuing'
    );
  }
}
