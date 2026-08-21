import type { CoverageQuality, HoldingCoverage, HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { HoldingCoverageRepository } from '../../repositories/HoldingCoverageRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import type { BalanceAtTimeCaches } from '../pricing/BalanceAtTimeService';
import {
  type CostBasisAtTime,
  type CostBasisMethod,
  type CostBasisQuality,
  CostBasisService,
  type HistoryCompleteness,
  historyCompletenessOf,
} from '../pricing/CostBasisService';
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
  /** Mirrors PortfolioValueAtTimePerHolding.unpriceable — see SC-146. */
  unpriceable: boolean;
  /** Mirrors PortfolioValueAtTimePerHolding.priceStale — see SC-151. */
  priceStale: boolean;
  /**
   * Mirrors PortfolioValueAtTimePerHolding.anchorSource / .anchorAt — see
   * SC-249. These two were the only quality signals the valuation pass
   * produced that this mirror did NOT carry, which is where the provenance
   * died: `unpriceable` and `priceStale` above were both added when the
   * defect they describe was found, and nobody came back for the anchor.
   */
  anchorSource: string | null;
  anchorAt: Date | null;
  /**
   * Mirrors PortfolioValueAtTimePerHolding.balanceBeforeRecords — see
   * SC-252. Carried for the same reason the two fields above finally were:
   * the rollup builds every scope row from THIS shape, so a quality signal
   * the valuation pass computes and this mirror drops is a signal no stored
   * row and no reader ever sees.
   */
  balanceBeforeRecords: boolean;
  /**
   * Mirrors PortfolioValueAtTimePerHolding.balanceInterpolated — see
   * SC-475 fault B. Carried for the same reason the field above it is: the
   * rollup builds every scope row from THIS shape.
   */
  balanceInterpolated: boolean;
  /** How much of this holding's cost we know — see CostBasisQuality (SC-149). */
  basisQuality: CostBasisQuality;
  /** Outflows out of this holding still waiting on an answer — see SC-160. */
  transfersUnreviewed: number;
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
  holdingsUnpriceable: number;
  /** Re-exposed from the valuation pass — see its doc (SC-151). */
  holdingsStalePriced: number;
  /** Re-exposed from the valuation pass — see its doc (SC-249). */
  holdingsStaleAnchored: number;
  /** Re-exposed from the valuation pass — see its doc (SC-249). */
  oldestAnchorAt: Date | null;
  /** Re-exposed from the valuation pass — see its doc (SC-252). */
  holdingsBeforeRecords: number;
  /** Mirrors PortfolioValueAtTimeResult.holdingsInterpolated — SC-475. */
  holdingsInterpolated: number;
  /**
   * Of `holdingsTotal`, how many carry a cost basis we do not actually
   * know: no cost-relevant transaction at all, a provider that reported
   * its history truncated, a leg priced beyond the freshness window, or
   * an inflow booked at zero cost because nothing could value it (SC-149).
   *
   * The figures stay in the totals. Pulling a holding's cost out while its
   * value remains would move the whole of that value into unrealized gain
   * — the same one-directional error this ticket exists to close, dressed
   * as a fix. What changes is that the count travels with the number, so
   * no surface can present the total as a settled one when it is not.
   */
  holdingsBasisUnknown: number;
  /**
   * Outflows at or before `at` that popped their lots and booked no gain
   * because nobody has answered them yet (SC-160) — the honest cost of
   * SC-150, which stopped an unpaired withdrawal being realized as a gain
   * nobody made.
   *
   * Every other count on this result runs one way, upward; this one runs the
   * other. Where one of these rows is a genuine off-platform disposal,
   * `totalRealizedPnl` is short by the gain it would have booked. That is the
   * right trade — an invented disposal is worse than a deferred one — but a
   * figure that is knowingly short and does not say so is the same defect
   * SC-149 closed on the cost side, pointed downward.
   *
   * A count of transactions, not of holdings, and only of rows the review
   * queue actually holds — see `countsAsUnreviewed`. That made it the same
   * number as `TransferReviewService.pendingSummary` for a reader looking at
   * today, and the number that was true on the day for a reader looking back.
   *
   * **Since SC-375 the first half of that can differ, and deliberately so.** A
   * `not_a_disposal` address rule removes a row from what the queue *shows*
   * while writing nothing to it, so the row still pops its lots and still
   * books no gain. The understatement this count exists to declare is
   * therefore unchanged by a rule, and following `pendingSummary` down would
   * quietly retract a caveat that is still true. The queue's own count is the
   * one that may shrink, because it measures questions outstanding rather than
   * gains deferred.
   */
  transfersUnreviewed: number;
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
  private readonly coverageRepository = Container.get(HoldingCoverageRepository);

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
      // Forwarded verbatim to the valuation pass — see its doc.
      unpriceableTokenIds?: ReadonlySet<string>;
      // Pre-loaded `holding_coverage` rows, keyed by holding id. The
      // rollup reads them once per user and hands the same map to all
      // 30 days — completeness is a property of the import, not of the
      // snapshot date. Omit and one bulk query resolves it.
      coverageByHolding?: ReadonlyMap<string, HoldingCoverage>;
      // Which identification rule the cost walk matches disposals under
      // (SC-462), from `users.cost_basis_method`. Omitted is `fifo`, which is
      // what every stored figure was computed with.
      costBasisMethod?: CostBasisMethod;
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

    // The flag every provider writes honestly and nothing has ever read
    // (SC-149). Kraken reports `false` when its ledger endpoint pages out
    // at 20,000 rows; any incremental `since` run reports `false` too. A
    // holding whose acquisitions we could not fetch produced exactly the
    // same cost basis as one that had none — zero — and the disposal's
    // entire proceeds became gain.
    const coverageByHolding =
      opts.coverageByHolding ?? (await this.coverageRepository.findManyByHoldingIds(holdingIds));
    const historyByHolding = new Map<string, HistoryCompleteness>(
      holdingIds.map((h) => [h, historyCompletenessOf(coverageByHolding.get(h))])
    );

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
        opts.priceLookup,
        historyByHolding,
        undefined,
        opts.costBasisMethod
      );
      for (const [h, c] of result) costByHolding.set(h, c);
    }
    for (const h of singletons) {
      const txs = txsByHolding.get(h);
      const cost = await this.costBasisService.getCostBasis(h, at, baseCurrencyId, {
        heldTokenId: heldTokenByHolding.get(h),
        historyCompleteness: historyByHolding.get(h) ?? 'unrecorded',
        ...(opts.priceLookup ? { priceLookup: opts.priceLookup } : {}),
        ...(txs ? { txs } : {}),
        ...(opts.costBasisMethod ? { method: opts.costBasisMethod } : {}),
      });
      costByHolding.set(h, cost);
    }

    const perHolding: PnLAtTimePerHolding[] = [];
    let totalCost = new Decimal(0);
    let totalRealized = new Decimal(0);
    let basisUnknownCount = 0;
    let unreviewedCount = 0;

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
      // A holding kept out of the value side stays out of the cost side.
      // In practice airdrop dust costs nothing — an inflow with no price
      // reference books a zero-cost lot — so today this changes no
      // number. It closes the case where it would: any unpriceable
      // holding that *did* acquire a cost basis (a manual price, an
      // imported trade) would otherwise contribute cost to a total its
      // value never reaches, and the chart would show the whole cost as
      // an unrealized loss the user never took.
      if (!ph.unpriceable) {
        totalCost = totalCost.add(costBasis);
        totalRealized = totalRealized.add(realizedPnl);
      }
      // An unpriceable holding is already outside both totals, so counting
      // its unknown basis a second time would double-report the same
      // absence and make a wallet of airdrop spam read as a cost-basis
      // failure — the exact shape of the bug SC-146 closed on the value
      // side. Only holdings that contribute a number can qualify it.
      const basisQuality = cost?.basisQuality ?? 'unknown';
      if (!ph.unpriceable && basisQuality !== 'known') basisUnknownCount += 1;
      // Same gate, same argument (SC-160). An unpriceable holding's realized
      // PnL never entered `totalRealized`, so an unanswered exit out of it
      // cannot be understating a figure it does not contribute to — counting
      // it would put a caveat on the chart that no answer in the queue could
      // ever remove.
      const transfersUnreviewed = cost?.transfersUnreviewed ?? 0;
      if (!ph.unpriceable) unreviewedCount += transfersUnreviewed;
      perHolding.push({
        holdingId: ph.holdingId,
        accountId: ph.accountId,
        tokenId: ph.tokenId,
        value: ph.valueInBase,
        costBasis,
        realizedPnl,
        unrealizedPnl: ph.valueInBase ? ph.valueInBase.minus(costBasis) : null,
        unpriceable: ph.unpriceable,
        priceStale: ph.priceStale,
        anchorSource: ph.anchorSource,
        anchorAt: ph.anchorAt,
        balanceBeforeRecords: ph.balanceBeforeRecords,
        balanceInterpolated: ph.balanceInterpolated,
        basisQuality,
        transfersUnreviewed,
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
      holdingsUnpriceable: valuation.holdingsUnpriceable,
      holdingsStalePriced: valuation.holdingsStalePriced,
      holdingsStaleAnchored: valuation.holdingsStaleAnchored,
      oldestAnchorAt: valuation.oldestAnchorAt,
      holdingsBeforeRecords: valuation.holdingsBeforeRecords,
      holdingsInterpolated: valuation.holdingsInterpolated,
      holdingsBasisUnknown: basisUnknownCount,
      transfersUnreviewed: unreviewedCount,
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
