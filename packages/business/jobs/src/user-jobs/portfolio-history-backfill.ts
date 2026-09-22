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

// Days the rollup walks per step (SC-1283). A 400-day window rolled up in one
// pass ran the 1 GB worker out of memory; each step now writes its rows and
// releases them before the next, and records how far it got.
export const PORTFOLIO_HISTORY_CHUNK_DAYS = 30;

// Where an interrupted run stopped. Written into the job's own data after
// every chunk, so a stalled attempt restarts at the next chunk instead of at
// day 0. `anchor` is the frozen "now" the window was laid out from; a resume
// reuses it so the remaining chunks land on the same day boundaries.
export interface PortfolioHistoryRollupProgress {
  anchor: string;
  nextDayOffset: number;
}

export interface PortfolioHistoryBackfillJob extends UserJobBase {
  // Tokens to backfill historical prices for. Empty array → no-op,
  // since the rollup phase still runs and uses whatever prices exist.
  tokenIds: string[];
  // Days of history to materialize. Manual-create flow uses 365.
  lookbackDays: number;
  rollupProgress?: PortfolioHistoryRollupProgress;
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
  rollupProgress: z
    .object({
      anchor: z.string().datetime(),
      nextDayOffset: z.number().int().min(0),
    })
    .optional(),
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
