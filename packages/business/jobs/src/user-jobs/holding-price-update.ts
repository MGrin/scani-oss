import type { UserJobBase, UserJobDescriptor } from '@scani/queue';
import { z } from 'zod';
import { JOB_NAMES } from '../job-names';

export interface HoldingPriceUpdateJob extends UserJobBase {
  holdingId: string;
  priceUsd: number;
  priceSource: string;
}

export const holdingPriceUpdateSchema: z.ZodType<HoldingPriceUpdateJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
  holdingId: z.string().min(1),
  priceUsd: z.number(),
  priceSource: z.string().min(1),
});

const JOB_ID_SEP = '_';

export const HOLDING_PRICE_UPDATE: UserJobDescriptor<HoldingPriceUpdateJob> = {
  name: JOB_NAMES.holdingPriceUpdate,
  schema: holdingPriceUpdateSchema,
  defaultOpts: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  computeJobId: (d) =>
    [JOB_NAMES.holdingPriceUpdate, d.userId, d.holdingId, d.requestId].join(JOB_ID_SEP),
  summarizePayload: (d) => ({ holdingId: d.holdingId }),
};
