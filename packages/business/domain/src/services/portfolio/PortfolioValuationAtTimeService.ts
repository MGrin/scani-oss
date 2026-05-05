import type { CoverageQuality } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { UserRepository } from '../../repositories/UserRepository';
import { BalanceAtTimeService } from '../pricing/BalanceAtTimeService';
import { PriceGraphService } from '../pricing/PriceGraphService';
import type { PriceLookup } from '../pricing/PriceLookup';

export interface PortfolioValueAtTimePerHolding {
  holdingId: string;
  accountId: string;
  tokenId: string;
  balance: Decimal | null;
  valueInBase: Decimal | null;
  anchorSource: string | null;
  pricePath: string | null;
  priceEffectiveAt: Date | null;
}

export interface PortfolioValueAtTimeResult {
  userId: string;
  at: Date;
  baseCurrencyId: string;
  totalValueInBase: Decimal;
  coverageQuality: CoverageQuality;
  holdingsWithKnownValue: number;
  holdingsTotal: number;
  perHolding: PortfolioValueAtTimePerHolding[];
}

// Heuristic thresholds for coverage_quality:
//   full      = ≥ 95% of holdings priced and anchor=='holdings'|'observation-after'
//   partial   = ≥ 95% priced but some via stale anchor
//   estimated = 50%–95% priced
//   unknown   = < 50% priced
//
// 95% (not 100%) because real-world portfolios always include a long
// tail of pump.fun memecoins / wallet-airdrop dust that no provider
// indexes. Requiring 100% means coverage_quality is permanently
// "estimated" for any user with a Solana wallet, which the user
// fairly called out as misleading — those 1–3 unpriced micro-balances
// barely affect the total but tank the chart's quality badge.
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
  private readonly balanceAtTimeService = Container.get(BalanceAtTimeService);
  private readonly priceGraphService = Container.get(PriceGraphService);
  private readonly userRepository = Container.get(UserRepository);

  async getPortfolioValue(
    userId: string,
    at: Date,
    baseCurrencyId?: string,
    opts: { priceLookup?: PriceLookup } = {}
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

    // Exclude holdings that didn't exist on the snapshot date. A
    // manual / screenshot holding created today shouldn't pad
    // `holdings_total` for past dates — that distorts the
    // `holdings_with_known_value / holdings_total` ratio and pushes
    // the coverage_quality badge into 'estimated' / 'unknown' for
    // dates where every holding that DID exist was priced just fine.
    // BalanceAtTimeService still propagates the current balance
    // backward via the "holdings current" anchor for holdings whose
    // first activity was after `at`; we explicitly skip those here so
    // they neither contribute value nor inflate the denominator.
    const holdings = allHoldings.filter((h) => h.createdAt.getTime() <= at.getTime());

    const perHolding: PortfolioValueAtTimePerHolding[] = [];
    let total = new Decimal(0);
    let knownCount = 0;
    let anyStaleAnchor = false;

    for (const h of holdings) {
      const result = await this.balanceAtTimeService.getBalance(h.id, at);

      if (!result.balance) {
        perHolding.push({
          holdingId: h.id,
          accountId: h.accountId,
          tokenId: h.tokenId,
          balance: null,
          valueInBase: null,
          anchorSource: result.anchor,
          pricePath: null,
          priceEffectiveAt: null,
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
        perHolding.push({
          holdingId: h.id,
          accountId: h.accountId,
          tokenId: h.tokenId,
          balance: result.balance,
          valueInBase: result.balance, // 0
          anchorSource: result.anchor,
          pricePath: 'zero-balance',
          priceEffectiveAt: result.anchorAt,
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
        // but NOT "known value" — keep it out of the total.
        perHolding.push({
          holdingId: h.id,
          accountId: h.accountId,
          tokenId: h.tokenId,
          balance: result.balance,
          valueInBase: null,
          anchorSource: result.anchor,
          pricePath: null,
          priceEffectiveAt: null,
        });
        continue;
      }

      total = total.add(priced.amount);
      knownCount += 1;
      if (result.anchor === 'observation-before') {
        anyStaleAnchor = true;
      }

      perHolding.push({
        holdingId: h.id,
        accountId: h.accountId,
        tokenId: h.tokenId,
        balance: result.balance,
        valueInBase: priced.amount,
        anchorSource: result.anchor,
        pricePath: priced.path,
        priceEffectiveAt: priced.effectiveAt,
      });
    }

    const holdingsTotal = holdings.length;
    let coverageQuality: CoverageQuality;
    if (holdingsTotal === 0) {
      // No holdings at all — not "unknown" (we know it was empty), but
      // there's nothing to chart either. 'full' is correct: zero is zero.
      coverageQuality = 'full';
    } else {
      const knownRatio = knownCount / holdingsTotal;
      if (knownRatio >= COVERAGE_FULL_THRESHOLD) {
        coverageQuality = anyStaleAnchor ? 'partial' : 'full';
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
      perHolding,
    };
  }
}
