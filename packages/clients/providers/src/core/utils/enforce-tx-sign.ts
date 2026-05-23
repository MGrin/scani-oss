/**
 * Free-function sign helpers shared by every CEX / chain / broker
 * `transactions` implementation. The ledger invariant is "negative
 * quantity = outflow"; CEX subclass authors easily forget to flip
 * the sign on a "sold 1.5 BTC" payload, so providers route raw
 * exchange amounts through these helpers at the boundary.
 *
 * `BaseCexProvider` keeps an in-class copy of the same logic for the
 * default pagination pipeline; provider classes that build their own
 * pipeline (Coinbase v2's mixed accounts/ledgers feed, broker CSV
 * parsers, on-chain log decoders) call these directly.
 */

import Decimal from 'decimal.js';
import type { CexEventKind } from '../base/base-cex-provider';

/**
 * Re-assert the sign on `rawQty` from the event's `kind`.
 *
 *  - `sell` / `withdraw` / `fee` → negative
 *  - `buy` / `deposit` / `reward` / `interest` → positive
 *  - zero is preserved (no sign flip)
 */
export function enforceSign(rawQty: string, kind: CexEventKind): string {
  const qty = new Decimal(rawQty);
  if (qty.isZero()) return qty.toString();

  const shouldBeNegative = kind === 'sell' || kind === 'withdraw' || kind === 'fee';
  const shouldBePositive =
    kind === 'buy' || kind === 'deposit' || kind === 'reward' || kind === 'interest';

  if (shouldBeNegative && qty.isPositive()) return qty.neg().toString();
  if (shouldBePositive && qty.isNegative()) return qty.abs().toString();
  return qty.toString();
}

/**
 * Infer the counter leg's sign from the primary leg's signed quantity.
 *
 * On a buy/sell trade the two legs always flow in opposite directions:
 * if you bought BTC (`primary` positive) you spent USDT (`counter`
 * negative); if you sold BTC (`primary` negative) you received USDT
 * (`counter` positive). Concrete providers supply absolute counter
 * values; callers normalize via `Decimal.abs()` before flipping, so
 * already-signed inputs are tolerated.
 */
export function inferCounterSign(primaryQuantity: string, counterAbsQuantity: string): string {
  const primary = new Decimal(primaryQuantity);
  const counter = new Decimal(counterAbsQuantity).abs();
  if (counter.isZero()) return counter.toString();
  return primary.isNegative() ? counter.toString() : counter.neg().toString();
}

/**
 * Normalize a fee leg to its outflow representation: always negative.
 * Tolerates already-signed inputs by taking the absolute value first.
 */
export function negateFee(feeAbsQuantity: string): string {
  const abs = new Decimal(feeAbsQuantity).abs();
  if (abs.isZero()) return abs.toString();
  return abs.neg().toString();
}
