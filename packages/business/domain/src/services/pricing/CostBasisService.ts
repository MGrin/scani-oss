import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import { PriceGraphService } from './PriceGraphService';
import type { PriceLookup } from './PriceLookup';

// FIFO lot tracking state. `cost` is the per-unit cost summed across
// the lot's `qty`, denominated in the user's base currency at
// transaction time. `date` is the lot's acquisition date (preserved
// for first-in-first-out ordering and downstream lot-detail queries).
export interface CostLot {
  qty: Decimal;
  cost: Decimal;
  date: Date;
}

export interface CostBasisAtTime {
  openQty: Decimal;
  costBasis: Decimal; // sum of remaining lots' cost in base currency
  realizedPnl: Decimal; // cumulative realized PnL up to `at`
  lots: CostLot[]; // remaining open lots, oldest first
}

// Transaction kinds that contribute INFLOW (add to lot pool).
const INFLOW_BUY_KINDS = new Set(['buy', 'swap_in']);
// Inflows with NO cost basis (income, rewards, airdrops). The lot
// gets pushed at zero cost — when later sold, the entire proceeds
// register as realized PnL. Matches what brokerages do for stock
// rewards / dividend-as-shares; tax-grade reporting would split
// these into "ordinary income" but that's out of scope for the
// chart.
const INFLOW_ZERO_COST_KINDS = new Set([
  'deposit',
  'reward',
  'interest',
  'airdrop',
  'transfer_in',
  'opening_balance',
]);
const OUTFLOW_SELL_KINDS = new Set(['sell', 'swap_out']);
// Outflows that don't realize PnL — money / tokens leave the cost
// pool but no buyer is on the other side (so no proceeds to
// compare against the cost). Removes lots FIFO at zero realized.
const OUTFLOW_NEUTRAL_KINDS = new Set(['withdraw', 'transfer_out']);
// Fees are ignored for cost basis in the MVP. A more accurate
// accounting model would deduct fees from realized PnL on the same
// transaction, but that requires per-tx fee allocation logic that
// matters more for tax reporting than for a chart.

/**
 * Per-holding cost-basis walker. FIFO lot accounting.
 *
 * Reads the holding's transaction history up to `at`, walks through
 * each event in chronological order, maintains a queue of open lots
 * (each with qty + cost in base currency), and accumulates realized
 * PnL whenever a sell pops lots out of the queue.
 *
 * Honest simplifications (declared in the service comment so they're
 * not silent):
 *   - FIFO only (no LIFO, no specific-id, no average-cost)
 *   - No wash-sale detection
 *   - Fees ignored for cost basis
 *   - deposit / reward / airdrop / interest / transfer_in get zero
 *     cost basis (entire proceeds become realized PnL on sell)
 *   - withdraw / transfer_out remove lots at zero realized PnL
 *
 * The `at`-time FX conversion runs through PriceGraphService so the
 * cost basis is preserved in the user's home currency at the moment
 * of purchase — matches what a brokerage statement would show.
 */
@Service()
export class CostBasisService {
  private readonly txRepository = Container.get(HoldingTransactionRepository);
  private readonly priceGraphService = Container.get(PriceGraphService);

  async getCostBasis(
    holdingId: string,
    at: Date,
    baseCurrencyId: string,
    opts: { priceLookup?: PriceLookup } = {}
  ): Promise<CostBasisAtTime> {
    const txs = await this.txRepository.findForHoldingUpTo(holdingId, at);
    return this.walkLots(txs, baseCurrencyId, opts.priceLookup);
  }

  // Visible for tests + the rollup loop, which already loads txs
  // via a different pre-fetch path and can avoid the per-holding
  // round-trip by handing them in directly.
  async walkLots(
    txs: ReadonlyArray<HoldingTransaction>,
    baseCurrencyId: string,
    priceLookup?: PriceLookup
  ): Promise<CostBasisAtTime> {
    const lots: CostLot[] = [];
    let realized = new Decimal(0);

    for (const tx of txs) {
      const qtyAbs = new Decimal(tx.quantity).abs();
      if (qtyAbs.isZero()) continue;

      if (INFLOW_BUY_KINDS.has(tx.kind)) {
        const cost = await this.txValueInBase(tx, baseCurrencyId, priceLookup);
        lots.push({ qty: qtyAbs, cost: cost ?? new Decimal(0), date: tx.occurredAt });
        continue;
      }

      if (INFLOW_ZERO_COST_KINDS.has(tx.kind)) {
        lots.push({ qty: qtyAbs, cost: new Decimal(0), date: tx.occurredAt });
        continue;
      }

      if (OUTFLOW_SELL_KINDS.has(tx.kind)) {
        const proceeds =
          (await this.txValueInBase(tx, baseCurrencyId, priceLookup)) ?? new Decimal(0);
        const soldCost = popLotsFIFO(lots, qtyAbs);
        realized = realized.add(proceeds.minus(soldCost));
        continue;
      }

      if (OUTFLOW_NEUTRAL_KINDS.has(tx.kind)) {
        popLotsFIFO(lots, qtyAbs);
      }

      // Unknown kind (fee, unknown, future kinds): skip silently.
      // The tx still affects balance via BalanceAtTimeService; cost
      // basis just stays unchanged.
    }

    const costBasis = lots.reduce((s, l) => s.add(l.cost), new Decimal(0));
    const openQty = lots.reduce((s, l) => s.add(l.qty), new Decimal(0));
    return { openQty, costBasis, realizedPnl: realized, lots };
  }

  // Convert the transaction's native-currency total value (qty ×
  // priceNative) into the user's base currency, using the price
  // graph's at-time FX. Returns null when neither priceNative nor a
  // route to the base currency is available — caller treats null as
  // a zero-cost contribution rather than aborting.
  private async txValueInBase(
    tx: HoldingTransaction,
    baseCurrencyId: string,
    priceLookup?: PriceLookup
  ): Promise<Decimal | null> {
    if (!tx.priceNative || !tx.priceNativeTokenId) return null;
    const native = new Decimal(tx.priceNative).mul(new Decimal(tx.quantity).abs());
    if (tx.priceNativeTokenId === baseCurrencyId) return native;
    const converted = await this.priceGraphService.convert(
      native,
      tx.priceNativeTokenId,
      baseCurrencyId,
      tx.occurredAt,
      priceLookup ? { preferGranularity: 'daily', priceLookup } : { preferGranularity: 'daily' }
    );
    return converted ? converted.amount : null;
  }
}

// Pop lots FIFO until `wantQty` is satisfied. Returns the total
// cost popped (caller subtracts from proceeds for realized PnL).
// May split the last popped lot proportionally when wantQty < lot.qty.
function popLotsFIFO(lots: CostLot[], wantQty: Decimal): Decimal {
  let remaining = wantQty;
  let totalCost = new Decimal(0);
  while (remaining.gt(0) && lots.length > 0) {
    const lot = lots[0];
    if (!lot) break;
    if (lot.qty.lte(remaining)) {
      totalCost = totalCost.add(lot.cost);
      remaining = remaining.minus(lot.qty);
      lots.shift();
    } else {
      const ratio = remaining.div(lot.qty);
      const partialCost = lot.cost.mul(ratio);
      totalCost = totalCost.add(partialCost);
      lot.qty = lot.qty.minus(remaining);
      lot.cost = lot.cost.minus(partialCost);
      remaining = new Decimal(0);
    }
  }
  return totalCost;
}
