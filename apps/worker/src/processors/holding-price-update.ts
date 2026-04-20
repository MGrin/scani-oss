import { HoldingImplementations } from '@scani/domain/features';
import { createComponentLogger } from '@scani/logging';
import type { HoldingPriceUpdateJob } from '@scani/queue';
import { emitEntityChangeFromWorker } from '@scani/realtime/publish';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { createUserJobProcessor } from '../lib/processor-wrapper';

const logger = createComponentLogger('processor:holding-price-update');

const payloadSchema: z.ZodType<HoldingPriceUpdateJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
  holdingId: z.string().min(1),
  priceUsd: z.number(),
  priceSource: z.string().min(1),
});

/**
 * Lock TTL: long enough that a healthy price fetch + vault-recalc
 * finishes inside the window (~5-10s typical), short enough that a
 * crashed worker's lock unblocks the next attempt within the BullMQ
 * retry backoff (2s → 4s → 8s).
 */
const PRICE_LOCK_TTL_MS = 30_000;

/**
 * Redis `SET NX` lock around the price-fetch + vault-recalc pipeline.
 *
 * Race we're preventing: the user clicks "update price" twice in quick
 * succession (or the UI retries after a transient error), two workers
 * pick up the two jobs, both call the pricing providers (wasted RPC +
 * per-provider rate-limit pressure), and both recalculate vaults
 * against intermediate prices. The second write wins on the row, but
 * vault state mid-operation briefly references a price that was never
 * committed.
 *
 * The lock is per-holdingId so independent holdings can update in
 * parallel. On lock contention the processor returns `{ skipped: true }`
 * so BullMQ marks the job succeeded — the job that holds the lock will
 * emit the realtime update, and the user doesn't need two responses.
 */
async function acquireLock(redis: Redis, holdingId: string): Promise<boolean> {
  const key = `lock:holding-price:${holdingId}`;
  // ioredis typings: `set(key, value, 'PX', ttlMs, 'NX')` → 'OK' | null.
  const result = await redis.set(key, '1', 'PX', PRICE_LOCK_TTL_MS, 'NX');
  return result === 'OK';
}

async function releaseLock(redis: Redis, holdingId: string): Promise<void> {
  try {
    await redis.del(`lock:holding-price:${holdingId}`);
  } catch (err) {
    // Best-effort: TTL expiry will clean up if Redis is degraded.
    logger.warn(
      { holdingId, error: err instanceof Error ? err.message : String(err) },
      'Failed to release price-update lock — TTL will expire'
    );
  }
}

export function buildHoldingPriceUpdateProcessor(publisher: Redis): (job: Job) => Promise<unknown> {
  return createUserJobProcessor({
    name: 'holding-price-update',
    schema: payloadSchema,
    publisher,
    handler: async (data) => {
      const acquired = await acquireLock(publisher, data.holdingId);
      if (!acquired) {
        logger.info(
          { holdingId: data.holdingId, userId: data.userId },
          'Price update already in progress — skipping duplicate'
        );
        return { skipped: true, reason: 'lock-contention' };
      }

      try {
        const result = await HoldingImplementations.updatePrice(
          { userId: data.userId },
          { id: data.holdingId }
        );
        await emitEntityChangeFromWorker(publisher, {
          entityType: 'holding',
          operationType: 'update',
          entityId: data.holdingId,
          userId: data.userId,
        });
        return result;
      } finally {
        await releaseLock(publisher, data.holdingId);
      }
    },
  });
}
