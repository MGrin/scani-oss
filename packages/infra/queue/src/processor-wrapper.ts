/**
 * Shared wrapper for user-initiated BullMQ processors — domain-free.
 *
 * The wrapper handles:
 *   - zod payload parsing + validation,
 *   - Redis pub/sub publishes (`active` / `progress` / `completed` / `failed`),
 *   - structured logs + timing,
 *   - rethrow on failure so BullMQ honours the retry policy.
 *
 * Domain-specific bits (persisting the `user_jobs` mirror row) are injected
 * via `onLifecycle`, keeping this module free of `@scani/domain` imports.
 */

import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { ZodType } from 'zod';
import type { JobLifecycleState } from './job-events';
import { publishJobEvent } from './job-events';
import { sanitizeResult } from './sanitize-result';

interface MinimalLogger {
  info(message: string): void;
  info(obj: Record<string, unknown>, message?: string): void;
  warn(message: string): void;
  warn(obj: Record<string, unknown>, message?: string): void;
  error(message: string): void;
  error(obj: Record<string, unknown>, message?: string): void;
}

export interface ProcessorContext {
  job: Job;
  /** Publish a progress update (0..1). Best-effort. */
  reportProgress: (progress: number) => Promise<void>;
}

/** Event emitted on every state transition, handed to `onLifecycle`. */
export type LifecycleEvent =
  | { type: 'active'; jobId: string; userId: string; attemptsMade: number }
  | { type: 'progress'; jobId: string; userId: string; progress: number }
  | { type: 'completed'; jobId: string; userId: string; result: unknown }
  | {
      type: 'failed';
      jobId: string;
      userId: string;
      error: string;
      attemptsMade: number;
      attemptsAllowed: number;
    };

export interface CreateProcessorOptions<T extends { userId: string }, R> {
  name: string;
  schema: ZodType<T>;
  publisher: Redis;
  handler: (data: T, ctx: ProcessorContext) => Promise<R>;
  /**
   * Fired on every state transition. The domain typically persists the
   * mirror row here. Errors are logged + swallowed — the DB is
   * authoritative for history, not for the worker's retry policy.
   */
  onLifecycle?: (event: LifecycleEvent) => Promise<void>;
  /** Optional custom logger. Defaults to console-backed silent-fallback shim. */
  logger?: MinimalLogger;
}

function makeLogMethod(kind: 'log' | 'warn' | 'error') {
  return (a: unknown, b?: unknown) => {
    if (typeof a === 'string') console[kind](a);
    else console[kind](b ?? '', a);
  };
}

const consoleLogger: MinimalLogger = {
  info: makeLogMethod('log') as MinimalLogger['info'],
  warn: makeLogMethod('warn') as MinimalLogger['warn'],
  error: makeLogMethod('error') as MinimalLogger['error'],
};

export function createUserJobProcessor<T extends { userId: string }, R>(
  options: CreateProcessorOptions<T, R>
): (job: Job) => Promise<R> {
  const { name, schema, publisher, handler, onLifecycle, logger = consoleLogger } = options;

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
    const jobId = String(job.id);
    const attemptsAllowed = job.opts.attempts ?? 1;
    const attemptsMade = job.attemptsMade + 1;

    // DB write precedes WS publish — inverting order would leak
    // phantom-active events while the durable row still says 'queued'.
    await runLifecycleSilently(
      onLifecycle,
      { type: 'active', jobId, userId: data.userId, attemptsMade },
      logger,
      name
    );
    await publishIgnoringErrors(publisher, data.userId, jobId, logger, {
      state: 'active',
      attemptsMade,
      attemptsAllowed,
    });

    const ctx: ProcessorContext = {
      job,
      reportProgress: async (progress: number) => {
        const clamped = Math.min(1, Math.max(0, progress));
        await job.updateProgress(clamped);
        await runLifecycleSilently(
          onLifecycle,
          { type: 'progress', jobId, userId: data.userId, progress: clamped },
          logger,
          name
        );
        await publishIgnoringErrors(publisher, data.userId, jobId, logger, {
          state: 'progress',
          progress: clamped,
        });
      },
    };

    try {
      const result = await handler(data, ctx);
      const sanitized = sanitizeResult(name, result);
      await runLifecycleSilently(
        onLifecycle,
        { type: 'completed', jobId, userId: data.userId, result: sanitized },
        logger,
        name
      );
      await publishIgnoringErrors(publisher, data.userId, jobId, logger, {
        state: 'completed',
        result: sanitized,
      });
      logger.info(
        { jobId: job.id, name, durationMs: Date.now() - started },
        '✅ User job completed'
      );
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await runLifecycleSilently(
        onLifecycle,
        {
          type: 'failed',
          jobId,
          userId: data.userId,
          error: errorMessage,
          attemptsMade,
          attemptsAllowed,
        },
        logger,
        name
      );
      await publishIgnoringErrors(publisher, data.userId, jobId, logger, {
        state: 'failed',
        error: errorMessage,
        attemptsMade,
        attemptsAllowed,
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

async function runLifecycleSilently(
  handler: CreateProcessorOptions<{ userId: string }, unknown>['onLifecycle'],
  event: LifecycleEvent,
  logger: MinimalLogger,
  name: string
): Promise<void> {
  if (!handler) return;
  try {
    await handler(event);
  } catch (err) {
    logger.error(
      {
        jobId: event.jobId,
        name,
        op: event.type,
        error: err instanceof Error ? err.message : String(err),
      },
      'onLifecycle handler failed — job continues'
    );
  }
}

async function publishIgnoringErrors(
  publisher: Redis,
  userId: string,
  jobId: string,
  logger: MinimalLogger,
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
