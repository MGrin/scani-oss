import type { UserJobBase, UserJobDescriptor } from '@scani/queue';
import { z } from 'zod';
import { JOB_NAMES } from '../job-names';
import { RETRY_HEAVY } from '../retry-policies';

// Days of history a full portfolio-history recompute materializes.
// MUST exceed the longest chart window the UI offers (1Y = 365 days)
// with margin. The rollup loop produces `lookbackDays` calendar days
// ending today, so it reaches back only `lookbackDays - 1` days; the
// 1Y chart requests `today - 365d`. At 365 the chart's oldest point
// landed one day past the rollup's reach and rendered a stale
// pre-recompute row, which the PnL chart's window re-basing then
// anchored the entire curve to. 400 leaves a comfortable buffer.
export const PORTFOLIO_HISTORY_LOOKBACK_DAYS = 400;

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
