import { db } from '@scani/db/connection';
import { PortfolioValueCache } from '@scani/domain/services';
import { PORTFOLIO_HISTORY_BACKFILL, PORTFOLIO_HISTORY_LOOKBACK_DAYS } from '@scani/jobs';
import { BullMqEnqueueService } from '@scani/queue';
import { sql } from 'drizzle-orm';
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
  // Drop the user's cached live valuation so the next read recomputes
  // against current holdings instead of serving a pre-mutation total.
  await Container.get(PortfolioValueCache).bust(userId);

  try {
    const [history] = await db.execute<{ days: number }>(sql`
      SELECT greatest(${PORTFOLIO_HISTORY_LOOKBACK_DAYS}, coalesce(current_date - min(day)::date + 2, 0))::integer AS days FROM (
        SELECT occurred_at::date AS day FROM holding_transactions WHERE user_id = ${userId}
        UNION ALL SELECT observed_at::date FROM holding_balance_observations WHERE user_id = ${userId}
        UNION ALL SELECT snapshot_date FROM portfolio_value_daily WHERE user_id = ${userId}
      ) history
    `);
    const lookbackDays = Number(history?.days ?? PORTFOLIO_HISTORY_LOOKBACK_DAYS);
    const bucket = Math.floor(Date.now() / ROLLUP_COALESCE_WINDOW_MS);
    const requestId = `mutation-${bucket}-${lookbackDays}`;
    await Container.get(BullMqEnqueueService).add(PORTFOLIO_HISTORY_BACKFILL, {
      userId,
      requestId,
      tokenIds: [],
      lookbackDays,
    });
  } catch {
    // swallow — nightly cron + next mutation will catch up.
  }
}
