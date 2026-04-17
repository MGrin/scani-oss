import type { ExchangeSyncPayload, WalletImportPayload } from '@scani/core/queues';
import { JOB_NAMES, SCANI_QUEUE } from '@scani/core/queues';
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

// --- Typed enqueue helpers --------------------------------------------------

const JOB_OPTS = {
  removeOnComplete: 100,
  removeOnFail: 500,
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
};

export async function enqueueWalletImport(payload: WalletImportPayload): Promise<string> {
  const job = await getQueue().add(JOB_NAMES.walletImport, payload, JOB_OPTS);
  return String(job.id ?? '');
}

export async function enqueueExchangeSync(payload: ExchangeSyncPayload): Promise<string> {
  const job = await getQueue().add(JOB_NAMES.exchangeSync, payload, JOB_OPTS);
  return String(job.id ?? '');
}
