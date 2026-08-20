import type { CoverageQuality } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { AccountRepository } from '../../repositories/AccountRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import { UserRepository } from '../../repositories/UserRepository';
import { type BalanceAtTimeCaches, BalanceAtTimeService } from '../pricing/BalanceAtTimeService';
import { PriceGraphService } from '../pricing/PriceGraphService';
import type { PriceLookup } from '../pricing/PriceLookup';

// Scope for per-entity portfolio queries — the same valuation
// pipeline used for the user-wide chart now also drives the
// institution / account / holding detail-page charts.
export type PortfolioValueScope =
  | { kind: 'user' }
  | { kind: 'institution'; id: string }
  | { kind: 'account'; id: string }
  | { kind: 'holding'; id: string };

export interface PortfolioValueAtTimePerHolding {
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
   * The price that produced `valueInBase` is older than the
   * granularity-appropriate freshness window (SC-151). The value is still
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
   * Production has both extremes in the same portfolio — one holding
   * anchored 54 seconds back, another 71 days back (SC-245) — and without
   * it they are the same answer.
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
  perHolding: PortfolioValueAtTimePerHolding[];
}

// Heuristic thresholds for coverage_quality, applied to the *priceable*
// denominator (see `holdingsUnpriceable`):
//   full      = ≥ 95% of priceable holdings priced, anchor=='holdings'|'observation-after'
//   partial   = ≥ 95% priced but some via a stale anchor or a stale price
//   estimated = 50%–95% priced
//   unknown   = < 50% priced
//
// The 5% slack was originally the whole defence against wallet-airdrop
// dust, and it was not enough: an account with 14 spam tokens out of 69
// sat permanently at 80%, i.e. 'estimated', while every asset the user
// actually owns was priced (SC-146). Dust is now removed from the
// denominator outright rather than absorbed by a tolerance, and the
// slack covers what it was always meant to — a genuinely priceable
// token missing today's quote.
const COVERAGE_FULL_THRESHOLD = 0.95;
const COVERAGE_PARTIAL_THRESHOLD = 0.5;

// Computes portfolio value for a user at any past time T, in any display
// currency. Walks per-holding balance-at-time, prices each balance through
// the price graph, aggregates.
//
// The result carries coverage_quality so the caller (chart renderer, rollup
// cron) can honestly represent data completeness without fabricating numbers
// for missing days.
@Service()
export class PortfolioValuationAtTimeService {
  // Class-field DI — see note in BalanceAtTimeService.ts.
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly balanceAtTimeService = Container.get(BalanceAtTimeService);
  private readonly priceGraphService = Container.get(PriceGraphService);
  private readonly userRepository = Container.get(UserRepository);
  private readonly tokenRepository = Container.get(TokenRepository);

