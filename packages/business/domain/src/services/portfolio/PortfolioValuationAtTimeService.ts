import type { DatabaseTransaction } from '@scani/db';
import type { CoverageQuality } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import type { PriceAsk } from '../../engine/types';
import { coverageQualityOf } from '../../lib/coverage-quality';
import { holdingCountsInTotal } from '../../lib/holding-inclusion';
import { AccountRepository } from '../../repositories/AccountRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import { UserRepository } from '../../repositories/UserRepository';
import { type BalanceAtTimeCaches, BalanceAtTimeService } from '../pricing/BalanceAtTimeService';
import { PriceReader, type PriceSeries } from '../pricing/PriceReader';
import { InTransitService, type TransitAmount } from './InTransitService';

// Scope for per-entity portfolio queries — the same valuation
// pipeline used for the user-wide chart now also drives the
// institution / account / holding detail-page charts.
export type PortfolioValueScope =
  | { kind: 'user' }
  | { kind: 'institution'; id: string }
  | { kind: 'account'; id: string }
  | { kind: 'holding'; id: string };

interface PortfolioValueAtTimePerHolding {
  holdingId: string;
  accountId: string;
  tokenId: string;
  balance: Decimal | null;
  valueInBase: Decimal | null;
  anchorSource: string | null;
  /**
   * When the anchor `anchorSource` names was observed. Carried because
   * `anchorSource` alone cannot rank two reconstructions: `observation-before`
   * says the balance was extrapolated forward from older data, and only this
   * says whether "older" means 54 seconds or 71 days (SC-249).
   */
  anchorAt: Date | null;
  pricePath: string | null;
  priceEffectiveAt: Date | null;
  /**
   * We could not price this holding and no provider ever will: its token
   * has never had a price row and is inside an unpriceable cooldown. Such
   * a holding is real and stays in `perHolding`, but it is excluded from
   * the coverage denominator — see `holdingsUnpriceable` (SC-146).
   */
  unpriceable: boolean;
  /**
   * The price that produced `valueInBase` is past its asset class's
   * staleness horizon (`STALENESS_HORIZON_MS`, SC-151). The value is still
   * counted — see the note on `holdingsStalePriced` — but it is not a
   * quote from the day it is presented as, and `priceEffectiveAt` says
   * from when it actually is.
   */
  priceStale: boolean;
  /**
   * `at` precedes every record we hold for this holding — its first
   * transaction, its first observation and the holding row itself all
   * begin later (SC-252). `balance` is still populated: below that point
   * the walk covers the whole ledger, so what it returns is the
   * unexplained opening balance projected backward, which is the best
   * guess available and is what the history chart is built on. It is not
   * a measurement, and this says so.
   */
  balanceBeforeRecords: boolean;
}

/** Money answered `internal` to a provider-fed holding and in neither balance at `at` (SC-1675). */
export interface TransitAtTime {
  outflowId: string;
  destinationHoldingId: string;
  tokenId: string;
  quantity: Decimal;
  valueInBase: Decimal | null;
}

export interface PortfolioValueAtTimeResult {
  userId: string;
  at: Date;
  baseCurrencyId: string;
  totalValueInBase: Decimal;
  coverageQuality: CoverageQuality;
  holdingsWithKnownValue: number;
  /** Every holding in scope, unpriceable dust included. */
  holdingsTotal: number;
  /**
   * Of `holdingsTotal`, the ones nothing can price. Coverage is
   * `holdingsWithKnownValue / (holdingsTotal - holdingsUnpriceable)`.
   */
  holdingsUnpriceable: number;
  /**
   * Of `holdingsWithKnownValue`, how many were valued from a price older
   * than the freshness window (SC-151).
   *
   * They stay in the total on purpose. Dropping them would open a hole in
   * the chart on a pure data-gap day, and an old price is still the best
   * measurement we have of what something is worth — the defect was never
   * that we used it, it was that we presented it with the same confidence
   * as a quote from this morning. So it counts toward the total, degrades
   * the day to `coverage_quality: 'partial'`, and is *counted* here so the
   * chart, the PnL series and both exports can each say how much of the
   * figure is old rather than leaving the reader to assume none of it is.
   */
  holdingsStalePriced: number;
  /**
   * Of `holdingsWithKnownValue`, how many had their balance extrapolated
   * FORWARD from an observation before `at`, because nothing at or after it
   * existed to anchor on (SC-249).
   *
   * The sibling of `holdingsStalePriced`, and deliberately separate from it:
   * both degrade the day to `'partial'`, but a stale PRICE means the quantity
   * is known and its valuation is old, while a stale ANCHOR means the
   * quantity itself is a projection. Collapsing them into one indicator —
   * which is all a reader had until now — hides which of the two happened
   * and offers no remedy, because the remedies are different.
   */
  holdingsStaleAnchored: number;
  /**
   * The oldest anchor among the backward-anchored holdings: the far end of
   * the weakest reconstruction behind this total. `null` when none were.
   *
   * This is the number that ranks two `'partial'` days against each other.
   * Production has both extremes in the same portfolio — one holding anchored
   * seconds back, another months back (SC-245) — and without it they are the
   * same answer.
   */
  oldestAnchorAt: Date | null;
  /**
   * Of `holdingsWithKnownValue`, how many were valued from a balance that
   * predates every record we hold for the holding (SC-252).
   *
   * The third member of the family `holdingsStalePriced` and
   * `holdingsStaleAnchored` belong to, and separate from both for the same
   * reason they are separate from each other: the remedies differ. A stale
   * price wants a fresh quote; a stale anchor wants a sync; this wants
   * older history imported, or the admission that none exists. What it has
   * in common with them is that the figure still counts and the day stops
   * being 'full'.
   */
  holdingsBeforeRecords: number;
  /**
   * Always 0 since A5 PR-2: the engine draws no line across an unexplained
   * gap between two readings (SC-475 fault B). Kept while the stored column
   * is (SC-1624).
   */
  holdingsInterpolated: number;
  perHolding: PortfolioValueAtTimePerHolding[];
  /** User scope only: an account or institution scope carries none, the money being in neither. */
  inTransit?: TransitAtTime[];
}

