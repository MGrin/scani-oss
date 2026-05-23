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
