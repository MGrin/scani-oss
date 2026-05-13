import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { UserJobRepository } from '@scani/domain/repositories';
import { PortfolioValuationService } from '@scani/domain/services';
import {
  CreateHoldingsWithDependenciesUseCase,
  UpdateHoldingPriceUseCase,
} from '@scani/domain/use-cases';
import {
  MANUAL_HOLDINGS_CREATE,
  type ManualHoldingsCreateJob,
  PORTFOLIO_HISTORY_BACKFILL,
} from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { BullMqEnqueueService, type ProcessorContext, UserJobProcessor } from '@scani/queue';
import { emitEntityChange } from '@scani/realtime';
import { eq, inArray } from 'drizzle-orm';
import { Container, Service } from 'typedi';

// Days of history to materialize after manual-create. 365 keeps the
// follow-up job fast (one provider call per token per ~year of data)
// while giving the chart a meaningful 1Y view immediately. Older history
// is filled in by the nightly 1825-day cron sweep.
const MANUAL_BACKFILL_LOOKBACK_DAYS = 365;

const logger = createComponentLogger('processor:manual-holdings-create');

interface HoldingResultRow {
  id: string;
  tokenId: string;
  symbol: string;
  name: string;
  typeCode: string;
  balance: string;
  isUpdate: boolean;
  // `null` when the price fetch ran without error but no provider had a
  // quote and no stale fallback was usable. Undefined when the row
  // never reached pricing (e.g. failed earlier).
  priceUsd?: string | null;
  priceSource?: string;
  error?: string;
}

interface ManualHoldingsCreateResult {
  institutionId: string | null;
  accountId: string;
  createdInstitution: boolean;
  createdAccount: boolean;
  holdings: HoldingResultRow[];
  parentJobId: string | null;
}

// Progress weights — phase boundaries report monotonically increasing
// progress to the WS subscriber (the JobDetailPage). We reserve the
// largest band for price fetches because that's the slow, user-visible
// part where each provider call settles independently.
const PHASE_DB_DONE = 0.4;
const PHASE_PRICING_END = 0.95;

@Service()
export class ManualHoldingsCreateProcessor extends UserJobProcessor<
  ManualHoldingsCreateJob,
  ManualHoldingsCreateResult
