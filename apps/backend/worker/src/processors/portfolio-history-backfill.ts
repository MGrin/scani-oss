import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import {
  BackfillHistoricalPricesUseCase,
  RollupPortfolioValueDailyUseCase,
} from '@scani/domain/use-cases';
import { PORTFOLIO_HISTORY_BACKFILL, type PortfolioHistoryBackfillJob } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { type ProcessorContext, UserJobProcessor } from '@scani/queue';
import { emitEntityChange } from '@scani/realtime';
import { eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { withJobLock } from '../lib/cron-lock';

const logger = createComponentLogger('processor:portfolio-history-backfill');

interface PortfolioHistoryBackfillResult {
  tokenCount: number;
  lookbackDays: number;
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
    logger.info(
      { jobId: ctx.job.id, userId: data.userId },
      'Backfill skipped — another instance is already running for this user'
    );
    return {
      tokenCount: data.tokenIds.length,
      lookbackDays: data.lookbackDays,
      prices: { attempted: 0, inserted: 0, alreadyHad: 0, providerMissing: 0 },
      rollup: { usersProcessed: 0, daysComputed: 0, errorCount: 0 },
    };
  }

  private async runBackfill(
    data: PortfolioHistoryBackfillJob,
    ctx: ProcessorContext
  ): Promise<PortfolioHistoryBackfillResult> {
    const usdTokenId = await this.resolveUsdTokenId();
    await ctx.reportProgress(0.05);

    const priceSummary = await Container.get(BackfillHistoricalPricesUseCase).execute({
      usdTokenId,
      userId: data.userId,
      tokenIds: data.tokenIds,
      lookbackDays: data.lookbackDays,
    });
    await ctx.reportProgress(0.55);

    const rollupSummary = await Container.get(RollupPortfolioValueDailyUseCase).execute({
      userId: data.userId,
      lookbackDays: data.lookbackDays,
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
      prices: {
        attempted: priceSummary.attempted,
        inserted: priceSummary.inserted,
        alreadyHad: priceSummary.alreadyHad,
        providerMissing: priceSummary.providerMissing,
      },
      rollup: {
        usersProcessed: rollupSummary.usersProcessed,
        daysComputed: rollupSummary.daysComputed,
        errorCount: rollupSummary.errors.length,
      },
    };
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
