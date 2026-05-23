import { TransactionImportCoordinator, TransactionImportUnrecoverableError } from '@scani/domain';
import { HoldingRepository, PortfolioValueDailyRepository } from '@scani/domain/repositories';
import { PortfolioValueCache } from '@scani/domain/services';
import {
  PORTFOLIO_HISTORY_BACKFILL,
  PORTFOLIO_HISTORY_LOOKBACK_DAYS,
  TRANSACTION_IMPORT,
  type TransactionImportJob,
} from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { captureException } from '@scani/logging/sentry';
import {
  BullMqEnqueueService,
  type ProcessorContext,
  UnrecoverableError,
  UserJobProcessor,
} from '@scani/queue';
import { emitEntityChange } from '@scani/realtime';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:ingest-transactions');

// 5 minutes: an import wave (4 EVM accounts × ~30s each + the kraken
// /Ledgers paginator at ~2.2s/page × ~20 pages) easily spans more than
// 30s. The previous 30s window meant every account-finish enqueued a
// new full-history backfill jobId, all of which got de-duped
// downstream — but only after each one had already paid the cost of
// scheduling and crash-recovery bookkeeping. 5 min collapses an
// import session to one backfill.
const ROLLUP_COALESCE_WINDOW_MS = 5 * 60_000;

// Safety pad on top of the gap-since-last-rollup, so a fresh
// transaction whose date barely predates the last rollup row still
// gets re-priced.
const LOOKBACK_SAFETY_PAD_DAYS = 7;
// Hard ceiling; a fresh user (no rollup rows yet) backfills the full
// chart window. Shares PORTFOLIO_HISTORY_LOOKBACK_DAYS so the post-
// import backfill reaches at least as deep as the 1Y chart range.
const LOOKBACK_DEFAULT_DAYS = PORTFOLIO_HISTORY_LOOKBACK_DAYS;
const LOOKBACK_MIN_DAYS = 1;

// Dispatches a single transaction-import to TransactionImportCoordinator,
// then kicks off downstream price-backfill + portfolio-rollup so the
// net-worth chart fills in once the tx ledger has new dates to price.
//
// One job per (account, source). Chain-enqueued from exchange-import /
// wallet-import after those complete, so user_jobs shows a row per
// account being imported — clear progress + failure isolation per account.
@Service()
export class IngestTransactionsProcessor extends UserJobProcessor<TransactionImportJob, unknown> {
  readonly descriptor = TRANSACTION_IMPORT;

  protected async handle(data: TransactionImportJob, _ctx: ProcessorContext): Promise<unknown> {
    const coordinator = Container.get(TransactionImportCoordinator);
    let result: Awaited<ReturnType<typeof coordinator.execute>>;
    try {
      result = await coordinator.execute({
        userId: data.userId,
        accountId: data.accountId,
        source: data.source,
        since: data.since ? new Date(data.since) : undefined,
      });
    } catch (error) {
      // Coordinator throws TransactionImportUnrecoverableError for
      // classified user-actionable failures. Bridge to BullMQ's
      // UnrecoverableError so the job skips the retry budget and shows
      // up in /jobs as failed with the original message.
      if (error instanceof TransactionImportUnrecoverableError) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }

    // If the ingester actually produced rows, enqueue a per-user
    // history backfill. Coalesced to a 30s window so all 4 EVM
    // tx-imports kicked off from a single wallet-import confirm land
    // ONE backfill — and that backfill runs after the longest-running
    // tx-import finishes, so the rollup sees the full transaction
    // ledger. The per-user advisory lock inside the processor blocks
    // any concurrent runs.
    if (result.transactions > 0) {
      const bucket = Math.floor(Date.now() / ROLLUP_COALESCE_WINDOW_MS);
      const lookbackDays = await computeLookbackDays(data.userId);
      try {
        await Container.get(BullMqEnqueueService).add(PORTFOLIO_HISTORY_BACKFILL, {
          userId: data.userId,
          requestId: `tx-import-${bucket}`,
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
            userId: data.userId,
            accountId: data.accountId,
            err: message,
          },
          'PORTFOLIO_HISTORY_BACKFILL enqueue failed; chart will fill in via the nightly cron'
        );
        captureException(error, {
          component: 'worker',
          processor: 'ingest-transactions',
          kind: 'backfill-enqueue-failure',
          userId: data.userId,
        });
        result.warnings.push(`Backfill enqueue failed: ${message}`);
      }

      emitEntityChange({
        entityType: 'holding',
        operationType: 'sync',
        userId: data.userId,
        data: {
          reason: 'transaction_import',
          accountId: data.accountId,
          source: data.source,
          transactions: result.transactions,
        },
      });

      // Imported transactions changed holding balances — drop the user's
      // cached portfolio valuation so the next read recomputes.
      await Container.get(PortfolioValueCache).bust(data.userId);
    }

    return result;
  }
}

// Adaptive lookback. First-ever rollup for a user → full year. Steady
// state → days-since-last-rollup + safety pad. This collapses the
// post-import backfill from 365 days × 107 holdings × ~3 DB queries
// (the 35h prod incident on 2026-05-02) down to ~1-7 days × … on
// every subsequent tx-import.
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