> {
  readonly descriptor = MANUAL_HOLDINGS_CREATE;

  protected async handle(
    data: ManualHoldingsCreateJob,
    ctx: ProcessorContext
  ): Promise<ManualHoldingsCreateResult> {
    const user = await this.loadUser(data.userId);
    const baseCurrencySymbol = await this.resolveBaseCurrencySymbol(data.baseCurrencyId);

    await ctx.reportProgress(0.05);
    await ctx.reportStatus('Saving institution, account and holdings…');

    // Phase 1: institution + account + new holdings + balance updates,
    // all atomic inside a single transaction owned by the use case.
    const dbResult = await Container.get(CreateHoldingsWithDependenciesUseCase).execute(
      {
        institution: data.institution,
        accountId: data.accountId,
        account: data.account,
        holdings: data.newHoldings.map((h) => ({ tokenId: h.tokenId, balance: h.balance })),
        updateHoldings: data.updateHoldings.map((h) => ({
          holdingId: h.holdingId,
          balance: h.balance,
        })),
      },
      user
    );

    await ctx.reportProgress(PHASE_DB_DONE);

    // Phase 2: emit realtime entity events so any open holdings/accounts
    // tab refreshes without waiting for the job to terminate.
    if (dbResult.createdInstitution && dbResult.institutionId) {
      emitEntityChange({
        entityType: 'institution',
        operationType: 'create',
        entityId: dbResult.institutionId,
        userId: data.userId,
        data: {},
      });
    }
    if (dbResult.createdAccount) {
      emitEntityChange({
        entityType: 'account',
        operationType: 'create',
        entityId: dbResult.accountId,
        userId: data.userId,
        data: { institutionId: dbResult.institutionId },
      });
    }
    for (const h of dbResult.holdings) {
      emitEntityChange({
        entityType: 'holding',
        operationType: 'create',
        entityId: h.id,
        userId: data.userId,
      });
    }
    for (const id of dbResult.updatedHoldingIds) {
      emitEntityChange({
        entityType: 'holding',
        operationType: 'update',
        entityId: id,
        userId: data.userId,
      });
    }

    // Phase 3: gather every affected holding (created + updated) for
    // pricing. Resolve symbols up front so the result rows always carry
    // a human-readable token name even when pricing fails.
    const allAffectedHoldingIds = [
      ...dbResult.holdings.map((h) => h.id),
      ...dbResult.updatedHoldingIds,
    ];
    const tokenIdByHoldingId = new Map<string, string>();
    for (const h of dbResult.holdings) tokenIdByHoldingId.set(h.id, h.tokenId);
    if (dbResult.updatedHoldingIds.length > 0) {
      const updatedRows = await db
        .select({
          id: schema.holdings.id,
          tokenId: schema.holdings.tokenId,
          balance: schema.holdings.balance,
        })
        .from(schema.holdings)
        .where(inArray(schema.holdings.id, dbResult.updatedHoldingIds));
      for (const r of updatedRows) tokenIdByHoldingId.set(r.id, r.tokenId);
    }
    const tokenIds = Array.from(new Set(tokenIdByHoldingId.values()));
    interface TokenInfo {
      symbol: string;
      name: string;
      typeCode: string;
    }
    const tokenInfoById = new Map<string, TokenInfo>();
    if (tokenIds.length > 0) {
      const tokenRows = await db
        .select({
          id: schema.tokens.id,
          symbol: schema.tokens.symbol,
          name: schema.tokens.name,
          typeCode: schema.tokenTypes.code,
        })
        .from(schema.tokens)
        .leftJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
        .where(inArray(schema.tokens.id, tokenIds));
      for (const r of tokenRows) {
        tokenInfoById.set(r.id, {
          symbol: r.symbol,
          name: r.name,
          typeCode: r.typeCode ?? 'other',
        });
      }
    }

    // Skip pricing for the user's base currency (priced 1:1 by definition)
    // and for any holding that is its own base — saves a round-trip per row.
    const baseCurrencyTokenId = data.baseCurrencyId;

    type SettlementRow = HoldingResultRow;
    const initialBalanceById = new Map<string, string>();
    for (const h of dbResult.holdings) initialBalanceById.set(h.id, h.balance);
    for (const u of data.updateHoldings) initialBalanceById.set(u.holdingId, u.balance);

    if (allAffectedHoldingIds.length > 0) {
      await ctx.reportStatus(
        `Fetching prices for ${allAffectedHoldingIds.length} ${allAffectedHoldingIds.length === 1 ? 'holding' : 'holdings'}…`
      );
    }
    const updatePriceUseCase = Container.get(UpdateHoldingPriceUseCase);
    const settlements = await Promise.all(
      allAffectedHoldingIds.map(async (holdingId, index): Promise<SettlementRow> => {
        const tokenId = tokenIdByHoldingId.get(holdingId) ?? '';
        const tokenInfo = tokenInfoById.get(tokenId);
        const balance = initialBalanceById.get(holdingId) ?? '0';
        const isUpdate = !dbResult.holdings.some((h) => h.id === holdingId);
        const baseRow: SettlementRow = {
          id: holdingId,
          tokenId,
          symbol: tokenInfo?.symbol ?? '',
          name: tokenInfo?.name ?? '',
          typeCode: tokenInfo?.typeCode ?? 'other',
          balance,
          isUpdate,
        };
        if (tokenId === baseCurrencyTokenId) {
          return { ...baseRow, priceUsd: '1', priceSource: 'base-currency' };
        }
        try {
          const priceResult = await updatePriceUseCase.execute(
            holdingId,
            data.userId,
            baseCurrencySymbol
          );
          // Emit per-holding update so the UI can repaint the row as soon
          // as a single price settles, instead of waiting for the entire
          // batch.
          emitEntityChange({
            entityType: 'holding',
            operationType: 'update',
            entityId: holdingId,
            userId: data.userId,
          });
          return { ...baseRow, priceUsd: priceResult.price, priceSource: priceResult.source };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(
            { jobId: ctx.job.id, holdingId, error: message },
            'Per-holding price fetch failed (non-fatal)'
          );
          return { ...baseRow, error: message };
        } finally {
          // Linear progress within the pricing phase. Index can resolve
          // out of order (Promise.all), so we always advance toward the
          // end-of-phase weight rather than trying to track exact %.
          const completed = index + 1;
          const total = allAffectedHoldingIds.length;
          const phaseProgress =
            PHASE_DB_DONE + (PHASE_PRICING_END - PHASE_DB_DONE) * (completed / Math.max(total, 1));
          await ctx.reportProgress(phaseProgress);
        }
      })
    );

    // Phase 4: portfolio valuation (best-effort — failure here doesn't
    // invalidate the holdings the user just created).
    await ctx.reportStatus('Recomputing portfolio value…');
    try {
      await Container.get(PortfolioValuationService).getUserPortfolioValue(
        data.userId,
        data.baseCurrencyId,
        dbResult.accountId
      );
    } catch (err) {
      logger.warn(
        { jobId: ctx.job.id, error: err instanceof Error ? err.message : err },
        'Portfolio valuation failed after manual-holdings-create (non-fatal)'
      );
    }

    // Phase 5: stamp the parent job (screenshot/file-import review) so it
    // flips to "Already imported" automatically. We do this *only on
    // success* — a failed create job should leave the parent reviewable.
    if (data.parentJobIdToStampOnSuccess) {
      try {
        await Container.get(UserJobRepository).markActionTaken(
          data.userId,
          data.parentJobIdToStampOnSuccess
        );
      } catch (err) {
        logger.warn(
          {
            jobId: ctx.job.id,
            parentJobId: data.parentJobIdToStampOnSuccess,
            error: err instanceof Error ? err.message : err,
          },
          'Failed to stamp parent job actionTakenAt (non-fatal)'
        );
      }
    }

    // Phase 6: enqueue the async history backfill so the chart has data
    // within ~30s instead of waiting for the nightly cron. Failure to
    // enqueue is non-fatal — the cron will catch up.
    //
    // Always enqueue, even when the user only added a base-currency
    // holding. The price-backfill phase is a no-op for base-currency
    // tokens (identity-priced 1:1), but the rollup phase still needs
    // to run so `portfolio_value_daily` gets populated and the chart
    // can render the constant balance over time. Skipping the enqueue
    // here used to leave the chart empty for base-currency-only users.
    const tokenIdsToBackfill = Array.from(
      new Set(
        allAffectedHoldingIds
          .map((id) => tokenIdByHoldingId.get(id))
          .filter((tid): tid is string => Boolean(tid) && tid !== data.baseCurrencyId)
      )
    );
    try {
      await Container.get(BullMqEnqueueService).add(PORTFOLIO_HISTORY_BACKFILL, {
        userId: data.userId,
        requestId: randomUUID(),
        tokenIds: tokenIdsToBackfill,
        lookbackDays: MANUAL_BACKFILL_LOOKBACK_DAYS,
      });
    } catch (err) {
      logger.warn(
        { jobId: ctx.job.id, error: err instanceof Error ? err.message : err },
        'Failed to enqueue portfolio-history-backfill (non-fatal)'
      );
    }

    await ctx.reportProgress(1);

    return {
      institutionId: dbResult.institutionId ?? null,
      accountId: dbResult.accountId,
      createdInstitution: dbResult.createdInstitution,
      createdAccount: dbResult.createdAccount,
      holdings: settlements,
      parentJobId: data.parentJobIdToStampOnSuccess ?? null,
    };
  }

  private async loadUser(userId: string) {
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user) throw new Error(`User ${userId} not found`);
    if (!user.baseCurrencyId) throw new Error(`User ${userId} has no base currency configured`);
    return user;
  }

  private async resolveBaseCurrencySymbol(baseCurrencyId: string): Promise<string> {
    const [token] = await db
      .select({ symbol: schema.tokens.symbol })
      .from(schema.tokens)
      .where(eq(schema.tokens.id, baseCurrencyId))
      .limit(1);
    return token?.symbol || 'USD';
  }
}
