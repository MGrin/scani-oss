import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { HoldingRepository } from '../../repositories/HoldingRepository';
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
// Other inflow kinds — deposits, rewards, airdrops, transfers in,
// opening balances. Cost basis is the inflow's fair-market value at
// receipt: priceNative when the importer recorded one, otherwise
// the held token's spot price at occurredAt converted to base via
// PriceGraphService. This is what brokerages and tax software call
// "FMV at receipt" — for stocks-as-rewards or fiat deposits it
// produces a non-zero cost basis matching what the user effectively
// "paid" for the position. Only when no price reference exists at
// all do we fall back to a true zero-cost lot.
const INFLOW_OTHER_KINDS = new Set([
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
 *   - deposit / reward / airdrop / interest / transfer_in lots use
 *     fair-market value at receipt (priceNative when set, otherwise
 *     held-token spot price → base via PriceGraphService); only when
 *     no price reference exists do we fall back to a zero-cost lot
 *   - withdraw / transfer_out remove lots at zero realized PnL
 *
 * The `at`-time FX conversion runs through PriceGraphService so the
 * cost basis is preserved in the user's home currency at the moment
 * of purchase — matches what a brokerage statement would show.
 */
@Service()
export class CostBasisService {
  private readonly txRepository = Container.get(HoldingTransactionRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly priceGraphService = Container.get(PriceGraphService);

  async getCostBasis(
    holdingId: string,
    at: Date,
    baseCurrencyId: string,
    opts: {
      priceLookup?: PriceLookup;
      heldTokenId?: string;
      // Pre-loaded full tx history for this holding (sorted by
      // occurredAt ASC). Lets the rollup loop pay one DB read per
      // holding instead of one per (holding, day, scope).
      txs?: ReadonlyArray<HoldingTransaction>;
    } = {}
  ): Promise<CostBasisAtTime> {
    const [txs, heldTokenId] = await Promise.all([
      opts.txs
        ? Promise.resolve(filterTxsUpTo(opts.txs, at))
        : this.txRepository.findForHoldingUpTo(holdingId, at),
      opts.heldTokenId
        ? Promise.resolve(opts.heldTokenId)
        : this.holdingRepository.findById(holdingId).then((h) => h?.tokenId ?? null),
    ]);
    return this.walkLots(txs, baseCurrencyId, heldTokenId, opts.priceLookup);
  }

  // Visible for tests + the rollup loop, which already loads txs
  // via a different pre-fetch path and can avoid the per-holding
  // round-trip by handing them in directly. `heldTokenId` lets the
  // FMV-at-receipt fallback price the inflow via the held token's
  // spot rate when the tx itself lacks priceNative — null disables
  // the fallback (zero-cost lot for INFLOW_OTHER_KINDS).
  async walkLots(
    txs: ReadonlyArray<HoldingTransaction>,
    baseCurrencyId: string,
    heldTokenId: string | null,
    priceLookup?: PriceLookup
  ): Promise<CostBasisAtTime> {
    const lots: CostLot[] = [];
    let realized = new Decimal(0);

    for (const tx of txs) {
      const qtyAbs = new Decimal(tx.quantity).abs();
      if (qtyAbs.isZero()) continue;

      if (INFLOW_BUY_KINDS.has(tx.kind) || INFLOW_OTHER_KINDS.has(tx.kind)) {
        const cost = await this.txValueInBase(tx, qtyAbs, baseCurrencyId, heldTokenId, priceLookup);
        lots.push({ qty: qtyAbs, cost: cost ?? new Decimal(0), date: tx.occurredAt });
        continue;
      }

      if (OUTFLOW_SELL_KINDS.has(tx.kind)) {
        const proceeds =
          (await this.txValueInBase(tx, qtyAbs, baseCurrencyId, heldTokenId, priceLookup)) ??
          new Decimal(0);
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

  // Compute the transaction's value in the user's base currency at
  // tx.occurredAt. Two paths:
  //   1. `priceNative` recorded → qty × priceNative in priceNativeTokenId,
  //      converted to base.
  //   2. Fallback → qty in the *held* token, converted to base via
  //      PriceGraphService at tx.occurredAt. This catches fiat deposits
  //      (EUR balance worth €500 at receipt) and any inflow whose value
  //      can be inferred from spot pricing of the held token.
  // Returns null only when neither path resolves — caller treats null
  // as a zero-cost lot.
  private async txValueInBase(
    tx: HoldingTransaction,
    qtyAbs: Decimal,
    baseCurrencyId: string,
    heldTokenId: string | null,
    priceLookup?: PriceLookup
  ): Promise<Decimal | null> {
    const convertOpts = priceLookup
      ? ({ preferGranularity: 'daily', priceLookup } as const)
      : ({ preferGranularity: 'daily' } as const);

    if (tx.priceNative && tx.priceNativeTokenId) {
      const native = new Decimal(tx.priceNative).mul(qtyAbs);
      if (tx.priceNativeTokenId === baseCurrencyId) return native;
      const converted = await this.priceGraphService.convert(
        native,
        tx.priceNativeTokenId,
        baseCurrencyId,
        tx.occurredAt,
        convertOpts
      );
      if (converted) return converted.amount;
      // priceNative recorded but no FX route: continue to the
      // held-token fallback below rather than returning null.
    }

    if (heldTokenId) {
      if (heldTokenId === baseCurrencyId) return qtyAbs;
      const converted = await this.priceGraphService.convert(
        qtyAbs,
        heldTokenId,
        baseCurrencyId,
        tx.occurredAt,
        convertOpts
      );
      if (converted) return converted.amount;
    }

    return null;
  }
}

// Slice a pre-loaded full tx history down to events at or before
// `at`. Avoids repeating the per-day DB read in the rollup hot path
// when the caller hands in the whole history once.
function filterTxsUpTo(
  txs: ReadonlyArray<HoldingTransaction>,
  at: Date
): ReadonlyArray<HoldingTransaction> {
  const cutoff = at.getTime();
  return txs.filter((t) => t.occurredAt.getTime() <= cutoff);
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
