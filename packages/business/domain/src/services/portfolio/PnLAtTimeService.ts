import type { CoverageQuality, HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import type { BalanceAtTimeCaches } from '../pricing/BalanceAtTimeService';
import { type CostBasisAtTime, CostBasisService } from '../pricing/CostBasisService';
import type { PriceLookup } from '../pricing/PriceLookup';
import {
  PortfolioValuationAtTimeService,
  type PortfolioValueScope,
} from './PortfolioValuationAtTimeService';

export interface PnLAtTimePerHolding {
  holdingId: string;
  // Mirror PortfolioValueAtTimePerHolding so callers can re-aggregate
  // by scope (institution / account) without re-fetching the holding
  // metadata.
  accountId: string;
  tokenId: string;
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
  private readonly txRepository = Container.get(HoldingTransactionRepository);

  async getPnL(
    userId: string,
    at: Date,
    baseCurrencyId: string,
    opts: {
      scope?: PortfolioValueScope;
      priceLookup?: PriceLookup;
      // Pre-loaded per-user caches that BalanceAtTimeService and
      // CostBasisService can use instead of per-call DB reads.
      caches?: BalanceAtTimeCaches;
    } = {}
  ): Promise<PnLAtTimeResult> {
    const valuation = await this.valuationService.getPortfolioValue(
      userId,
      at,
      baseCurrencyId,
      opts
    );

    const holdingIds = valuation.perHolding.map((ph) => ph.holdingId);
    const heldTokenByHolding = new Map(
      valuation.perHolding.map((ph) => [ph.holdingId, ph.tokenId])
    );

    // Cost basis needs every holding's full tx history — both to detect
    // transfer-linked components and to cost-walk them together. The
    // rollup hands these in via caches; ad-hoc callers pay one bulk read.
    const txsByHolding: ReadonlyMap<string, ReadonlyArray<HoldingTransaction>> = opts.caches
      ?.transactions ?? (await this.txRepository.findForHoldingsAll(holdingIds));

    // Holdings linked by transfer_group_id must be cost-walked together
    // so a transfer carries the original lot cost across accounts
    // instead of resetting it to market value. Unconnected holdings keep
    // the cheap per-holding walk.
    const { components, singletons } = buildTransferComponents(holdingIds, txsByHolding);
    const costByHolding = new Map<string, CostBasisAtTime>();
    for (const component of components) {
      const result = await this.costBasisService.walkComponent(
        component,
        txsByHolding,
        at,
        baseCurrencyId,
        heldTokenByHolding,
        opts.priceLookup
      );
      for (const [h, c] of result) costByHolding.set(h, c);
    }
    for (const h of singletons) {
      const txs = txsByHolding.get(h);
      const cost = await this.costBasisService.getCostBasis(h, at, baseCurrencyId, {
        heldTokenId: heldTokenByHolding.get(h),
        ...(opts.priceLookup ? { priceLookup: opts.priceLookup } : {}),
        ...(txs ? { txs } : {}),
      });
      costByHolding.set(h, cost);
    }

    const perHolding: PnLAtTimePerHolding[] = [];
    let totalCost = new Decimal(0);
    let totalRealized = new Decimal(0);

    for (const ph of valuation.perHolding) {
      const cost = costByHolding.get(ph.holdingId);
      const rawCostBasis = cost?.costBasis ?? new Decimal(0);
      const rawRealized = cost?.realizedPnl ?? new Decimal(0);
      const hasTransactions = cost?.hasTransactions ?? false;
      // Cost-unknown holding: no cost-relevant transaction at or before
      // `at`, so the walk reports costBasis 0. Substitute the holding's
      // current value as cost basis — PnL then reads as a flat 0 instead
      // of fabricating the entire value as an unrealized gain.
      const costUnknown = ph.valueInBase !== null && !hasTransactions;
      const costBasis = costUnknown && ph.valueInBase !== null ? ph.valueInBase : rawCostBasis;
      const realizedPnl = costUnknown ? new Decimal(0) : rawRealized;
      totalCost = totalCost.add(costBasis);
      totalRealized = totalRealized.add(realizedPnl);
      perHolding.push({
        holdingId: ph.holdingId,
        accountId: ph.accountId,
        tokenId: ph.tokenId,
        value: ph.valueInBase,
        costBasis,
        realizedPnl,
        unrealizedPnl: ph.valueInBase ? ph.valueInBase.minus(costBasis) : null,
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

// Partition holdings into transfer-connected components (sets of
// holdings joined by a shared transfer_group_id, walked together by
// CostBasisService.walkComponent) and singletons (no linked transfer,
// walked per-holding). Union-find over holdings that co-occur on any
// transfer_group_id.
function buildTransferComponents(
  holdingIds: ReadonlyArray<string>,
  txsByHolding: ReadonlyMap<string, ReadonlyArray<HoldingTransaction>>
): { components: string[][]; singletons: string[] } {
  const groupToHoldings = new Map<string, Set<string>>();
  const connected = new Set<string>();
  for (const h of holdingIds) {
    for (const tx of txsByHolding.get(h) ?? []) {
      if (!tx.transferGroupId) continue;
      connected.add(h);
      const set = groupToHoldings.get(tx.transferGroupId);
      if (set) set.add(h);
      else groupToHoldings.set(tx.transferGroupId, new Set([h]));
    }
  }

  const parent = new Map<string, string>();
  for (const h of connected) parent.set(h, h);
  const find = (x: string): string => {
    let root = x;
    let p = parent.get(root);
    while (p !== undefined && p !== root) {
      root = p;
      p = parent.get(root);
    }
    parent.set(x, root);
    return root;
  };
  for (const holdings of groupToHoldings.values()) {
    const arr = [...holdings];
    const first = arr[0];
    if (!first) continue;
    for (let i = 1; i < arr.length; i++) {
      const other = arr[i];
      if (!other) continue;
      const a = find(first);
      const b = find(other);
      if (a !== b) parent.set(a, b);
    }
  }

  const byRoot = new Map<string, string[]>();
  for (const h of connected) {
    const root = find(h);
    const list = byRoot.get(root);
    if (list) list.push(h);
    else byRoot.set(root, [h]);
  }
  return {
    components: [...byRoot.values()],
    singletons: holdingIds.filter((h) => !connected.has(h)),
  };
}
