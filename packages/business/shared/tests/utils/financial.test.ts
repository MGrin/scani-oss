import { describe, expect, test } from 'bun:test';
import { isValidDecimalString } from '../../src/utils/financial';

describe('isValidDecimalString', () => {
  test('should accept valid decimal strings', () => {
    // Valid positive numbers
    expect(isValidDecimalString('123')).toBe(true);
    expect(isValidDecimalString('123.45')).toBe(true);
    expect(isValidDecimalString('0.001')).toBe(true);
    expect(isValidDecimalString('0')).toBe(true);
    expect(isValidDecimalString('1.0')).toBe(true);

    // Valid negative numbers (for general validation)
    expect(isValidDecimalString('-5')).toBe(true);
    expect(isValidDecimalString('-123.45')).toBe(true);

    // Scientific notation
    expect(isValidDecimalString('1e10')).toBe(true);
    expect(isValidDecimalString('1.5e-3')).toBe(true);
  });

  test('should reject invalid decimal strings', () => {
    // Invalid formats
    expect(isValidDecimalString('abc')).toBe(false);
    expect(isValidDecimalString('12.34.56')).toBe(false);
    expect(isValidDecimalString('')).toBe(false);
    expect(isValidDecimalString('  ')).toBe(false);

    // Special values that parseFloat accepts but Decimal.js should reject
    expect(isValidDecimalString('NaN')).toBe(false);
    expect(isValidDecimalString('Infinity')).toBe(false);
    expect(isValidDecimalString('-Infinity')).toBe(false);

    // Other invalid formats
    expect(isValidDecimalString('1,000')).toBe(false); // Comma separator
    expect(isValidDecimalString('123abc')).toBe(false); // Trailing letters
  });
});
