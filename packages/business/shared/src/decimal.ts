import { Decimal } from 'decimal.js';

// Project-wide Decimal.js configuration. Imported once anywhere triggers
// the side effect — re-exporting from this module ensures every caller
// gets the same configured instance.
//
// 28-digit precision covers every fiat + crypto value we deal with
// (largest holding ≈ 10^15 USD; smallest token unit ≈ 10^-18). HALF_UP
// rounding matches accountant-friendly behaviour.
Decimal.set({
  precision: 28,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -7,
  toExpPos: 21,
  minE: -9e15,
  maxE: 9e15,
  crypto: false,
  modulo: Decimal.ROUND_DOWN,
});

export { Decimal };

/**
 * True iff `value` parses as a finite Decimal. Used at the file-import
 * boundary to reject NaN / Infinity / unparseable strings before they
 * reach Decimal arithmetic.
 */
export function isValidDecimalString(value: string): boolean {
  try {
    return new Decimal(value).isFinite();
  } catch {
    return false;
  }
}

/**
 * The most digits an amount may carry before its decimal point (SC-1527).
 *
 * The note above puts the largest holding at about 10^15 USD, and an amount in
 * units is the same order: a whole meme-coin supply is ~10^15 tokens. A
 * 21-digit amount typed into manual entry was stored, priced and summed into a
 * $162,975,307.2T net worth. Fifteen digits plus eighteen decimals also stays
 * within reach of the 28-digit precision every valuation multiplies at.
 */
export const AMOUNT_MAX_INTEGER_DIGITS = 15;

const AMOUNT_CEILING = new Decimal(10).pow(AMOUNT_MAX_INTEGER_DIGITS);

/** A finite amount, of either sign, under `AMOUNT_MAX_INTEGER_DIGITS`. */
export function amountWithinIntegerDigits(value: string): boolean {
  if (!isValidDecimalString(value)) return false;
  return new Decimal(value).abs().lessThan(AMOUNT_CEILING);
}
