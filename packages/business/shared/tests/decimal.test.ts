import { describe, expect, test } from 'bun:test';
import {
  AMOUNT_MAX_INTEGER_DIGITS,
  amountWithinIntegerDigits,
  Decimal,
  isValidDecimalString,
} from '../src/decimal';

describe('Decimal — project-wide configuration', () => {
  test('has 28-digit precision', () => {
    expect(Decimal.precision).toBe(28);
  });

  test('rounds HALF_UP (accountant-friendly)', () => {
    expect(Decimal.rounding).toBe(Decimal.ROUND_HALF_UP);
  });

  test('arithmetic stays exact across many ops', () => {
    const sum = new Decimal('0.1').plus('0.2').plus('0.3').plus('0.4');
    expect(sum.toString()).toBe('1');
  });
});

describe('isValidDecimalString', () => {
  test('accepts well-formed decimal strings', () => {
    expect(isValidDecimalString('123')).toBe(true);
    expect(isValidDecimalString('123.456')).toBe(true);
    expect(isValidDecimalString('-123.456')).toBe(true);
    expect(isValidDecimalString('0')).toBe(true);
    expect(isValidDecimalString('1e10')).toBe(true);
  });

  test('rejects NaN / Infinity / unparseable strings', () => {
    expect(isValidDecimalString('NaN')).toBe(false);
    expect(isValidDecimalString('Infinity')).toBe(false);
    expect(isValidDecimalString('-Infinity')).toBe(false);
    expect(isValidDecimalString('not-a-number')).toBe(false);
    expect(isValidDecimalString('')).toBe(false);
    expect(isValidDecimalString('1.2.3')).toBe(false);
  });
});

describe('amountWithinIntegerDigits (SC-1527)', () => {
  test('the cap is fifteen digits before the point', () => {
    expect(AMOUNT_MAX_INTEGER_DIGITS).toBe(15);
  });

  test('accepts the largest amount under the cap, in any spelling Decimal reads', () => {
    expect(amountWithinIntegerDigits('999999999999999.99999999')).toBe(true);
    expect(amountWithinIntegerDigits('0')).toBe(true);
    // A screenshot parse can hand over a dust balance as JS prints it.
    expect(amountWithinIntegerDigits('1e-7')).toBe(true);
  });

  test('refuses the 21-digit amount that became a $162T net worth', () => {
    expect(amountWithinIntegerDigits('123456789012345678901')).toBe(false);
    expect(amountWithinIntegerDigits('1000000000000000')).toBe(false);
    expect(amountWithinIntegerDigits('-1000000000000000')).toBe(false);
  });

  test('refuses what is not a number at all', () => {
    expect(amountWithinIntegerDigits('abc')).toBe(false);
    expect(amountWithinIntegerDigits('Infinity')).toBe(false);
  });
});