// Computes portfolio value for a user at any past time T, in any display
// currency. Walks per-holding balance-at-time, prices each balance from
// one price series (`priceAt`, D-13), aggregates.
//
// The result carries coverage_quality so the caller (chart renderer, rollup
// cron) can honestly represent data completeness without fabricating numbers
// for missing days.
@Service()
export class PortfolioValuationAtTimeService {
  // Class-field DI — see `.claude/rules/typedi-di.md`.
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly balanceAtTimeService = Container.get(BalanceAtTimeService);
  private readonly priceReader = Container.get(PriceReader);
  private readonly userRepository = Container.get(UserRepository);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly inTransitService = Container.get(InTransitService);

  async getPortfolioValue(
    userId: string,
    at: Date,
    baseCurrencyId: string | undefined,
    opts: {
      /** Loaded over `priceAsks` for at least this instant. Omitted, one is loaded. */
      prices?: PriceSeries;
      scope?: PortfolioValueScope;
      // Pre-loaded per-user caches that BalanceAtTimeService can use
      // instead of per-call DB reads. Threaded through from the
      // rollup loop; ad-hoc callers omit and pay the DB cost.
      caches?: BalanceAtTimeCaches;
      // Tokens nothing can price (never priced + in cooldown). The
      // rollup resolves this once per user and hands the same set to
      // all 30 days — the predicate is about the token's whole history,
      // so it does not vary by `at`. Omit and one query resolves it.
      unpriceableTokenIds?: ReadonlySet<string>;
      /** Amounts in transit, computed once for every instant the caller values (the rollup). Omitted, read for `at`. */
      transitAmounts?: readonly TransitAmount[];
      /**
       * The database transaction every read on this call goes through, or
       * `undefined` for the pool. REQUIRED — see PriceGraphOptions.tx
       * (SC-600). This is the entry point the measurement was taken on:
       * inside one `withTestDb` callback the transaction saw 1 holding and
       * this pass saw 0, so every total below was computed over an empty
       * portfolio and reported as a number.
       */
      tx: DatabaseTransaction | undefined;
    }
  ): Promise<PortfolioValueAtTimeResult> {
    // Resolve display base. Fall back to user's configured base_currency_id
    // when caller didn't specify — mirrors the current dashboard convention.
    let effectiveBaseId = baseCurrencyId;
    if (!effectiveBaseId) {
      const user = await this.userRepository.findById(userId, opts.tx);
      effectiveBaseId = user?.baseCurrencyId ?? undefined;
    }
    if (!effectiveBaseId) {
      throw new Error(
        `Cannot compute portfolio value at time: user ${userId} has no base currency and caller supplied none`
      );
    }

    const holdings = await this.countedHoldings(userId, opts.scope, opts.tx);
    const prices =
      opts.prices ??
      (await this.priceReader.series(
        holdings.map((h) => ({ tokenId: h.tokenId, at })),
        effectiveBaseId,
        opts.tx
      ));

    const unpriceableTokenIds =
      opts.unpriceableTokenIds ??
      (await this.tokenRepository.findNeverPricedInCooldownTokenIds(
        [...new Set(holdings.map((h) => h.tokenId))],
        new Date(),
        opts.tx
      ));

    const perHolding: PortfolioValueAtTimePerHolding[] = [];
    let total = new Decimal(0);
    let knownCount = 0;
    let unpriceableCount = 0;
    let stalePricedCount = 0;

    // Holdings whose earliest record is after `at`. They are absent from the
    // day rather than valued on it: `BalanceAtTimeService` would hand back
    // today's balance, and at each past day's price that drew a holding added
    // a minute ago as held for 400 days — "Down $2,132 since 31 Dec 2025" to a
    // newcomer, and "+5.2% vs 30d" once a second, older holding kept those
    // days on the chart (SC-1323). SC-252 had already stopped calling such a
    // day 'full'; nothing we hold says what the balance was, so it now counts
    // nothing. The day the holding appears, its value is a contribution —
    // `ReturnsService` books it as one.
    let absentCount = 0;

    for (const h of holdings) {
      const result = await this.balanceAtTimeService.getBalance(h.id, at, opts.tx, opts.caches);
      if (result.beforeRecords) {
        absentCount += 1;
        continue;
      }
      // Only ever consulted on a branch that produced no value —
      // a holding we *did* price is priceable by demonstration, and a
      // zero balance is worth zero in any currency. Keeping the flag off
      // those branches is what guarantees knownCount can never exceed
      // the priceable denominator below.
      const tokenUnpriceable = unpriceableTokenIds.has(h.tokenId);

      if (!result.balance) {
        if (tokenUnpriceable) unpriceableCount += 1;
        perHolding.push({
          holdingId: h.id,
          accountId: h.accountId,
          tokenId: h.tokenId,
          balance: null,
          valueInBase: null,
          anchorSource: result.anchor,
          anchorAt: result.anchorAt,
          pricePath: null,
          priceEffectiveAt: null,
          unpriceable: tokenUnpriceable,
          priceStale: false,
          balanceBeforeRecords: result.beforeRecords,
        });
        continue;
      }

      // Zero-balance short-circuit: when the historical balance is 0
      // the value in any base currency is trivially 0, no price lookup
      // needed. Without this short-circuit, historically-traded-but-
      // currently-empty holdings (fiat pairs used in Kraken trades,
      // fully-sold altcoins) force every rollup day to 'estimated'
      // whenever their price cannot be found.
      // Zero × unknown = 0; counting it as "known" is factually
      // correct and keeps the chart's coverage quality honest.
      if (result.balance.isZero()) {
        total = total.add(0);
        knownCount += 1;
        perHolding.push({
          holdingId: h.id,
          accountId: h.accountId,
          tokenId: h.tokenId,
          balance: result.balance,
          valueInBase: result.balance, // 0
          anchorSource: result.anchor,
          anchorAt: result.anchorAt,
          pricePath: 'zero-balance',
          // Was `result.anchorAt` until SC-249, which is the BALANCE
          // anchor's time, not a price's. No price is looked up on this
          // branch, so the honest answer is null and the anchor time now
          // has its own field. Nothing read it — grep found no consumer of
          // `priceEffectiveAt` outside this file — so the smear was
          // invisible rather than harmless.
          priceEffectiveAt: null,
          unpriceable: false,
          priceStale: false,
          balanceBeforeRecords: result.beforeRecords,
        });
        continue;
      }

      // The engine's answer at `at` (D-13, D-14): the freshest route over the
      // nearest readings at or before it, stale per leg by each token's class.
      const answer = prices.priceAt(h.tokenId, at);
      const priced = answer && {
        amount: result.balance.mul(answer.price),
        path: answer.path,
        effectiveAt: answer.readingAt,
        stale: answer.stale,
      };

      if (!priced) {
        // Balance known, value unknown. Still counts as "holding present"
        // but NOT "known value" — keep it out of the total. When the
        // token is unpriceable in fact it also leaves the denominator:
        // failing to price airdrop spam is not a failure of ours, and
        // reporting it as one is what made a fully-priced portfolio read
        // as 80% covered.
        if (tokenUnpriceable) unpriceableCount += 1;
        perHolding.push({
          holdingId: h.id,
          accountId: h.accountId,
          tokenId: h.tokenId,
          balance: result.balance,
          valueInBase: null,
          anchorSource: result.anchor,
          anchorAt: result.anchorAt,
          pricePath: null,
          priceEffectiveAt: null,
          unpriceable: tokenUnpriceable,
          priceStale: false,
          balanceBeforeRecords: result.beforeRecords,
        });
        continue;
      }

      total = total.add(priced.amount);
      knownCount += 1;
      if (priced.stale) {
        stalePricedCount += 1;
      }

      perHolding.push({
        holdingId: h.id,
        accountId: h.accountId,
        tokenId: h.tokenId,
        balance: result.balance,
        valueInBase: priced.amount,
        anchorSource: result.anchor,
        anchorAt: result.anchorAt,
        pricePath: priced.path,
        priceEffectiveAt: priced.effectiveAt,
        unpriceable: false,
        priceStale: priced.stale,
        balanceBeforeRecords: result.beforeRecords,
      });
    }

    const inTransit: TransitAtTime[] = [];
    if (!opts.scope || opts.scope.kind === 'user') {
      const counted = new Set(holdings.map((h) => h.id));
      const amounts =
        opts.transitAmounts?.filter((a) => a.at.getTime() === at.getTime()) ??
        (await this.inTransitService.amountsAt(userId, [at], opts.tx));
      for (const amount of amounts) {
        if (!counted.has(amount.destinationHoldingId)) continue;
        const answer = prices.priceAt(amount.tokenId, at);
        const valueInBase = answer ? amount.quantity.mul(answer.price) : null;
        if (valueInBase) total = total.add(valueInBase);
        inTransit.push({
          outflowId: amount.outflowId,
          destinationHoldingId: amount.destinationHoldingId,
          tokenId: amount.tokenId,
          quantity: amount.quantity,
          valueInBase,
        });
      }
    }

    const holdingsTotal = holdings.length - absentCount;
    const coverageQuality = coverageQualityOf({
      withKnownValue: knownCount,
      total: holdingsTotal,
      unpriceable: unpriceableCount,
      degraded: stalePricedCount > 0,
    });

    return {
      userId,
      at,
      baseCurrencyId: effectiveBaseId,
      totalValueInBase: total,
      coverageQuality,
      holdingsWithKnownValue: knownCount,
      holdingsTotal,
      holdingsUnpriceable: unpriceableCount,
      holdingsStalePriced: stalePricedCount,
      // The engine walks forward from a reading on every day after it, which
      // is not a stale anchor; a balance's staleness is A4's (A5 D-14).
      holdingsStaleAnchored: 0,
      oldestAnchorAt: null,
      // A holding before its records is now absent rather than counted (SC-1323).
      holdingsBeforeRecords: 0,
      // The engine draws no line across a gap (A5 PR-2); the column goes
      // with the other always-zero counts (SC-1624).
      holdingsInterpolated: 0,
      perHolding,
      ...(inTransit.length > 0 ? { inTransit } : {}),
    };
  }

