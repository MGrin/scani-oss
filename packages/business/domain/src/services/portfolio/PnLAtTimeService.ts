import type { CoverageQuality } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { CostBasisService } from '../pricing/CostBasisService';
import type { PriceLookup } from '../pricing/PriceLookup';
import {
  PortfolioValuationAtTimeService,
  type PortfolioValueScope,
} from './PortfolioValuationAtTimeService';

export interface PnLAtTimePerHolding {
  holdingId: string;
  value: Decimal | null; // current value (balance × price at `at`, in base)
  costBasis: Decimal; // remaining open lots' cost in base at purchase time
  realizedPnl: Decimal; // cumulative realized PnL through `at`
  unrealizedPnl: Decimal | null; // value − costBasis; null when value is null
}

export interface PnLAtTimeResult {
  userId: string;
  at: Date;
  baseCurrencyId: string;
  totalValueInBase: Decimal;
  totalCostBasis: Decimal;
  totalRealizedPnl: Decimal;
  totalUnrealizedPnl: Decimal; // total value − total cost basis
  totalPnl: Decimal; // realized + unrealized
  // Re-exposed from the underlying valuation pass so the rollup can
  // populate every column of portfolio_value_daily in one call
  // instead of double-running PortfolioValuationAtTimeService.
  coverageQuality: CoverageQuality;
  holdingsWithKnownValue: number;
  holdingsTotal: number;
  perHolding: PnLAtTimePerHolding[];
}

// Combines PortfolioValuationAtTimeService (current value side) with
// CostBasisService (cost / realized side) per-holding, then
// aggregates portfolio-wide totals. Honors the same `scope` filter
// as the underlying valuation service so per-entity PnL charts use
// the same code path.
@Service()
export class PnLAtTimeService {
  private readonly valuationService = Container.get(PortfolioValuationAtTimeService);
  private readonly costBasisService = Container.get(CostBasisService);

  async getPnL(
    userId: string,
    at: Date,
    baseCurrencyId: string,
    opts: { scope?: PortfolioValueScope; priceLookup?: PriceLookup } = {}
  ): Promise<PnLAtTimeResult> {
    const valuation = await this.valuationService.getPortfolioValue(
      userId,
      at,
      baseCurrencyId,
      opts
    );

    const perHolding: PnLAtTimePerHolding[] = [];
    let totalCost = new Decimal(0);
    let totalRealized = new Decimal(0);

    for (const ph of valuation.perHolding) {
      const cost = await this.costBasisService.getCostBasis(ph.holdingId, at, baseCurrencyId, {
        ...(opts.priceLookup ? { priceLookup: opts.priceLookup } : {}),
      });
      totalCost = totalCost.add(cost.costBasis);
      totalRealized = totalRealized.add(cost.realizedPnl);
      perHolding.push({
        holdingId: ph.holdingId,
        value: ph.valueInBase,
        costBasis: cost.costBasis,
        realizedPnl: cost.realizedPnl,
        unrealizedPnl: ph.valueInBase ? ph.valueInBase.minus(cost.costBasis) : null,
      });
    }

    const totalUnrealized = valuation.totalValueInBase.minus(totalCost);
    return {
      userId,
      at,
      baseCurrencyId,
      totalValueInBase: valuation.totalValueInBase,
      totalCostBasis: totalCost,
      totalRealizedPnl: totalRealized,
      totalUnrealizedPnl: totalUnrealized,
      totalPnl: totalRealized.add(totalUnrealized),
      coverageQuality: valuation.coverageQuality,
      holdingsWithKnownValue: valuation.holdingsWithKnownValue,
      holdingsTotal: valuation.holdingsTotal,
      perHolding,
    };
  }
}
