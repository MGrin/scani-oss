import { HoldingImplementations } from '@scani/core/features/implementations';
import type { HoldingPriceUpdateJob } from '@scani/core/queues';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { emitEntityChangeFromWorker } from '../lib/emit-entity-change';
import { createUserJobProcessor } from '../lib/processor-wrapper';

const payloadSchema: z.ZodType<HoldingPriceUpdateJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
  holdingId: z.string().min(1),
  priceUsd: z.number(),
  priceSource: z.string().min(1),
});

export function buildHoldingPriceUpdateProcessor(publisher: Redis): (job: Job) => Promise<unknown> {
  return createUserJobProcessor({
    name: 'holding-price-update',
    schema: payloadSchema,
    publisher,
    handler: async (data) => {
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
    },
  });
}
