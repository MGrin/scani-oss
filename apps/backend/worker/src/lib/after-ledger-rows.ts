import { HoldingRepository, PortfolioValueDailyRepository } from '@scani/domain/repositories';
import { noteOnResult, PortfolioValueCache } from '@scani/domain/services';
import { ReconcilePaymentsUseCase } from '@scani/domain/use-cases';
import { PORTFOLIO_HISTORY_BACKFILL, PORTFOLIO_HISTORY_LOOKBACK_DAYS } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { captureException } from '@scani/logging/sentry';
import { BullMqEnqueueService } from '@scani/queue';
import { emitEntityChange } from '@scani/realtime';
import { Container } from 'typedi';
import { LOOKBACK_SAFETY_PAD_DAYS, widenToEarliestWrite } from './rebuild-window';

const logger = createComponentLogger('worker:after-ledger-rows');

// 5 minutes: an import wave (4 EVM accounts × ~30s each + the kraken
// /Ledgers paginator at ~2.2s/page × ~20 pages) easily spans more than
// 30s. The previous 30s window meant every account-finish enqueued a
// new full-history backfill jobId, all of which got de-duped
// downstream — but only after each one had already paid the cost of
// scheduling and crash-recovery bookkeeping. 5 min collapses an
// import session to one backfill.
const ROLLUP_COALESCE_WINDOW_MS = 5 * 60_000;

// Hard ceiling; a fresh user (no rollup rows yet) backfills the full
// chart window. Shares PORTFOLIO_HISTORY_LOOKBACK_DAYS so the post-
// import backfill reaches at least as deep as the 1Y chart range.
const LOOKBACK_DEFAULT_DAYS = PORTFOLIO_HISTORY_LOOKBACK_DAYS;
const LOOKBACK_MIN_DAYS = 1;

interface LedgerRowsWritten {
  transactions: number;
  earliestWrittenAt: string | null;
  warnings: string[];
  warningDetails: Parameters<typeof noteOnResult>[0]['warningDetails'];
}

/**
 * What follows a ledger write that produced rows, wherever the rows were read:
 * a transaction import, or a balance sync that read the ledger with the
 * balance (SC-1665). The chart rebuild, the live update, the cache and the
 * bills all depend on the rows, never on which job wrote them.
 */
export async function afterLedgerRows(
  job: { userId: string; accountId: string; source: string },
  result: LedgerRowsWritten
): Promise<void> {
  // If the ingester actually produced rows, enqueue a per-user
  // history backfill. Coalesced to a 30s window so all 4 EVM
  // tx-imports kicked off from a single wallet-import confirm land
  // ONE backfill — and that backfill runs after the longest-running
  // tx-import finishes, so the rollup sees the full transaction
  // ledger. The per-user advisory lock inside the processor blocks
  // any concurrent runs.
  if (result.transactions > 0) {
    const bucket = Math.floor(Date.now() / ROLLUP_COALESCE_WINDOW_MS);
    const snapshotWindow = await computeLookbackDays(job.userId);
    const lookbackDays = widenToEarliestWrite(snapshotWindow, result.earliestWrittenAt);
    // A window widened by a backdated row gets its own id, so it is never
    // collapsed into a narrower job already queued in this bucket (the
    // SC-1323 shape). The per-user lock runs the two one after the other.
    const requestId =
      lookbackDays > snapshotWindow
        ? `tx-import-${bucket}-${lookbackDays}d`
        : `tx-import-${bucket}`;
    try {
      await Container.get(BullMqEnqueueService).add(PORTFOLIO_HISTORY_BACKFILL, {
        userId: job.userId,
        requestId,
        tokenIds: [],
        lookbackDays,
      });
    } catch (error) {
      // Backfill enqueue failures don't fail the parent tx-import
      // (the ledger rows are already persisted), but they DO leave
      // the user's chart un-updated until the next nightly cron.
      // Surface to Sentry so they don't sit silent in `result.warnings`
      // forever — the warnings field surfaces in /jobs but rarely gets
      // looked at unless the user reports a missing chart range.
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        {
          userId: job.userId,
          accountId: job.accountId,
          err: message,
        },
        'PORTFOLIO_HISTORY_BACKFILL enqueue failed; chart will fill in via the nightly cron'
      );
      captureException(error, {
        component: 'worker',
        processor: 'ingest-transactions',
        kind: 'backfill-enqueue-failure',
        userId: job.userId,
      });
      noteOnResult(result, `Backfill enqueue failed: ${message}`);
    }

    emitEntityChange({
      entityType: 'holding',
      operationType: 'sync',
      userId: job.userId,
      data: {
        reason: 'transaction_import',
        accountId: job.accountId,
        source: job.source,
        transactions: result.transactions,
      },
    });

    // Imported transactions changed holding balances — drop the user's
    // cached portfolio valuation so the next read recomputes.
    await Container.get(PortfolioValueCache).bust(job.userId);

    // An expected income or bill these rows pay is marked paid (SC-1665).
    // Non-fatal: the rows are written, and the next import retries.
    try {
      await Container.get(ReconcilePaymentsUseCase).execute(job.userId);
    } catch (error) {
      logger.warn(
        { userId: job.userId, err: error instanceof Error ? error.message : String(error) },
        'Matching imported rows to bills failed; the next import retries'
      );
    }
  }
}

// Adaptive lookback. First-ever rollup for a user → full year. Steady
// state → days-since-last-rollup + safety pad. This collapses the
// post-import backfill from 365 days × every holding × ~3 DB queries
// (the multi-hour prod incident on 2026-05-02) down to ~1-7 days × …
// on every subsequent tx-import.
//
// HOWEVER — if a tx-import discovered a NEW holding (Etherscan found
// a token-transfer to the user's address that minted a fresh
// `holdings` row) whose `created_at > lastSnapshotDate`, the
// adaptive 7-day rollup wouldn't include the new holding's value in
// past dates. Past `portfolio_value_daily` rows would stay at the
// pre-discovery total. Force a full 365-day backfill in that case
// so the chart correctly reflects the holding's
// current-balance-propagated-backward value.
async function computeLookbackDays(userId: string): Promise<number> {
  try {
    const repo = Container.get(PortfolioValueDailyRepository);
    const latest = await repo.findLatestSnapshotDate(userId);
    if (!latest) return LOOKBACK_DEFAULT_DAYS;

    const latestDate = new Date(`${latest}T00:00:00Z`);
    const today = new Date();
    const ageDays = Math.floor((today.getTime() - latestDate.getTime()) / (24 * 60 * 60 * 1000));

    // New-holding detection: any holding created after the last
    // rollup snapshot date forces a full backfill. This covers the
    // tx-import-discovers-new-token path that the api-side mutation
    // hooks (enqueuePortfolioRollup) don't intercept. Probe via
    // indexed SQL `LIMIT 1` instead of loading every holding into
    // memory — the previous `findByUser + .some()` allocated O(N)
    // rows on every tx-import.
    const holdingRepo = Container.get(HoldingRepository);
    const hasNewHoldingSinceRollup = await holdingRepo.hasHoldingCreatedAfter(userId, latestDate);
    if (hasNewHoldingSinceRollup) return LOOKBACK_DEFAULT_DAYS;

    const adaptive = Math.max(ageDays + LOOKBACK_SAFETY_PAD_DAYS, LOOKBACK_MIN_DAYS);
    return Math.min(adaptive, LOOKBACK_DEFAULT_DAYS);
  } catch {
    // If the lookup itself fails, fall back to the safe default rather
    // than skipping the backfill.
    return LOOKBACK_DEFAULT_DAYS;
  }
}