  // Filter the user's holdings down to a single entity scope.
  // Institution scope requires loading the user's accounts to map
  // institution_id → account_id list (cheap; one query). Generic so
  // the caller's Holding row type (with all its columns) survives.
  /** Every price `getPortfolioValue` reads at these instants: each holding it counts, at each. */
  async priceAsks(
    userId: string,
    instants: readonly Date[],
    opts: { scope?: PortfolioValueScope; tx: DatabaseTransaction | undefined }
  ): Promise<PriceAsk[]> {
    const holdings = await this.countedHoldings(userId, opts.scope, opts.tx);
    return holdings.flatMap((h) => instants.map((at) => ({ tokenId: h.tokenId, at })));
  }

  // Valued against `at` regardless of current visibility: the history chart
  // shouldn't change retroactively when a holding is later hidden. Inactive is
  // not a visibility flag: `findByUser` returns those rows "visible but
  // excluded from totals", Home excludes them, and counting one here put a
  // deactivated $888K position on every day of a chart whose Home read ~$117K
  // (SC-1328). Hidden ones are fetched and the inclusion rule decides: a
  // position the closed-position sweep hid is still history, and dropping it
  // took its whole realized PnL out of every past day (SC-1486). Scam tokens
  // are already filtered by `findByUser`. A holding is valued only on days its
  // own records reach — see the `beforeRecords` skip (SC-1323).
  async countedHoldings(
    userId: string,
    scope: PortfolioValueScope | undefined,
    tx: DatabaseTransaction | undefined
  ) {
    const all = (await this.holdingRepository.findByUser(userId, tx, true)).filter(
      holdingCountsInTotal
    );
    return this.applyScope(all, scope, userId, tx);
  }

  private async applyScope<H extends { id: string; accountId: string }>(
    holdings: H[],
    scope: PortfolioValueScope | undefined,
    userId: string,
    tx: DatabaseTransaction | undefined
  ): Promise<H[]> {
    if (!scope || scope.kind === 'user') return holdings;
    if (scope.kind === 'holding') {
      return holdings.filter((h) => h.id === scope.id);
    }
    if (scope.kind === 'account') {
      return holdings.filter((h) => h.accountId === scope.id);
    }
    // institution: resolve member account ids via AccountRepository
    const accounts = await this.accountRepository.findByUser(userId, tx);
    const accountIdsForInstitution = new Set(
      accounts.filter((a) => a.institutionId === scope.id).map((a) => a.id)
    );
    return holdings.filter((h) => accountIdsForInstitution.has(h.accountId));
  }
}