  async getPortfolioValue(
    userId: string,
    at: Date,
    baseCurrencyId?: string,
    opts: {
      priceLookup?: PriceLookup;
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
    } = {}
  ): Promise<PortfolioValueAtTimeResult> {
    // Resolve display base. Fall back to user's configured base_currency_id
    // when caller didn't specify — mirrors the current dashboard convention.
    let effectiveBaseId = baseCurrencyId;
    if (!effectiveBaseId) {
      const user = await this.userRepository.findById(userId);
      effectiveBaseId = user?.baseCurrencyId ?? undefined;
    }
    if (!effectiveBaseId) {
      throw new Error(
        `Cannot compute portfolio value at time: user ${userId} has no base currency and caller supplied none`
      );
    }

    // Pull all of the user's holdings. We value each against `at` regardless
    // of its current visibility flags — the history chart shouldn't change
    // retroactively when a holding is later hidden.
    const allHoldings = await this.holdingRepository.findByUser(userId);

    // Apply the per-entity scope filter (institution / account /
    // holding). Holdings created after `at` are kept in the pool —
    // BalanceAtTimeService's "holdings current" anchor propagates
    // their present balance backward (with at-time FX), which is the
    // intended behaviour for the history chart. An earlier revision
    // dropped them here to keep the coverage denominator honest, but
    // that produced an empty chart for users whose holdings were all
    // created in the last day or two (the typical onboarding case).
    const holdings = await this.applyScope(allHoldings, opts.scope, userId);

    const unpriceableTokenIds =
      opts.unpriceableTokenIds ??
      (await this.tokenRepository.findNeverPricedInCooldownTokenIds(
        [...new Set(holdings.map((h) => h.tokenId))],
        new Date()
      ));

    const perHolding: PortfolioValueAtTimePerHolding[] = [];
    let total = new Decimal(0);
    let knownCount = 0;
    let unpriceableCount = 0;
    // Was a bare boolean until SC-249. A boolean is exactly enough to pick
    // 'partial' and exactly not enough for a reader to do anything about it:
    // it cannot say how many holdings, nor how far back the worst one is.
    let staleAnchoredCount = 0;
    let oldestAnchorAt: Date | null = null;
    let stalePricedCount = 0;
    let beforeRecordsCount = 0;

    for (const h of holdings) {
      const result = await this.balanceAtTimeService.getBalance(h.id, at, opts.caches);
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
      // because PriceGraphService can't find a CHF→USD / GBP→USD edge.
      // Zero × unknown = 0; counting it as "known" is factually
      // correct and keeps the chart's coverage quality honest.
      if (result.balance.isZero()) {
        total = total.add(0);
        knownCount += 1;
        // A zero reconstructed below our earliest record is as unfounded as
        // a non-zero one: it is `current balance - sum(all known txs)`
        // landing on zero, not an observation of an empty position.
        if (result.beforeRecords) beforeRecordsCount += 1;
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

      // Price the balance. Prefer 'daily' for historical days (smoother,
      // less noisy chart) but fall through to intraday when `at` is
      // within the last 36h — today's daily close doesn't exist until
      // the 00:00 UTC roll, and using a stale daily (Kraken's last
      // available close can be months old for infrequently-traded
      // pairs) produces a chart value that diverges dramatically from
      // the live dashboard total. `preferGranularity: null` lets
      // findClosestPriceByGranularity pick whichever row has the most
      // recent timestamp ≤ `at`, which for `at = now` is the live
      // intraday row (same source the dashboard uses).
      const isRecent = Date.now() - at.getTime() < 36 * 60 * 60 * 1000;
      const priced = await this.priceGraphService.convert(
        result.balance,
        h.tokenId,
        effectiveBaseId,
        at,
        {
          ...(isRecent ? {} : { preferGranularity: 'daily' as const }),
          ...(opts.priceLookup ? { priceLookup: opts.priceLookup } : {}),
        }
      );

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
      if (result.beforeRecords) beforeRecordsCount += 1;
      if (result.anchor === 'observation-before') {
        staleAnchoredCount += 1;
        if (result.anchorAt && (!oldestAnchorAt || result.anchorAt < oldestAnchorAt)) {
          oldestAnchorAt = result.anchorAt;
        }
      }
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

    const holdingsTotal = holdings.length;
    const priceableTotal = holdingsTotal - unpriceableCount;
    let coverageQuality: CoverageQuality;
    if (priceableTotal === 0) {
      // Nothing in scope we could ever price, so `total` is 0 because we
      // measured nothing — not because the scope was worth nothing.
      // Calling that 'full' let the chart draw a confident €0 between two
      // days worth €25k (observed in production on institution-scope
      // rows), and the period delta was then computed against that zero.
      // A scope containing only unpriceable dust lands here too, which is
      // the same statement: we have no measurement of it.
      coverageQuality = 'unknown';
    } else {
      const knownRatio = knownCount / priceableTotal;
      if (knownRatio >= COVERAGE_FULL_THRESHOLD) {
        // `beforeRecordsCount` joined this condition in SC-252. Without it a
        // date more than a year before a holding's first transaction read
        // 'full' — the strongest claim the vocabulary has, about a period
        // nothing in our data describes.
        coverageQuality =
          staleAnchoredCount > 0 || stalePricedCount > 0 || beforeRecordsCount > 0
            ? 'partial'
            : 'full';
      } else if (knownRatio >= COVERAGE_PARTIAL_THRESHOLD) {
        coverageQuality = 'estimated';
      } else {
        coverageQuality = 'unknown';
      }
    }

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
      holdingsStaleAnchored: staleAnchoredCount,
      oldestAnchorAt,
      holdingsBeforeRecords: beforeRecordsCount,
      perHolding,
    };
  }

  // Filter the user's holdings down to a single entity scope.
  // Institution scope requires loading the user's accounts to map
  // institution_id → account_id list (cheap; one query). Generic so
  // the caller's Holding row type (with all its columns) survives.
  private async applyScope<H extends { id: string; accountId: string }>(
    holdings: H[],
    scope: PortfolioValueScope | undefined,
    userId: string
  ): Promise<H[]> {
    if (!scope || scope.kind === 'user') return holdings;
    if (scope.kind === 'holding') {
      return holdings.filter((h) => h.id === scope.id);
    }
    if (scope.kind === 'account') {
      return holdings.filter((h) => h.accountId === scope.id);
    }
    // institution: resolve member account ids via AccountRepository
    const accounts = await this.accountRepository.findByUser(userId);
    const accountIdsForInstitution = new Set(
      accounts.filter((a) => a.institutionId === scope.id).map((a) => a.id)
    );
    return holdings.filter((h) => accountIdsForInstitution.has(h.accountId));
  }
}
