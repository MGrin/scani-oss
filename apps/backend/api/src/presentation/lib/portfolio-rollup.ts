import { PORTFOLIO_HISTORY_BACKFILL, PORTFOLIO_HISTORY_LOOKBACK_DAYS } from '@scani/jobs';
import { BullMqEnqueueService } from '@scani/queue';
import { Container } from 'typedi';

// Coalesce window for mutation-triggered rollups. A user mass-deleting
// holdings/accounts or rapid-firing balance edits should land ONE
// rollup, not many racing on portfolio_value_daily writes. The
// requestId is bucketed by 30-second wall-clock floor; BullMQ's
// computeJobId uses (userId + requestId), so all calls inside the
// same 30s window dedup to a single jobId and BullMQ.add() becomes a
// no-op for the duplicates.
const ROLLUP_COALESCE_WINDOW_MS = 30_000;

/**
 * Re-trigger the per-user portfolio rollup after a mutation that
 * affects what counts toward the user's net worth (holdings or
 * accounts created/updated/deleted). Without this, the
 * `portfolio_value_daily` cache stays stale — the chart keeps showing
 * pre-mutation totals because no rollup has re-run against current
 * state. Failure is non-fatal: the nightly cron + the next mutation
 * will catch up. Empty `tokenIds` means "no specific token filter" —
 * the rollup phase always runs regardless and recomputes every cached
 * day in the lookback window.
 */
export async function enqueuePortfolioRollup(userId: string): Promise<void> {
  const bucket = Math.floor(Date.now() / ROLLUP_COALESCE_WINDOW_MS);
  const requestId = `mutation-${bucket}`;
  try {
    await Container.get(BullMqEnqueueService).add(PORTFOLIO_HISTORY_BACKFILL, {
      userId,
      requestId,
      tokenIds: [],
      lookbackDays: PORTFOLIO_HISTORY_LOOKBACK_DAYS,
    });
  } catch {
    // swallow — nightly cron + next mutation will catch up.
  }
}
