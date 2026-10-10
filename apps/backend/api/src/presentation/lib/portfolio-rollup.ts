import { PortfolioValueDailyRepository } from '@scani/domain/repositories';
import { HistoryRebuildRangeService, PortfolioValueCache } from '@scani/domain/services';
import {
  backfillQueueOf,
  enqueueCoalescedBackfill,
  mergeFromDay,
  PORTFOLIO_HISTORY_LOOKBACK_DAYS,
  withFromDay,
} from '@scani/jobs';
import { BullMqEnqueueService, QueueClient } from '@scani/queue';
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
 * The earliest UTC day a mutation can move, or undefined for the whole window
 * (SC-1607). A read that fails is the whole window: a start too late is a
 * wrong chart, a start too early only a slower rebuild.
 */
export type RebuildFrom = (range: HistoryRebuildRangeService) => Promise<string | undefined>;

export async function rebuildFrom(read: RebuildFrom): Promise<string | undefined> {
  try {
    return await read(Container.get(HistoryRebuildRangeService));
  } catch {
    return undefined;
  }
}

/**
 * A start read BEFORE a write that changes a balance, combined with the start
 * read after it; the earlier wins. Two things only the read before can see:
 * a floor that the write lifts from below zero to 0 (feeds, #22804), and the
 * observation before the edit, which a read after it misses for the edit's
 * own new observation (SC-1607 falsifier). null: nothing before; undefined:
 * it could not be read, so the whole window.
 */
export async function floorBefore(
  read: (range: HistoryRebuildRangeService) => Promise<string | null | undefined>
): Promise<string | null | undefined> {
  try {
    return await read(Container.get(HistoryRebuildRangeService));
  } catch {
    return undefined;
  }
}

export function alsoFromFloor(before: string | null | undefined, after: RebuildFrom): RebuildFrom {
  return async (range) => {
    if (before === undefined) return undefined;
    const from = await after(range);
    return before === null ? from : mergeFromDay(from, before);
  };
}

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
export async function enqueuePortfolioRollup(
  userId: string,
  from?: RebuildFrom | string
): Promise<void> {
  // Drop the user's cached live valuation so the next read recomputes
  // against current holdings instead of serving a pre-mutation total.
  await Container.get(PortfolioValueCache).bust(userId);

  try {
    const lookbackDays = await Container.get(PortfolioValueDailyRepository).findHistoryLookbackDays(
      userId,
      PORTFOLIO_HISTORY_LOOKBACK_DAYS
    );
    // A string is a start read before the mutation (a delete removes what it
    // is read from); a function is read now, after it.
    const fromDay = typeof from === 'function' ? await rebuildFrom(from) : from;
    const bucket = Math.floor(Date.now() / ROLLUP_COALESCE_WINDOW_MS);
    // Never onto a running rebuild, whose snapshot may predate this edit; a
    // pending one coalesces and keeps the earlier start (SC-1592, SC-1607).
    await enqueueCoalescedBackfill(
      backfillQueueOf(Container.get(BullMqEnqueueService), Container.get(QueueClient).get()),
      `mutation-${bucket}-${lookbackDays}`,
      (requestId) => withFromDay({ userId, requestId, tokenIds: [], lookbackDays }, fromDay)
    );
  } catch {
    // swallow — nightly cron + next mutation will catch up.
  }
}
