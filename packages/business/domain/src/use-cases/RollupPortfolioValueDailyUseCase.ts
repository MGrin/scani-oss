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
import Decimal from 'decimal.js';
import { and, eq, sql } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { AccountRepository } from '../repositories/AccountRepository';
import { HoldingBalanceObservationRepository } from '../repositories/HoldingBalanceObservationRepository';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../repositories/HoldingTransactionRepository';
import { PortfolioValueDailyRepository } from '../repositories/PortfolioValueDailyRepository';
import { TokenPriceRepository } from '../repositories/TokenPriceRepository';
import { TokenRepository } from '../repositories/TokenRepository';
import { PnLAtTimeService } from '../services';
import type { PnLAtTimePerHolding } from '../services/portfolio/PnLAtTimeService';
import type { BalanceAtTimeCaches } from '../services/pricing/BalanceAtTimeService';
import { PriceLookup } from '../services/pricing/PriceLookup';

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

// Hub symbols PriceGraphService walks when no direct edge exists.
// Mirrored here so the prefetch knows which (token, hub) pairs to
// preload — keep in sync with PriceGraphService.resolveHubTokenIds.
const PRICE_HUB_SYMBOLS = ['USD', 'USDT', 'EUR'] as const;

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
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly txRepository = Container.get(HoldingTransactionRepository);
  private readonly observationRepository = Container.get(HoldingBalanceObservationRepository);

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
            .select({ id: schema.users.id, baseCurrencyId: schema.users.baseCurrencyId })
            .from(schema.users)
            .where(
              and(eq(schema.users.id, opts.userId), sql`${schema.users.baseCurrencyId} IS NOT NULL`)
            )
            .limit(1)
        : await db
            .select({ id: schema.users.id, baseCurrencyId: schema.users.baseCurrencyId })
            .from(schema.users)
            .where(sql`${schema.users.baseCurrencyId} IS NOT NULL`)
            .limit(PAGE)
            .offset(offset);
      if (page.length === 0) break;

      for (const user of page) {
        if (!user.baseCurrencyId) continue; // type-narrow; already filtered
        const baseCurrencyId = user.baseCurrencyId;
        try {
          // Per-user advisory lock: serializes this user's rollup against
          // any concurrent run (the cron sweep + a user-initiated
          // portfolio-history-backfill, two cron containers overlapping
          // on a redeploy, …). Lock-held users are skipped — the holder
          // is producing fresh rows; we'll catch this user the next tick.
          const outcome = await withAdvisoryLock(rollupLockKey(user.id), async () => {
            // Prefetch all the prices the inner per-(day, holding)
            // loop is about to ask for — single query instead of
            // ~80k. Falls through silently to the per-call DB path
            // for any pair the prefetch missed (defensive; should be
            // a no-op in practice).
            const priceLookup = await this.buildPriceLookup(user.id, baseCurrencyId, runStart);

            // Pre-load every per-user state BalanceAtTimeService and
            // CostBasisService would otherwise hit the DB for —
            // holdings (anchor 2), observations (anchors 1 and 3),
            // and transactions (every walk). Three bulk queries up
            // front replace ~350k per-(holding, day) DB reads. Falls
            // through silently to the per-call DB path for anything
            // a future code path needs but the prefetch missed.
            const userHoldings = await this.holdingRepository.findByUser(user.id);
            const holdingIds = userHoldings.map((h) => h.id);
            const [txHistory, observations] = await Promise.all([
              this.txRepository.findForHoldingsAll(holdingIds),
              this.observationRepository.findForHoldingsAll(holdingIds),
            ]);
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
            continue;
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
      }

      if (opts.userId) break; // single-user mode: one page, done
      offset += PAGE;
      if (page.length < PAGE) break;
    }

    summary.durationMs = Date.now() - start;
    logger.info({ summary }, 'Portfolio value daily rollup complete');
    return summary;
  }

  // Build the per-user price index used by the inner per-(day, holding)
  // loop. Pulls every row matching (heldToken | hub, base | hub, ts <=
  // runStart) — this is the union of every (from, to) tuple
  // PriceGraphService.tryDirect could ask for during the rollup pass.
  private async buildPriceLookup(
    userId: string,
    baseCurrencyId: string,
    until: Date
  ): Promise<PriceLookup> {
    const [holdings, hubIds] = await Promise.all([
      this.holdingRepository.findByUser(userId),
      this.resolveHubIds(),
    ]);
    const heldTokenIds = new Set(holdings.map((h) => h.tokenId));
    const baseAndHubs = new Set<string>([baseCurrencyId, ...hubIds]);
    // Pairs we'll query: every held token quoted in base + each hub,
    // plus every reverse leg (base -> heldToken, hub -> heldToken)
    // because PriceGraphService.tryDirect inverts when forward misses.
    // Plus base ↔ hub legs for the multi-hop conversions.
    const pairs: Array<{ tokenId: string; baseTokenId: string }> = [];
    const pushPair = (a: string, b: string): void => {
      if (a === b) return;
      pairs.push({ tokenId: a, baseTokenId: b });
    };
    for (const t of heldTokenIds) {
      for (const b of baseAndHubs) {
        pushPair(t, b);
        pushPair(b, t);
      }
    }
    // Hub ↔ hub legs (incl base ↔ hub).
    const hubArr = [...baseAndHubs];
    for (const a of hubArr) {
      for (const b of hubArr) {
        pushPair(a, b);
      }
    }
    const rows = await this.tokenPriceRepository.findManyForPairsUpTo(pairs, until);
    return new PriceLookup(rows);
  }

  private async resolveHubIds(): Promise<string[]> {
    const out: string[] = [];
    for (const symbol of PRICE_HUB_SYMBOLS) {
      const t = await this.tokenRepository.findBySymbol(symbol);
      if (t) out.push(t.id);
    }
    return out;
  }

  // Aggregate a slice of `perHolding` (institution / account / holding
  // subset) into a single rollup row and upsert it. Mirrors the
  // totals + coverage_quality logic in PortfolioValuationAtTimeService
  // — keep them in sync. Empty slice → zeroed row with coverage='full'
  // (matches the "no holdings in scope" degenerate case).
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
    for (const ph of slice) {
      if (ph.value !== null) {
        totalValue = totalValue.add(ph.value);
        knownCount++;
      }
      totalCost = totalCost.add(ph.costBasis);
      totalRealized = totalRealized.add(ph.realizedPnl);
    }
    const totalUnrealized = totalValue.minus(totalCost);
    const holdingsTotal = slice.length;
    let coverageQuality: CoverageQuality;
    if (holdingsTotal === 0) {
      coverageQuality = 'full';
    } else {
      const knownRatio = knownCount / holdingsTotal;
      if (knownRatio >= COVERAGE_FULL_THRESHOLD) coverageQuality = 'full';
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
      costBasis: totalCost.toString(),
      realizedPnl: totalRealized.toString(),
      unrealizedPnl: totalUnrealized.toString(),
    });
  }
}
