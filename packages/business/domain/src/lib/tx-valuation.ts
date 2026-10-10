import type { HoldingTransaction } from '@scani/db/schema';
import type { ValuationBasisDto } from '@scani/shared';
import Decimal from 'decimal.js';
import type { PriceAsk } from '../engine/types';
import type { PriceSeries } from '../services/pricing/PriceReader';

/**
 * What one ledger row is worth in the user's base currency at the instant it
 * happened — the single implementation, shared by cost basis and by returns.
 *
 * Lifted out of `CostBasisService` unchanged when SC-457 needed the same
 * answer for external flows. Two copies would have been two answers: a
 * contribution valued one way and the cost basis of the very same
 * transaction valued another produces a return figure that cannot be
 * reconciled with the gain shown beside it, and nothing on either screen
 * would say why.
 *
 * Two routes, and the caller is told which one answered:
 *
 *   1. `execution_rate` — the importer recorded `priceNative`, so
 *      `qty x priceNative` in `priceNativeTokenId`, converted to base. For a
 *      trade or a swap this is the rate the deal actually executed at and
 *      needs no price source at all.
 *   2. `held_token` — the quantity in the HELD token, converted to base at
 *      `occurredAt` through the series the caller loaded. This is what values a fiat deposit
 *      (a EUR balance worth EUR 500 at receipt) and any leg whose worth can
 *      be inferred from spot.
 *
 * `null` only when neither resolves. The `stale` flag travels with the amount
 * rather than being dropped, because a leg valued from a 96-day-old quote is
 * otherwise indistinguishable from one priced on the day (SC-151).
 */
export type ValuationBasis = ValuationBasisDto;

export interface TxValuation {
  amount: Decimal;
  stale: boolean;
  basis: ValuationBasis;
}

/** The subset of a ledger row this valuation reads. */
type ValuableTransaction = Pick<
  HoldingTransaction,
  'priceNative' | 'priceNativeTokenId' | 'occurredAt'
>;

/**
 * Every read here goes to `prices`, loaded by the caller over the instants
 * `valuationInstantsOf` lists; an instant it did not list throws rather than
 * reading the database row by row. `tx` is a LEDGER ROW throughout this file.
 */
function valueTransactionInBase(
  prices: PriceSeries,
  tx: ValuableTransaction,
  qtyAbs: Decimal,
  baseCurrencyId: string,
  heldTokenId: string | null
): TxValuation | null {
  if (tx.priceNative && tx.priceNativeTokenId) {
    const native = new Decimal(tx.priceNative).mul(qtyAbs);
    // Recorded by the importer at the moment of the trade — no price
    // lookup, so nothing to be stale.
    if (tx.priceNativeTokenId === baseCurrencyId) {
      return { amount: native, stale: false, basis: 'execution_rate' };
    }
    const converted = convert(prices, native, tx.priceNativeTokenId, tx.occurredAt);
    if (converted) {
      return { amount: converted.amount, stale: converted.stale, basis: 'execution_rate' };
    }
    // priceNative recorded but no FX route: continue to the held-token
    // fallback below rather than returning null.
  }

  if (heldTokenId) {
    if (heldTokenId === baseCurrencyId) {
      return { amount: qtyAbs, stale: false, basis: 'held_token' };
    }
    const converted = convert(prices, qtyAbs, heldTokenId, tx.occurredAt);
    if (converted) {
      return { amount: converted.amount, stale: converted.stale, basis: 'held_token' };
    }
  }

  return null;
}

function convert(
  prices: PriceSeries,
  amount: Decimal,
  tokenId: string,
  at: Date
): { amount: Decimal; stale: boolean } | null {
  const answer = prices.priceAt(tokenId, at);
  return answer ? { amount: amount.mul(answer.price), stale: answer.stale } : null;
}

/** The subset of a ledger row a trade-fee valuation reads. */
export type FeeBearingTransaction = ValuableTransaction &
  Pick<HoldingTransaction, 'tokenId' | 'feeQuantity' | 'feeTokenId'>;

/**
 * A row's trade fee in base currency at `occurredAt` (SC-1142).
 *
 * `amount: null` is a fee that IS on the row and could not be valued — a token
 * nothing prices, a token since deleted (`fee_token_id` is `ON DELETE SET
 * NULL`), or text that is not a number. It is not zero: zero is a figure.
 */
export interface FeeValuation {
  amount: Decimal | null;
  stale: boolean;
}

/**
 * What the row's trade fee is worth, or `null` when it carries none — absent,
 * blank, or zero in any spelling. That `null` is what lets a fee-free ledger
 * take exactly the path it took before fees were read at all.
 *
 * Each route is the one the walk already uses for the same instant:
 *
 *   - **In the row's own token** — `valueTransactionInBase`, so the trade's own
 *     execution rate when it has one. A fee taken in the coin being bought is
 *     worth what that coin cost in this trade, not a spot quote.
 *   - **In any other token** — the counter asset, or a third one such as BNB —
 *     the series at `occurredAt`.
 *
 * Providers store the fee negative and the manual route stores what was typed,
 * so the sign is ignored and the magnitude is valued.
 */
