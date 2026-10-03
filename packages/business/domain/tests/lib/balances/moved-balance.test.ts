import { describe, expect, test } from 'bun:test';
import { Decimal } from '@scani/shared';
import { movedBalance } from '../../../src/lib/balances/moved-balance';

describe('movedBalance', () => {
  test('a balance below 1e-6 is plain decimal text, where Decimal writes an exponent', () => {
    const delta = new Decimal('0.00000005');
    // The control: the notation this exists to keep out of the cache.
    expect(new Decimal('0').add(delta).toString()).toBe('5e-8');
    expect(movedBalance('0', delta)).toBe('0.00000005');
  });

  test('a negative delta takes the amount off', () => {
    expect(movedBalance('0.0000001', new Decimal('0.00000005').neg())).toBe('0.00000005');
    expect(movedBalance('4000', new Decimal('2000').neg())).toBe('2000');
  });

  test('an ordinary balance reads as it always has', () => {
    expect(movedBalance('4000', new Decimal('250.5'))).toBe('4250.5');
    expect(movedBalance('1.50', new Decimal('0'))).toBe('1.5');
  });
});
