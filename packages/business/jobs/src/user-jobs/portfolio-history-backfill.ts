import type { UserJobBase, UserJobDescriptor } from '@scani/queue';
import { z } from 'zod';
import { JOB_NAMES } from '../job-names';
import { RETRY_HEAVY } from '../retry-policies';

export interface PortfolioHistoryBackfillJob extends UserJobBase {
  // Tokens to backfill historical prices for. Empty array → no-op,
  // since the rollup phase still runs and uses whatever prices exist.
  tokenIds: string[];
  // Days of history to materialize. Manual-create flow uses 365.
  lookbackDays: number;
}

export const portfolioHistoryBackfillSchema: z.ZodType<PortfolioHistoryBackfillJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
  tokenIds: z.array(z.string().uuid()),
  lookbackDays: z
    .number()
    .int()
    .min(1)
    .max(365 * 10),
});

export const PORTFOLIO_HISTORY_BACKFILL: UserJobDescriptor<PortfolioHistoryBackfillJob> = {
  name: JOB_NAMES.portfolioHistoryBackfill,
  schema: portfolioHistoryBackfillSchema,
  defaultOpts: {
    ...RETRY_HEAVY,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  computeJobId: (d) => [JOB_NAMES.portfolioHistoryBackfill, d.userId, d.requestId].join('_'),
  summarizePayload: (d) => ({
    tokenCount: d.tokenIds.length,
    lookbackDays: d.lookbackDays,
  }),
};