export function valueTradeFeeInBase(
  prices: PriceSeries,
  tx: FeeBearingTransaction,
  baseCurrencyId: string,
  heldTokenId: string | null,
  now: Date
): FeeValuation | null {
  const qty = tradeFeeQuantity(tx.feeQuantity);
  if (qty === null) return null;
  if (qty === 'unreadable' || tx.feeTokenId === null) return { amount: null, stale: false };
  if (tx.feeTokenId === baseCurrencyId) return { amount: qty, stale: false };

  if (tx.feeTokenId === tx.tokenId || tx.feeTokenId === heldTokenId) {
    const own = valueTransactionInBase(
      prices,
      { ...tx, occurredAt: valuationInstant(tx, now, true) },
      qty,
      baseCurrencyId,
      heldTokenId
    );
    return own ? { amount: own.amount, stale: own.stale } : { amount: null, stale: false };
  }

  const converted = convert(prices, qty, tx.feeTokenId, valuationInstant(tx, now, true));
  return converted
    ? { amount: converted.amount, stale: converted.stale }
    : { amount: null, stale: false };
}

function tradeFeeQuantity(stored: string | null): Decimal | 'unreadable' | null {
  const text = stored?.trim();
  if (!text) return null;
  let qty: Decimal;
  try {
    qty = new Decimal(text);
  } catch {
    return 'unreadable';
  }
  if (!qty.isFinite()) return 'unreadable';
  return qty.isZero() ? null : qty.abs();
}

/**
 * `valuation` with `share` of the row's fee applied: `1` for an acquisition,
 * whose fee adds to what it cost, and a negative share for a disposal, whose
 * fee comes off what it raised — `-1` for a whole row, less for one share of a
 * split answer.
 *
 * Returns `valuation` itself when there is no fee, never a copy, so a fee-free
 * row's figures are the same objects they always were.
 *
 * A fee nothing could value leaves the amount alone and sets `stale`. Every
 * reader of that flag reads it as "this figure rests on a price that could not
 * be settled" and grades the basis `partial`, which is the claim to make about
 * a figure that knowingly leaves a charge out.
 */
export function withTradeFee(
  valuation: TxValuation | null,
  fee: FeeValuation | null,
  share: Decimal
): TxValuation | null {
  if (fee === null || valuation === null) return valuation;
  if (fee.amount === null) return { ...valuation, stale: true };
  return {
    amount: valuation.amount.add(fee.amount.mul(share)),
    stale: valuation.stale || fee.stale,
    basis: valuation.basis,
  };
}

/**
 * The instant a flow is valued at: the one the daily rollup values that day's
 * balance at (SC-1254).
 *
 * A flow and the balance change it causes must be read at the same prices, or
 * the difference lands in the return. Valued at its own timestamp, a deposit
 * at 10:28 read the latest price at or before it, while the rollup valued the
 * same money at 23:59:59.999Z. Where a pair has more than one price per day —
 * a seeded series and a backfilled one, 5.7% apart — that turned flat cash
 * into a −7.8% return.
 *
 * `RollupPortfolioValueDailyUseCase` values a past day at 23:59:59.999Z and
 * today at the moment it runs, so today's flows are valued now.
 */
export function flowValuationInstant(occurredAt: Date, now: Date): Date {
  const endOfDay = new Date(occurredAt);
  endOfDay.setUTCHours(23, 59, 59, 999);
  return endOfDay.getTime() > now.getTime() ? now : endOfDay;
}

const SWAP_LEG_KINDS: ReadonlySet<string> = new Set(['swap_in', 'swap_out']);

function isSwapLeg(tx: Pick<HoldingTransaction, 'kind'>): boolean {
  return SWAP_LEG_KINDS.has(tx.kind);
}

/** The subset of a ledger row a swap leg's valuation reads. */
export type SwapLegTransaction = ValuableTransaction &
  Pick<HoldingTransaction, 'kind' | 'quantity' | 'counterTokenId' | 'counterQuantity'>;

/**
 * A swap leg's value in base currency: what ARRIVED in the swap, at the day's
 * close — the one number the external flow and the cost walk both use.
 *
 * Valued at the arrival, both legs of one swap take one number, so a swap
 * inside the scope cancels and the slippage stays with the side that paid it
 * (SC-1438). The cost walk used to keep each leg's execution rate instead, so
 * a swap-in's lot cost and its flow differed by the slippage and the intraday
 * move, and that difference surfaced as value change that was neither a flow
 * nor a gain (SC-1475). Sharing the number moves the slippage into the
 * swap-out's realized result, which is where it was paid.
 *
 * Falls back to the row's own valuation when the arrival cannot be priced.
 */
