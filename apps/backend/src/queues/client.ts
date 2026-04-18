import { SCANI_QUEUE } from '@scani/core/queues';
import { createComponentLogger } from '@scani/core/utils/logger';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

const logger = createComponentLogger('queues:client');

let queue: Queue | null = null;

/**
 * Singleton queue client. The boot sequence in apps/backend/src/index.ts
 * calls initQueueClient() immediately after constructing the shared
 * Redis connection; tRPC routers then pull the live Queue via getQueue()
 * when enqueuing background work.
 */
export function initQueueClient(connection: Redis): Queue {
  if (queue) return queue;
  queue = new Queue(SCANI_QUEUE, { connection });
  logger.info({ queue: SCANI_QUEUE }, '📮 BullMQ queue client initialized');
  return queue;
}

export function getQueue(): Queue {
  if (!queue) {
    throw new Error(
      'Queue client not initialized — did you forget to call initQueueClient() at boot?'
    );
  }
  return queue;
}

export async function closeQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}
