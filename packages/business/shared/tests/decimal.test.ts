import { describe, expect, test } from 'bun:test';
import { Decimal, isValidDecimalString } from '../src/decimal';

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