function valueSwapLegInBase(
  prices: PriceSeries,
  tx: SwapLegTransaction,
  qtyAbs: Decimal,
  baseCurrencyId: string,
  heldTokenId: string | null,
  now: Date
): TxValuation | null {
  const at = valuationInstant(tx, now);
  const arrival = swapLegArrival(tx, qtyAbs, heldTokenId);
  if (arrival) {
    const valued = valueTransactionInBase(
      prices,
      { priceNative: null, priceNativeTokenId: null, occurredAt: at },
      arrival.quantity,
      baseCurrencyId,
      arrival.tokenId
    );
    if (valued) return valued;
  }
  return valueTransactionInBase(
    prices,
    { ...tx, occurredAt: at },
    qtyAbs,
    baseCurrencyId,
    heldTokenId
  );
}

function swapLegArrival(
  tx: SwapLegTransaction,
  qtyAbs: Decimal,
  heldTokenId: string | null
): { tokenId: string; quantity: Decimal } | null {
  if (tx.kind === 'swap_in' && heldTokenId) return { tokenId: heldTokenId, quantity: qtyAbs };
  if (tx.kind !== 'swap_out' || !tx.counterTokenId || !tx.counterQuantity) return null;
  const own = new Decimal(tx.quantity).abs();
  if (own.isZero()) return null;
  // A fee share taken off this leg takes the same share of what it bought.
  return {
    tokenId: tx.counterTokenId,
    quantity: new Decimal(tx.counterQuantity).abs().mul(qtyAbs).div(own),
  };
}

const TRADE_KINDS: ReadonlySet<string> = new Set(['buy', 'sell']);

function hasExecutionPrice(tx: Pick<HoldingTransaction, 'priceNative' | 'priceNativeTokenId'>) {
  return Boolean(tx.priceNative && tx.priceNativeTokenId);
}

/**
 * A row's value in base currency, as BOTH the flow side and the cost walk
 * read it: one number per row, or the difference lands as value change that
 * is neither a flow nor a gain.
 *
 * A swap leg takes its swap's shared valuation (SC-1475). A trade with its own
 * execution price is valued at its own instant (SC-1470). Everything else —
 * an opening balance, a deposit, a trade the source reported without a price —
 * is valued at the day's close, where the rollup values that day's balance
 * (SC-1254). The cost walk used to price those at their own minute while the
 * flow took the close, so the intraday move stood between them (SC-1486).
 */
export function valueRowInBase(
  prices: PriceSeries,
  tx: SwapLegTransaction,
  qtyAbs: Decimal,
  baseCurrencyId: string,
  heldTokenId: string | null,
  now: Date
): TxValuation | null {
  if (isSwapLeg(tx)) {
    return valueSwapLegInBase(prices, tx, qtyAbs, baseCurrencyId, heldTokenId, now);
  }
  const at = valuationInstant(tx, now);
  return valueTransactionInBase(
    prices,
    { ...tx, occurredAt: at },
    qtyAbs,
    baseCurrencyId,
    heldTokenId
  );
}

function valuationInstant(
  tx: ValuableTransaction & Partial<Pick<HoldingTransaction, 'kind'>>,
  now: Date,
  fee = false
): Date {
  return fee || (TRADE_KINDS.has(tx.kind ?? '') && hasExecutionPrice(tx))
    ? tx.occurredAt
    : flowValuationInstant(tx.occurredAt, now);
}

/** A conservative superset: include fallbacks before knowing which routes resolve. */
export function valuationInstantsOf(
  tx: SwapLegTransaction & FeeBearingTransaction,
  baseCurrencyId: string,
  heldTokenId: string | null,
  now: Date
): PriceAsk[] {
  const asks = new Map<string, PriceAsk>();
  const add = (tokenId: string | null, at: Date) => {
    if (tokenId && tokenId !== baseCurrencyId) {
      asks.set(`${tokenId}|${at.getTime()}`, { tokenId, at });
    }
  };
  const own = (at: Date) => {
    if (hasExecutionPrice(tx)) {
      if (tx.priceNativeTokenId === baseCurrencyId) return;
      add(tx.priceNativeTokenId, at);
    }
    add(heldTokenId, at);
  };
  const at = valuationInstant(tx, now);
  if (isSwapLeg(tx)) {
    const arrival = swapLegArrival(tx, new Decimal(tx.quantity).abs(), heldTokenId);
    if (arrival) add(arrival.tokenId, at);
  }
  own(at);
  const fee = tradeFeeQuantity(tx.feeQuantity);
  if (fee !== null && fee !== 'unreadable' && tx.feeTokenId !== baseCurrencyId) {
    const feeAt = valuationInstant(tx, now, true);
    if (tx.feeTokenId === tx.tokenId || tx.feeTokenId === heldTokenId) own(feeAt);
    else add(tx.feeTokenId, feeAt);
  }
  return [...asks.values()];
}
