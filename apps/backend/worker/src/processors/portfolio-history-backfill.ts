import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { OpeningBalanceReconciliationService } from '@scani/domain/services';
import type { RollupSummary } from '@scani/domain/use-cases';
import {
  BackfillHistoricalPricesUseCase,
  LinkTransferPairsUseCase,
  RollupPortfolioValueDailyUseCase,
} from '@scani/domain/use-cases';
import {
  PORTFOLIO_HISTORY_BACKFILL,
  PORTFOLIO_HISTORY_CHUNK_DAYS,
  PORTFOLIO_HISTORY_LOOKBACK_DAYS,
  type PortfolioHistoryBackfillJob,
  type PortfolioHistoryRollupProgress,
} from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { BullMqEnqueueService, type ProcessorContext, UserJobProcessor } from '@scani/queue';
import { emitEntityChange } from '@scani/realtime';
import { eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { withJobLock } from '../lib/cron-lock';

// When the per-user advisory lock is held by an in-flight backfill, a
// freshly-enqueued one would silently skip — leaving any data inserted
// AFTER the in-flight backfill's snapshot was taken (e.g., wallet add
// followed by integration add) un-rolled until the next nightly cron.
// Re-enqueuing with a fixed `lock-held-retry` requestId means at most
// one pending retry per user (BullMQ jobId dedup), so a flurry of
// skipped runs collapses into a single delayed tick.
export const LOCK_HELD_RETRY_REQUEST_ID = 'lock-held-retry';
export const LOCK_HELD_RETRY_DELAY_MS = 90_000;

interface EnqueueServiceLike {
  add: (typeof BullMqEnqueueService)['prototype']['add'];
}

export async function scheduleLockHeldRetry(
  userId: string,
  enqueueService: EnqueueServiceLike
): Promise<void> {
  await enqueueService.add(
    PORTFOLIO_HISTORY_BACKFILL,
    {
      userId,
      requestId: LOCK_HELD_RETRY_REQUEST_ID,
      // Empty tokenIds + full lookback so the retry catches everything
      // the original triggers were meant to cover, regardless of who
      // first hit the lock.
      tokenIds: [],
      lookbackDays: PORTFOLIO_HISTORY_LOOKBACK_DAYS,
    },
    { delay: LOCK_HELD_RETRY_DELAY_MS }
  );
}

const logger = createComponentLogger('processor:portfolio-history-backfill');

// A resumed attempt reports zeros for the phases a previous attempt finished.
const SKIPPED_RECONCILIATION = { holdingsTouched: 0, openingsSynthesized: 0 };
const SKIPPED_PRICES = { attempted: 0, inserted: 0, alreadyHad: 0, providerMissing: 0 };

// A saved position is only worth resuming on the UTC day it was laid out on.
// A retry pressed the next day would otherwise skip today's row entirely, and
// re-running from day 0 costs one full pass — the thing this job does anyway.
export function resumableProgress(
  progress: PortfolioHistoryRollupProgress | undefined,
  now: Date
): PortfolioHistoryRollupProgress | null {
  if (!progress) return null;
  if (progress.anchor.slice(0, 10) !== now.toISOString().slice(0, 10)) return null;
  return progress;
}

// The nightly rollup and price-backfill crons take the same per-user lock the
// rollup does, and a chunked run releases it between chunks. A chunk that
// finds it held did not run, so it waits for the holder rather than spending
// one of the job's two attempts.
export const CHUNK_LOCK_WAIT_MS = 15_000;
export const CHUNK_LOCK_MAX_WAITS = 20;

export interface ChunkedRollupDeps {
  rollup: (opts: {
    userId: string;
    lookbackDays: number;
    runStart: Date;
    dayOffsets: { from: number; to: number };
  }) => Promise<RollupSummary>;
  saveProgress: (progress: PortfolioHistoryRollupProgress) => Promise<void>;
  onChunk: (daysDone: number, lookbackDays: number) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

// Walk the lookback window PORTFOLIO_HISTORY_CHUNK_DAYS at a time (SC-1283).
// Each chunk is its own rollup call, so everything it prefetched and every
// per-day result it built is unreachable before the next one starts; memory
// stays at one chunk's worth however long the window is. Progress is saved
// after each chunk, so an attempt stopped mid-window resumes at the next one.
export async function runChunkedRollup(
  userId: string,
  lookbackDays: number,
  start: PortfolioHistoryRollupProgress,
  deps: ChunkedRollupDeps
): Promise<{ usersProcessed: number; daysComputed: number; errors: RollupSummary['errors'] }> {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const runStart = new Date(start.anchor);
  const out = { usersProcessed: 0, daysComputed: 0, errors: [] as RollupSummary['errors'] };
  let from = start.nextDayOffset;
  while (from < lookbackDays) {
    const to = Math.min(lookbackDays, from + PORTFOLIO_HISTORY_CHUNK_DAYS);
    let summary = await deps.rollup({ userId, lookbackDays, runStart, dayOffsets: { from, to } });
    for (let waits = 0; summary.usersSkipped > 0; waits++) {
      if (waits >= CHUNK_LOCK_MAX_WAITS) {
        throw new Error(
          `Rollup lock for ${userId} stayed held; stopped at day offset ${from} of ${lookbackDays}`
        );
      }
      await sleep(CHUNK_LOCK_WAIT_MS);
      summary = await deps.rollup({ userId, lookbackDays, runStart, dayOffsets: { from, to } });
    }
    out.usersProcessed = Math.max(out.usersProcessed, summary.usersProcessed);
    out.daysComputed += summary.daysComputed;
    out.errors.push(...summary.errors);
    await deps.saveProgress({ anchor: start.anchor, nextDayOffset: to });
    await deps.onChunk(to, lookbackDays);
    from = to;
  }
  return out;
}

interface PortfolioHistoryBackfillResult {
  tokenCount: number;
  lookbackDays: number;
  reconciliation: { holdingsTouched: number; openingsSynthesized: number };
  prices: { attempted: number; inserted: number; alreadyHad: number; providerMissing: number };
  rollup: { usersProcessed: number; daysComputed: number; errorCount: number };
}

@Service()
export class PortfolioHistoryBackfillProcessor extends UserJobProcessor<
  PortfolioHistoryBackfillJob,
  PortfolioHistoryBackfillResult
> {
  readonly descriptor = PORTFOLIO_HISTORY_BACKFILL;

  protected async handle(
    data: PortfolioHistoryBackfillJob,
    ctx: ProcessorContext
  ): Promise<PortfolioHistoryBackfillResult> {
    // Per-user advisory lock. Backfill is heavy (22k+ token-day tuples per
    // run) and idempotent — the holdings router enqueues one per
    // mutation, so a user clicking around can stack 4+ jobs that each
    // pin a worker concurrency slot for several minutes, blocking all
    // other user-initiated jobs from running. Locking by `userId` lets
    // the first runner do the work; the rest no-op in milliseconds.
    const lockKey = `portfolio-history-backfill:${data.userId}`;
    const outcome = await withJobLock(lockKey, () => this.runBackfill(data, ctx));
    if (outcome.ran) return outcome.result;

    // Lock held by another in-flight backfill. The in-flight run took its
    // holdings/transactions snapshot before our trigger landed, so any
    // data the current job was supposed to roll up may be missing. Queue
    // a delayed retry (fixed requestId → at most one pending per user)
    // so the work is picked up the moment the lock clears.
    try {
      await scheduleLockHeldRetry(data.userId, Container.get(BullMqEnqueueService));
      logger.info(
        {
          jobId: ctx.job.id,
          userId: data.userId,
          retryDelayMs: LOCK_HELD_RETRY_DELAY_MS,
          skipIsRetry: data.requestId === LOCK_HELD_RETRY_REQUEST_ID,
        },
        'Backfill skipped (lock held) — delayed retry enqueued'
      );
    } catch (err) {
      logger.warn(
        {
          jobId: ctx.job.id,
          userId: data.userId,
          error: err instanceof Error ? err.message : String(err),
        },
        'Backfill skipped (lock held) — failed to enqueue delayed retry'
      );
    }
    return {
      tokenCount: data.tokenIds.length,
      lookbackDays: data.lookbackDays,
      reconciliation: SKIPPED_RECONCILIATION,
      prices: SKIPPED_PRICES,
      rollup: { usersProcessed: 0, daysComputed: 0, errorCount: 0 },
    };
  }

  private async runBackfill(
    data: PortfolioHistoryBackfillJob,
    ctx: ProcessorContext
  ): Promise<PortfolioHistoryBackfillResult> {
    const resume = resumableProgress(data.rollupProgress, new Date());
    if (resume) {
      logger.info(
        { jobId: ctx.job.id, userId: data.userId, ...resume },
        'Resuming portfolio history rollup where the last attempt stopped'
      );
      return this.rollupPhase(data, ctx, resume, SKIPPED_RECONCILIATION, SKIPPED_PRICES);
    }

    const usdTokenId = await this.resolveUsdTokenId();
    await ctx.reportProgress(0.05);

    // Re-reconcile every holding's opening balance BEFORE pricing/rollup.
    // The reconciler is now self-aware (excludes its own past output
    // from the sum), so this pass cleans up any stale synthesized
    // opening rows left behind by token-merge migrations or by an
    // import that landed mid-flight. Without this, cost basis stays
    // anchored to the bogus opening and PnL stays wrong even after a
    // fresh price backfill.
    const reconcileSummary = await this.reconcileUser(data.userId);
    await ctx.reportProgress(0.15);

    // Link cross-account transfer pairs before the rollup — its
    // cost-basis walk reads `transfer_group_id` to carry lot cost across
    // a transfer instead of resetting it to market value. Cheap (two
    // queries + in-memory matching); a failure is non-fatal — the rollup
    // still runs, just without fresh linkage.
    try {
      await Container.get(LinkTransferPairsUseCase).execute({ userId: data.userId });
    } catch (error) {
      logger.warn(
        { userId: data.userId, error: error instanceof Error ? error.message : error },
        'Transfer linking failed during backfill; continuing'
      );
    }
    await ctx.reportProgress(0.2);

    const priceSummary = await Container.get(BackfillHistoricalPricesUseCase).execute({
      usdTokenId,
      userId: data.userId,
      tokenIds: data.tokenIds,
      lookbackDays: data.lookbackDays,
    });
    await ctx.reportProgress(0.55);

    const progress: PortfolioHistoryRollupProgress = {
      anchor: new Date().toISOString(),
      nextDayOffset: 0,
    };
    // Saved before the first chunk: from here a stopped attempt skips
    // straight back to the rollup, the phases above having finished.
    await this.saveProgress(data, ctx, progress);
    return this.rollupPhase(data, ctx, progress, reconcileSummary, {
      attempted: priceSummary.attempted,
      inserted: priceSummary.inserted,
      alreadyHad: priceSummary.alreadyHad,
      providerMissing: priceSummary.providerMissing,
    });
  }

  private async saveProgress(
    data: PortfolioHistoryBackfillJob,
    ctx: ProcessorContext,
    progress: PortfolioHistoryRollupProgress
  ): Promise<void> {
    await ctx.job.updateData({ ...data, rollupProgress: progress });
  }

  private async rollupPhase(
    data: PortfolioHistoryBackfillJob,
    ctx: ProcessorContext,
    start: PortfolioHistoryRollupProgress,
    reconciliation: PortfolioHistoryBackfillResult['reconciliation'],
    prices: PortfolioHistoryBackfillResult['prices']
  ): Promise<PortfolioHistoryBackfillResult> {
    const rollup = Container.get(RollupPortfolioValueDailyUseCase);
    const rollupSummary = await runChunkedRollup(data.userId, data.lookbackDays, start, {
      rollup: (opts) => rollup.execute(opts),
      saveProgress: (progress) => this.saveProgress(data, ctx, progress),
      onChunk: (daysDone, total) => ctx.reportProgress(0.55 + 0.4 * (daysDone / total)),
    });
    await ctx.reportProgress(0.95);

    emitEntityChange({
      entityType: 'holding',
      operationType: 'update',
      entityId: data.userId,
      userId: data.userId,
      data: { reason: 'portfolio-history-backfill' },
    });

    await ctx.reportProgress(1);

    if (rollupSummary.errors.length > 0) {
      logger.warn(
        { jobId: ctx.job.id, errors: rollupSummary.errors },
        'Rollup completed with per-user errors'
      );
    }

    return {
      tokenCount: data.tokenIds.length,
      lookbackDays: data.lookbackDays,
      reconciliation,
      prices,
      rollup: {
        usersProcessed: rollupSummary.usersProcessed,
        daysComputed: rollupSummary.daysComputed,
        errorCount: rollupSummary.errors.length,
      },
    };
  }

  private async reconcileUser(
    userId: string
  ): Promise<{ holdingsTouched: number; openingsSynthesized: number }> {
    try {
      const results = await Container.get(OpeningBalanceReconciliationService).reconcileUser(
        userId
      );
      const synthesized = results.filter((r) => r.openingBalanceSynthesized).length;
      return { holdingsTouched: results.length, openingsSynthesized: synthesized };
    } catch (error) {
      logger.warn(
        { userId, error: error instanceof Error ? error.message : error },
        'Reconciliation pass threw; continuing with backfill'
      );
      return { holdingsTouched: 0, openingsSynthesized: 0 };
    }
  }

  // BackfillHistoricalPricesUseCase requires the USD token id as the
  // base-currency anchor. Look it up at job start (one cheap query) so
  // the use case stays pure.
  private async resolveUsdTokenId(): Promise<string> {
    const [row] = await db
      .select({ id: schema.tokens.id })
      .from(schema.tokens)
      .where(eq(schema.tokens.symbol, 'USD'))
      .limit(1);
    if (!row) throw new Error('USD token not found in tokens table — seeds may be missing');
    return row.id;
  }
}
