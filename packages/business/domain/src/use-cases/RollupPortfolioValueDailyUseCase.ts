/**
 * RollupPortfolioValueDailyUseCase
 *
 * Nightly rollup that computes `portfolio_value_daily` rows for every
 * user for every day in a lookback window, in their configured base
 * currency. Reads layer 1+2 (transactions + observations) via
 * PortfolioValuationAtTimeService and writes the derived cache via
 * PortfolioValueDailyRepository.
 *
 * Deliberately rebuildable: dropping the table and re-running this
 * produces the same rows modulo floating-point / timing details. That
 * property drives the design — if the chart ever looks wrong, wipe
 * the rollup for one user and re-run.
 */

import { withAdvisoryLock } from '@scani/db';
import { db } from '@scani/db/connection';
import type { CoverageQuality } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { parseCostBasisMethod } from '@scani/shared';
import Decimal from 'decimal.js';
import { and, eq, sql } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { AccountRepository } from '../repositories/AccountRepository';
import { HoldingBalanceObservationRepository } from '../repositories/HoldingBalanceObservationRepository';
import { HoldingCoverageRepository } from '../repositories/HoldingCoverageRepository';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../repositories/HoldingTransactionRepository';
import { PortfolioValueDailyRepository } from '../repositories/PortfolioValueDailyRepository';
import { TokenRepository } from '../repositories/TokenRepository';
import { PnLAtTimeService } from '../services';
import type { PnLAtTimePerHolding } from '../services/portfolio/PnLAtTimeService';
import type { BalanceAtTimeCaches } from '../services/pricing/BalanceAtTimeService';
import { PriceGraphService } from '../services/pricing/PriceGraphService';

// Coverage thresholds — keep in sync with
// PortfolioValuationAtTimeService. Aggregation logic mirrors that
// service's per-day pass so per-entity scope rows match what the
// `scope='institution'/'account'/'holding'` valuation calls would
// have produced.
const COVERAGE_FULL_THRESHOLD = 0.95;
const COVERAGE_PARTIAL_THRESHOLD = 0.5;

const logger = createComponentLogger('use-case:rollup-portfolio-value-daily');

// Per-user lock key. Every per-user rollup-or-backfill path takes this
// SAME advisory lock so they serialize cleanly:
//   * `portfolio-value-rollup` cron (this file)
//   * `historical-price-backfill` cron (BackfillHistoricalPricesUseCase)
//   * `portfolio-history-backfill` user job (which calls both)
// The lock is non-blocking — if another holder is doing the work, the
// late arrival no-ops in milliseconds and the user re-queries get fresh
// rows the moment the holder releases.
export function rollupLockKey(userId: string): string {
  return `portfolio-value-rollup:${userId}`;
}

export interface RollupSummary {
  usersProcessed: number;
  daysComputed: number;
  /** Users skipped because another rollup was in flight for them. */
  usersSkipped: number;
  errors: Array<{ userId: string; error: string }>;
  durationMs: number;
}

