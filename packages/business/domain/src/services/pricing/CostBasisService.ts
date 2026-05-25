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

// Internal lot for the transfer-aware component walk — a CostLot that
// also tracks which holding it currently resides in, so a transfer can
// move it between holdings on the shared ledger.
interface ComponentLot extends CostLot {
  holdingId: string;
}

export interface CostBasisAtTime {
  openQty: Decimal;
  costBasis: Decimal; // sum of remaining lots' cost in base currency
  realizedPnl: Decimal; // cumulative realized PnL up to `at`
  lots: CostLot[]; // remaining open lots, oldest first
  // False when the holding has no cost-relevant transaction at or before
  // `at`. The walk then produces costBasis 0, which would render the
  // whole position as unrealized gain. Callers (PnLAtTimeService) treat
  // a cost-unknown holding as cost basis = current value (0% gain).
  hasTransactions: boolean;
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
// Outflows that move assets *out* of the tracked portfolio with no
// buyer on the other side. A withdraw / transfer_out that's linked
// to a `transfer_in` on the same `transfer_group_id` is just a hop
// between the user's own accounts — handled by `walkComponent` which
// re-homes the lots intact (no realized PnL).
//
// An *unlinked* outflow is a true exit: the asset is gone from
// anything we can value (cold wallet, gift, P2P sale that settled
// off-platform, …). We realize PnL at fair-market value at
// `occurredAt`, mirroring the sell branch — proceeds minus popped
// cost. This is what users see as "I withdrew $X out of my portfolio
// and locked in $Y of gain". When pricing can't be resolved at
// `occurredAt` we fall back to popping at zero realized rather than
// fabricating a phantom loss.
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
 *   - unlinked withdraw / transfer_out realize PnL at FMV (proceeds
 *     minus popped cost), treating the exit as a sale against the
 *     market. Linked transfer pairs (`transferGroupId` matched in
 *     `walkComponent`) stay neutral — lots inherit to the destination
 *     holding intact.
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
        const proceeds = await this.txValueInBase(
          tx,
          qtyAbs,
          baseCurrencyId,
          heldTokenId,
          priceLookup
        );
        if (proceeds === null) {
          // Unpriceable sell — in practice a `swap_out` with no
          // `priceNative` (its proceeds are denominated in the counter
          // token, which this per-holding walk can't value). Booking
          // proceeds of 0 would realize a phantom loss of the entire
          // popped cost basis. Pop the lots FIFO at ZERO realized
          // instead, surfacing the gap rather than fabricating a loss.
          popLotsFIFO(lots, qtyAbs);
          continue;
        }
        const soldCost = popLotsFIFO(lots, qtyAbs);
        realized = realized.add(proceeds.minus(soldCost));
        continue;
      }

      if (OUTFLOW_NEUTRAL_KINDS.has(tx.kind)) {
        // This walker is only called for *singleton* holdings (see
        // PnLAtTimeService.singletons) — holdings outside any
        // transfer-connected component. By definition every withdraw /
        // transfer_out reaching this branch is unlinked, so realize at
        // FMV like a sell. `walkComponent` handles the linked case
        // separately.
        const proceeds = await this.txValueInBase(
          tx,
          qtyAbs,
          baseCurrencyId,
          heldTokenId,
          priceLookup
        );
        const poppedCost = popLotsFIFO(lots, qtyAbs);
        if (proceeds !== null) {
          realized = realized.add(proceeds.minus(poppedCost));
        }
      }

      // Unknown kind (fee, unknown, future kinds): skip silently.
      // The tx still affects balance via BalanceAtTimeService; cost
      // basis just stays unchanged.
    }

    const costBasis = lots.reduce((s, l) => s.add(l.cost), new Decimal(0));
    const openQty = lots.reduce((s, l) => s.add(l.qty), new Decimal(0));
    return { openQty, costBasis, realizedPnl: realized, lots, hasTransactions: txs.length > 0 };
  }

  /**
   * Transfer-aware cost-basis walk across a set of holdings linked by
   * `transfer_group_id`.
   *
   * A transfer between a user's own accounts is not a taxable sale: the
   * source `transfer_out` must NOT realize PnL, and the destination
   * `transfer_in` must inherit the original lots' cost and acquisition
   * date rather than opening a fresh market-value lot. Per-holding cost
   * basis therefore cannot be computed in isolation — this walks every
   * holding in the transfer-connected component on a single shared lot
   * ledger where each lot is tagged with the holding it currently
   * resides in. A holding's reported cost basis is the cost of the lots
   * residing in it at `at`, which keeps account / institution / user
   * aggregation additive.
   */
  async walkComponent(
    holdingIds: ReadonlyArray<string>,
    txsByHolding: ReadonlyMap<string, ReadonlyArray<HoldingTransaction>>,
    at: Date,
    baseCurrencyId: string,
    heldTokenByHolding: ReadonlyMap<string, string>,
    priceLookup?: PriceLookup
  ): Promise<Map<string, CostBasisAtTime>> {
    // Flatten + globally order every tx in the component up to `at`. On
    // equal timestamps an outflow sorts before an inflow so a
    // transfer_out buffers its lots before the paired transfer_in needs
    // them.
    const events: HoldingTransaction[] = [];
    const hasTxByHolding = new Map<string, boolean>();
    for (const h of holdingIds) {
      const txs = filterTxsUpTo(txsByHolding.get(h) ?? [], at);
      hasTxByHolding.set(h, txs.length > 0);
      for (const tx of txs) events.push(tx);
    }
    events.sort((a, b) => {
      const d = a.occurredAt.getTime() - b.occurredAt.getTime();
      return d !== 0 ? d : outflowRank(a.kind) - outflowRank(b.kind);
    });

    const lots: ComponentLot[] = [];
    const realizedByHolding = new Map<string, Decimal>();
    // Lots popped by a linked transfer_out, keyed by transfer_group_id,
    // waiting for the paired transfer_in to inherit them.
    const pending = new Map<string, ComponentLot[]>();
    // Parallel ledger of per-outflow exit metadata, keyed by the same
    // transfer_group_id. If the paired transfer_in never arrives by
    // end of walk, each entry is realized at FMV on its source holding.
    // FMV is computed *lazily* at end-of-walk so paired transfers (the
    // common case) never trigger a price-graph lookup.
    const pendingRealization = new Map<
      string,
      Array<{
        tx: HoldingTransaction;
        holdingId: string;
        qtyAbs: Decimal;
        heldTokenId: string | null;
        poppedCost: Decimal;
      }>
    >();
    const addRealized = (holdingId: string, amount: Decimal): void => {
      realizedByHolding.set(
        holdingId,
        (realizedByHolding.get(holdingId) ?? new Decimal(0)).add(amount)
      );
    };
    // Pop oldest lots (by acquisition date) belonging to `holdingId`,
    // splitting the last lot proportionally when needed.
    const popHolding = (holdingId: string, wantQty: Decimal): ComponentLot[] => {
      const popped: ComponentLot[] = [];
      let remaining = wantQty;
      while (remaining.gt(0)) {
        let idx = -1;
        for (let i = 0; i < lots.length; i++) {
          const l = lots[i];
          if (!l || l.holdingId !== holdingId) continue;
          const best = idx === -1 ? undefined : lots[idx];
          if (!best || l.date < best.date) idx = i;
        }
        if (idx === -1) break;
        const lot = lots[idx];
        if (!lot) break;
        if (lot.qty.lte(remaining)) {
          popped.push(lot);
          remaining = remaining.minus(lot.qty);
          lots.splice(idx, 1);
        } else {
          const ratio = remaining.div(lot.qty);
          const partialCost = lot.cost.mul(ratio);
          popped.push({ qty: remaining, cost: partialCost, date: lot.date, holdingId });
          lot.qty = lot.qty.minus(remaining);
          lot.cost = lot.cost.minus(partialCost);
          remaining = new Decimal(0);
        }
      }
      return popped;
    };

    for (const tx of events) {
      const holdingId = tx.holdingId;
      const qtyAbs = new Decimal(tx.quantity).abs();
      if (qtyAbs.isZero()) continue;
      const heldTokenId = heldTokenByHolding.get(holdingId) ?? null;

      if (INFLOW_BUY_KINDS.has(tx.kind) || INFLOW_OTHER_KINDS.has(tx.kind)) {
        const tgid = tx.transferGroupId;
        const buffered = tgid ? pending.get(tgid) : undefined;
        if (tgid && buffered && (tx.kind === 'transfer_in' || tx.kind === 'deposit')) {
          // Paired transfer_in: inherit the buffered lots (cost +
          // acquisition date intact), re-homed to this holding. The
          // matched outflow accumulators get discarded — the lots are
          // still in the pool, so end-of-walk realization shouldn't
          // double-book PnL on them.
          pending.delete(tgid);
          pendingRealization.delete(tgid);
          for (const lot of buffered) {
            lots.push({ qty: lot.qty, cost: lot.cost, date: lot.date, holdingId });
          }
          continue;
        }
        const cost = await this.txValueInBase(tx, qtyAbs, baseCurrencyId, heldTokenId, priceLookup);
        lots.push({ qty: qtyAbs, cost: cost ?? new Decimal(0), date: tx.occurredAt, holdingId });
        continue;
      }

      if (OUTFLOW_SELL_KINDS.has(tx.kind)) {
        const proceeds = await this.txValueInBase(
          tx,
          qtyAbs,
          baseCurrencyId,
          heldTokenId,
          priceLookup
        );
        const popped = popHolding(holdingId, qtyAbs);
        if (proceeds !== null) {
          const soldCost = popped.reduce((s, l) => s.add(l.cost), new Decimal(0));
          addRealized(holdingId, proceeds.minus(soldCost));
        }
        // proceeds === null → unpriceable swap_out: pop at zero realized.
        continue;
      }

      if (OUTFLOW_NEUTRAL_KINDS.has(tx.kind)) {
        const popped = popHolding(holdingId, qtyAbs);
        const poppedCost = popped.reduce((s, l) => s.add(l.cost), new Decimal(0));
        const tgid = tx.transferGroupId;
        if (tgid && (tx.kind === 'transfer_out' || tx.kind === 'withdraw')) {
          // Linked transfer_out: buffer the popped lots for the paired
          // transfer_in. The FMV lookup is deferred — most linked
          // outflows get paired, and we don't want to make a price
          // call we'll throw away.
          const bucket = pending.get(tgid);
          if (bucket) bucket.push(...popped);
          else pending.set(tgid, popped);
          const accs = pendingRealization.get(tgid) ?? [];
          accs.push({ tx, holdingId, qtyAbs, heldTokenId, poppedCost });
          pendingRealization.set(tgid, accs);
        } else {
          // Unlinked outflow → true exit from the portfolio. Realize at
          // FMV like a sale. When proceeds is null (no priceable route
          // at occurredAt) fall through silently at zero realized
          // rather than fabricating a phantom loss.
          const proceeds = await this.txValueInBase(
            tx,
            qtyAbs,
            baseCurrencyId,
            heldTokenId,
            priceLookup
          );
          if (proceeds !== null) {
            addRealized(holdingId, proceeds.minus(poppedCost));
          }
        }
      }
      // Unknown kind — skip; balance is handled by BalanceAtTimeService.
    }

    // Any transfer_out lots still buffered at end of walk were never
    // claimed by a paired transfer_in — treat each as a true exit and
    // realize PnL on its original source holding using FMV at
    // occurredAt.
    for (const accs of pendingRealization.values()) {
      for (const acc of accs) {
        const proceeds = await this.txValueInBase(
          acc.tx,
          acc.qtyAbs,
          baseCurrencyId,
          acc.heldTokenId,
          priceLookup
        );
        if (proceeds !== null) {
          addRealized(acc.holdingId, proceeds.minus(acc.poppedCost));
        }
      }
    }
    pendingRealization.clear();

    const out = new Map<string, CostBasisAtTime>();
    for (const h of holdingIds) {
      const holdingLots = lots.filter((l) => l.holdingId === h);
      out.set(h, {
        openQty: holdingLots.reduce((s, l) => s.add(l.qty), new Decimal(0)),
        costBasis: holdingLots.reduce((s, l) => s.add(l.cost), new Decimal(0)),
        realizedPnl: realizedByHolding.get(h) ?? new Decimal(0),
        lots: holdingLots.map((l) => ({ qty: l.qty, cost: l.cost, date: l.date })),
        hasTransactions: hasTxByHolding.get(h) ?? false,
      });
    }
    return out;
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
  //
  // SWAPS are special: a 10 BTC → 100 ETH swap has proceeds in ETH,
  // not in BTC, so the held-token fallback would wrongly value the
  // BTC leg at BTC's spot price (silently understating realized PnL
  // — see prod evidence: 30 swap_out vs 25 swap_in rows in the user's
  // ledger). For swap_in/swap_out we therefore require `priceNative`
  // and refuse to guess.
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

    const isSwap = tx.kind === 'swap_in' || tx.kind === 'swap_out';
    if (isSwap) {
      // No held-token fallback for swaps — pricing the BTC leg of a
      // BTC→ETH swap at BTC's spot would imply zero realized PnL on
      // the swap, which is wrong. Return null and let the caller treat
      // the swap as a zero-cost lot, surfacing the gap rather than
      // hiding it.
      return null;
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

// Ordering helper for the component walk: on equal timestamps an
// outflow (rank 0) is processed before an inflow (rank 1) so a linked
// transfer_out buffers its lots before the paired transfer_in inherits
// them.
function outflowRank(kind: string): number {
  return OUTFLOW_SELL_KINDS.has(kind) || OUTFLOW_NEUTRAL_KINDS.has(kind) ? 0 : 1;
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
