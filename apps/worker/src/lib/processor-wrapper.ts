/**
 * Composition root for user-job processors — pairs the generic
 * `createUserJobProcessor` (in `@scani/queue`) with the worker's
 * `UserJobRepository` lifecycle writes.
 *
 * The wrapper in `@scani/queue` handles payload validation, WS publishes,
 * structured logs, and retry rethrow. The `onLifecycle` hook here is the
 * only domain-specific piece — it mirrors every state transition into the
 * `user_jobs` table so the `/jobs` UI has durable history.
 */

import { UserJobRepository } from '@scani/domain/repositories';
import { createComponentLogger } from '@scani/logging';
import {
  createUserJobProcessor,
  type ProcessorContext,
  type CreateProcessorOptions as QueueCreateProcessorOptions,
} from '@scani/queue/processor-wrapper';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import Container from 'typedi';
import type { ZodType } from 'zod';

const logger = createComponentLogger('worker:processor');

function userJobRepo(): UserJobRepository {
  return Container.get(UserJobRepository);
}

export type { ProcessorContext };

export interface CreateProcessorOptions<T extends { userId: string }, R>
  extends Omit<QueueCreateProcessorOptions<T, R>, 'onLifecycle' | 'logger'> {}

export function createUserJobProcessorForWorker<T extends { userId: string }, R>(
  options: CreateProcessorOptions<T, R>
): (job: Job) => Promise<R> {
  return createUserJobProcessor<T, R>({
    ...options,
    logger,
    onLifecycle: async (event) => {
      switch (event.type) {
        case 'active':
          await userJobRepo().markActive(event.jobId, event.attemptsMade);
          return;
        case 'progress':
          await userJobRepo().updateProgress(event.jobId, event.progress);
          return;
        case 'completed':
          await userJobRepo().markCompleted(event.jobId, event.result);
          return;
        case 'failed':
          await userJobRepo().markFailed(event.jobId, event.error, {
            attemptsMade: event.attemptsMade,
            attemptsAllowed: event.attemptsAllowed,
          });
          return;
      }
    },
  });
}

/**
 * Back-compat alias so existing worker processors don't need to change
 * their imports.
 */
export { createUserJobProcessorForWorker as createUserJobProcessor };

/** Keep a parallel helper for schemas/types used by worker processors. */
export type ProcessorSchema<T> = ZodType<T>;
export type ProcessorPublisher = Redis;