@Service()
export class RollupPortfolioValueDailyUseCase {
  // Class-field DI — see note in BalanceAtTimeService.ts. Previously
  // used `= Container.get(Dep)` as constructor-param defaults, but
  // typedi overrode the default with a ContainerInstance because Bun
  // lacks reflect-metadata emit.
  private readonly pnlService = Container.get(PnLAtTimeService);
  private readonly dailyRepository = Container.get(PortfolioValueDailyRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly priceGraphService = Container.get(PriceGraphService);
  private readonly txRepository = Container.get(HoldingTransactionRepository);
  private readonly observationRepository = Container.get(HoldingBalanceObservationRepository);
  private readonly coverageRepository = Container.get(HoldingCoverageRepository);

  // Compute rollup rows for every active user for every day in
  // `lookbackDays` that isn't already cached. Defaults to 30 days
  // on the assumption that we run this nightly and only the tail
  // few days can actually have changed — anything earlier is
  // already cached.
  async execute(
    opts: {
      lookbackDays?: number;
      // Scope to a single user — when set, the paged users select is
      // replaced with a single-user query. Used by the manual-create
      // follow-up flow that wants to materialize cached daily values for
      // exactly the user who just created a holding.
      userId?: string;
    } = {}
  ): Promise<RollupSummary> {
    const start = Date.now();
    const lookback = opts.lookbackDays ?? 30;
    const summary: RollupSummary = {
      usersProcessed: 0,
      daysComputed: 0,
      usersSkipped: 0,
      errors: [],
      durationMs: 0,
    };

    // Freeze "now" once per run so all users land on the same day
    // boundaries — `Date.now()` drifting across a long run could bucket
    // two users on different days at midnight UTC, producing inconsistent
    // snapshots. Pre-compute the lookback day list here too.
    const runStart = new Date();
    const days: Array<{ at: Date; snapshotDate: string }> = [];
    for (let i = 0; i < lookback; i++) {
      const day = new Date(runStart.getTime() - i * 24 * 60 * 60 * 1000);
      // Today's bucket uses the exact runStart so we get a real "right
      // now" snapshot rather than pretending it's end-of-day UTC in the
      // future. All earlier days snap to 23:59:59.999Z as the "as-of"
      // instant for that day.
      if (i > 0) day.setUTCHours(23, 59, 59, 999);
      const snapshotDate = day.toISOString().slice(0, 10);
      days.push({ at: day, snapshotDate });
    }

    // Iterate users in pages so we don't load the whole users table at
    // once. Filter to users that have a base currency configured — the
    // valuation call throws otherwise and there's nothing to rollup.
    // When `userId` is set, skip pagination entirely and look up that
    // single user.
    const PAGE = 500;
    let offset = 0;
    while (true) {
      const page = opts.userId
        ? await db
            .select({
              id: schema.users.id,
              baseCurrencyId: schema.users.baseCurrencyId,
              costBasisMethod: schema.users.costBasisMethod,
            })
            .from(schema.users)
            .where(
              and(eq(schema.users.id, opts.userId), sql`${schema.users.baseCurrencyId} IS NOT NULL`)
            )
            .limit(1)
        : await db
            .select({
              id: schema.users.id,
              baseCurrencyId: schema.users.baseCurrencyId,
              costBasisMethod: schema.users.costBasisMethod,
            })
            .from(schema.users)
            .where(sql`${schema.users.baseCurrencyId} IS NOT NULL`)
            .limit(PAGE)
            .offset(offset);
      if (page.length === 0) break;

      // Each user's rollup is independently prefetch-scoped and guarded by
      // a per-user advisory lock, so process them in bounded-concurrency
      // batches instead of strictly one after another.
      const USER_CONCURRENCY = 8;
      const processUser = async (user: (typeof page)[number]): Promise<void> => {
        if (!user.baseCurrencyId) return; // type-narrow; already filtered
        const baseCurrencyId = user.baseCurrencyId;
        try {
          // Per-user advisory lock: serializes this user's rollup against
          // any concurrent run (the cron sweep + a user-initiated
          // portfolio-history-backfill, two cron containers overlapping
          // on a redeploy, …). Lock-held users are skipped — the holder
          // is producing fresh rows; we'll catch this user the next tick.
          const outcome = await withAdvisoryLock(rollupLockKey(user.id), async () => {
            // Pre-load every per-user state BalanceAtTimeService and
            // CostBasisService would otherwise hit the DB for —
            // holdings (anchor 2), observations (anchors 1 and 3),
            // and transactions (every walk). Three bulk queries up
            // front replace ~350k per-(holding, day) DB reads. Falls
            // through silently to the per-call DB path for anything
            // a future code path needs but the prefetch missed.
            const userHoldings = await this.holdingRepository.findByUser(user.id);

            // Prefetch all the prices the inner per-(day, holding)
            // loop is about to ask for — single query instead of
            // ~80k. Any pair the prefetch did not cover falls through
            // to the per-call DB path rather than answering "no price".
            const priceLookup = await this.priceGraphService.buildPriceLookup(
              userHoldings.map((h) => h.tokenId),
              baseCurrencyId,
              runStart
            );
            const holdingIds = userHoldings.map((h) => h.id);
            // Coverage joins the same prefetch: `has_complete_tx_history`
            // is a property of the import, not of the snapshot date, so
            // one read serves all `lookback` days (SC-149).
            const [txHistory, observations, coverageByHolding] = await Promise.all([
              this.txRepository.findForHoldingsAll(holdingIds),
              this.observationRepository.findForHoldingsAll(holdingIds),
              this.coverageRepository.findManyByHoldingIds(holdingIds),
            ]);

            // Resolved once for all `lookback` days: "never had a price
            // row and still in cooldown" is a statement about the token's
            // entire history, not about any one snapshot date, so the
            // same set is correct for every day in the window (SC-146).
            const unpriceableTokenIds =
              await this.tokenRepository.findNeverPricedInCooldownTokenIds(
                [...new Set(userHoldings.map((h) => h.tokenId))],
                runStart
              );
            const caches: BalanceAtTimeCaches = {
              holdings: new Map(userHoldings.map((h) => [h.id, h])),
              observations,
              transactions: txHistory,
            };

            // Resolve institution membership once: each account → its
            // institution_id. Drives the per-scope aggregation below.
            const accounts = await this.accountRepository.findByUser(user.id);
            const accountIdToInstitution = new Map(accounts.map((a) => [a.id, a.institutionId]));
            const institutionIds = [...new Set(accounts.map((a) => a.institutionId))];

            let daysForUser = 0;
            for (const { at, snapshotDate } of days) {
              // ONE getPnL call per day at the user (broadest) scope.
              // The result's perHolding[] gives us everything we need
              // to derive every smaller scope below by filtering and
              // aggregating in-memory — no extra DB or pricing work.
              const userResult = await this.pnlService.getPnL(user.id, at, baseCurrencyId, {
                priceLookup,
                caches,
                unpriceableTokenIds,
                coverageByHolding,
                // Every row this loop writes is stamped with the rule it was
                // computed under, in the sense that it was computed under
                // whatever the account had set at the time (SC-462). Changing
                // the setting therefore does not rewrite history by itself —
                // the rows move as the rollup re-walks each day in its
                // lookback window, which is why the change is announced to the
                // reader rather than applied silently.
                costBasisMethod: parseCostBasisMethod(user.costBasisMethod),
              });

              // Write the user-scope row directly from the result.
              await this.dailyRepository.upsert({
                userId: user.id,
                scopeKind: 'user',
                scopeId: user.id,
                snapshotDate,
                baseCurrencyId,
                totalValue: userResult.totalValueInBase.toString(),
                coverageQuality: userResult.coverageQuality,
                holdingsWithKnownValue: userResult.holdingsWithKnownValue,
                holdingsTotal: userResult.holdingsTotal,
                holdingsUnpriceable: userResult.holdingsUnpriceable,
                holdingsStalePriced: userResult.holdingsStalePriced,
                holdingsStaleAnchored: userResult.holdingsStaleAnchored,
                oldestAnchorAt: userResult.oldestAnchorAt,
                holdingsBeforeRecords: userResult.holdingsBeforeRecords,
                holdingsBasisUnknown: userResult.holdingsBasisUnknown,
                transfersUnreviewed: userResult.transfersUnreviewed,
                costBasis: userResult.totalCostBasis.toString(),
                realizedPnl: userResult.totalRealizedPnl.toString(),
                unrealizedPnl: userResult.totalUnrealizedPnl.toString(),
              });

              // Now derive per-institution / per-account / per-holding
              // rows by filtering the same perHolding[] and aggregating.
              for (const institutionId of institutionIds) {
                const slice = userResult.perHolding.filter(
                  (ph) => accountIdToInstitution.get(ph.accountId) === institutionId
                );
                await this.upsertScopeRow(
                  user.id,
                  baseCurrencyId,
                  snapshotDate,
                  'institution',
                  institutionId,
                  slice
                );
              }
              for (const account of accounts) {
                const slice = userResult.perHolding.filter((ph) => ph.accountId === account.id);
                await this.upsertScopeRow(
                  user.id,
                  baseCurrencyId,
                  snapshotDate,
                  'account',
                  account.id,
                  slice
                );
              }
              for (const h of userHoldings) {
                const slice = userResult.perHolding.filter((ph) => ph.holdingId === h.id);
                await this.upsertScopeRow(
                  user.id,
                  baseCurrencyId,
                  snapshotDate,
                  'holding',
                  h.id,
                  slice
                );
              }
              daysForUser++;
            }
            return daysForUser;
          });

          if (!outcome.ran) {
            summary.usersSkipped++;
            logger.info(
              { userId: user.id },
              'Rollup skipped for user — another instance holds the lock'
            );
            return;
          }

          summary.usersProcessed++;
          summary.daysComputed += outcome.result;
        } catch (error) {
          summary.errors.push({
            userId: user.id,
            error: error instanceof Error ? error.message : String(error),
          });
          logger.warn(
            { userId: user.id, error: error instanceof Error ? error.message : error },
            'Rollup failed for one user; continuing'
          );
        }
      };

      for (let i = 0; i < page.length; i += USER_CONCURRENCY) {
        await Promise.all(page.slice(i, i + USER_CONCURRENCY).map(processUser));
      }

      if (opts.userId) break; // single-user mode: one page, done
      offset += PAGE;
      if (page.length < PAGE) break;
    }

    summary.durationMs = Date.now() - start;
    logger.info({ summary }, 'Portfolio value daily rollup complete');
    return summary;
  }

  // Aggregate a slice of `perHolding` (institution / account / holding
  // subset) into a single rollup row and upsert it. Mirrors the
  // totals + coverage_quality logic in PortfolioValuationAtTimeService
  // — keep them in sync. Empty slice → zeroed row with
  // coverage='unknown': nothing was priced, so the zero is an absence
  // of measurement rather than a measured zero.
  //
  // Including the stale-price downgrade to 'partial', which this method
  // used to omit (SC-151). That omission was not cosmetic: the home chart
  // and both exports are built from the **per-holding** scope rows written
  // here, not from the user-scope row above, and `aggregateIncludedHoldingRows`
  // decides a day is 'partial' by looking for a 'partial' among them. No
  // writer ever produced one, so its `anyPartial` branch was unreachable
  // and every stale price arrived at the reader indistinguishable from a
  // quote taken on the day.
  private async upsertScopeRow(
    userId: string,
    baseCurrencyId: string,
    snapshotDate: string,
    scopeKind: 'institution' | 'account' | 'holding',
    scopeId: string,
    slice: PnLAtTimePerHolding[]
  ): Promise<void> {
    let totalValue = new Decimal(0);
    let totalCost = new Decimal(0);
    let totalRealized = new Decimal(0);
    let knownCount = 0;
    let unpriceableCount = 0;
    let stalePricedCount = 0;
    // Re-derived per scope rather than inherited from the user row: a
    // stale anchor on one holding is a fact about the institution, account
    // and holding rows that contain it, and not about the ones that do not.
    // Copying the user-wide number down would mark every scope 'partial'
    // because one unrelated holding was.
    let staleAnchoredCount = 0;
    // Re-derived per scope for the same reason `staleAnchoredCount` is: a
    // balance projected below its holding's first evidence is a fact about
    // the scopes containing that holding and about no others.
    let beforeRecordsCount = 0;
    let oldestAnchorAt: Date | null = null;
    let basisUnknownCount = 0;
    let transfersUnreviewed = 0;
    for (const ph of slice) {
      if (ph.value !== null) {
        totalValue = totalValue.add(ph.value);
        knownCount++;
        if (ph.priceStale) stalePricedCount++;
        if (ph.anchorSource === 'observation-before') {
          staleAnchoredCount++;
          if (ph.anchorAt && (!oldestAnchorAt || ph.anchorAt < oldestAnchorAt)) {
            oldestAnchorAt = ph.anchorAt;
          }
        }
        if (ph.balanceBeforeRecords) beforeRecordsCount++;
      }
      if (ph.unpriceable) {
        unpriceableCount++;
        continue; // out of the value side, out of the cost side
      }
      if (ph.basisQuality !== 'known') basisUnknownCount++;
      // Written here and not only on the user-scope row above: the home
      // chart, the PnL series and both exports are built from these
      // per-holding rows, so a quality signal that only reaches the user row
      // reaches nobody. That is exactly how SC-151's stale-price downgrade
      // was invisible for two tickets.
      transfersUnreviewed += ph.transfersUnreviewed;
      totalCost = totalCost.add(ph.costBasis);
      totalRealized = totalRealized.add(ph.realizedPnl);
    }
    const totalUnrealized = totalValue.minus(totalCost);
    const holdingsTotal = slice.length;
    const priceableTotal = holdingsTotal - unpriceableCount;
    let coverageQuality: CoverageQuality;
    if (priceableTotal === 0) {
      coverageQuality = 'unknown';
    } else {
      const knownRatio = knownCount / priceableTotal;
      if (knownRatio >= COVERAGE_FULL_THRESHOLD)
        // `staleAnchoredCount` was missing from this condition until SC-249,
        // and its absence made the scoped rows disagree with the user row
        // about the same holdings. `PortfolioValuationAtTimeService` has
        // always downgraded on a backward anchor; this mirror of its logic
        // only downgraded on a stale price. So an account whose one holding
        // was reconstructed from an observation 71 days back read 'full' on
        // its own detail chart while the user-wide chart above it read
        // 'partial' — and the detail chart is the one a reader opens to find
        // out why.
        //
        // `beforeRecordsCount` joined it in SC-252, and this mirror is the
        // half that matters: the home chart, the PnL series and both exports
        // read these per-holding rows, so a downgrade applied only in
        // `PortfolioValuationAtTimeService` above would reach no reader at
        // all. Production held `total_value = 586.94, coverage_quality =
        // 'full'` for 2025-06-21 on a holding whose first transaction is
        // 2026-06-22 — every other quality signal on that row reads clean,
        // which is precisely why it read 'full'.
        coverageQuality =
          staleAnchoredCount > 0 || stalePricedCount > 0 || beforeRecordsCount > 0
            ? 'partial'
            : 'full';
      else if (knownRatio >= COVERAGE_PARTIAL_THRESHOLD) coverageQuality = 'estimated';
      else coverageQuality = 'unknown';
    }
    await this.dailyRepository.upsert({
      userId,
      scopeKind,
      scopeId,
      snapshotDate,
      baseCurrencyId,
      totalValue: totalValue.toString(),
      coverageQuality,
      holdingsWithKnownValue: knownCount,
      holdingsTotal,
      holdingsUnpriceable: unpriceableCount,
      holdingsStalePriced: stalePricedCount,
      holdingsStaleAnchored: staleAnchoredCount,
      oldestAnchorAt,
      // Recorded, not just consulted (SC-317). It has driven the downgrade
      // since SC-252 and reached no column, so the row said 'partial' with
      // every count at zero — confidence reduced, cause unstated.
      holdingsBeforeRecords: beforeRecordsCount,
      holdingsBasisUnknown: basisUnknownCount,
      transfersUnreviewed,
      costBasis: totalCost.toString(),
      realizedPnl: totalRealized.toString(),
      unrealizedPnl: totalUnrealized.toString(),
    });
  }
}
