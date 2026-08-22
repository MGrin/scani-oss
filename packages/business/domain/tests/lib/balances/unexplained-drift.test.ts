import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { isExactReversal, unexplainedDrift } from '../../../src/lib/balances/unexplained-drift';

describe('unexplainedDrift', () => {
  test('a balance change the transactions fully explain is not a gap', () => {
    expect(unexplainedDrift('100', '150', ['30', '20']).toString()).toBe('0');
  });

  test('the remainder is what the ledger cannot account for', () => {
    expect(unexplainedDrift('100', '150', ['30']).toString()).toBe('20');
  });

  test('an outflow with no transaction beside it is negative', () => {
    expect(unexplainedDrift('41749.85', '22174.58', []).toString()).toBe('-19575.27');
  });

  test('a balance that did not move but had transactions in it still drifts', () => {
    // Money in and money out inside one interval, netting to a balance that
    // reads the same at both ends. `balance <> previousBalance` is therefore
    // NOT a sound pre-filter for a gap, which is why the SQL applies the whole
    // subtraction rather than looking at the two balances.
    expect(unexplainedDrift('100', '100', ['500']).toString()).toBe('-500');
  });

  test('an 18-decimal quantity survives, because nothing here is a float', () => {
    const drift = unexplainedDrift('0', '0.000000000000000001', []);
    expect(drift.toFixed()).toBe('0.000000000000000001');
    // The same subtraction in IEEE754 would land on 1e-18 as a float and
    // print in exponential; the string form is what reaches the queue.
    expect(drift.isZero()).toBe(false);
  });
});

describe('isExactReversal', () => {
  test('the production FXI pair reverses', () => {
    // Measured 2026-08-22: the IBKR feed reported 234.13 shares for one day
    // against 65.45 either side, with no transaction anywhere near it.
    expect(isExactReversal(new Decimal('172.85'), new Decimal('-172.85'))).toBe(true);
    expect(isExactReversal(new Decimal('-172.85'), new Decimal('172.85'))).toBe(true);
  });

  test('two real movements of nearly the same size do NOT reverse', () => {
    // The test a future reader is most likely to relax, so the reason is
    // here rather than in a ticket: a tolerance would suppress a genuine
    // deposit followed by a genuine withdrawal, and the whole justification
    // for suppressing anything is that the pair is EXACTLY equal and
    // opposite, which real money almost never is.
    expect(isExactReversal(new Decimal('1000'), new Decimal('-1000.01'))).toBe(false);
    expect(isExactReversal(new Decimal('172.85'), new Decimal('-172.8'))).toBe(false);
  });

  test('zero never reverses anything, in either position', () => {
    // Without the `isZero` guard every pair of explained intervals would
    // "reverse" each other, and the suppression would swallow the queue.
    expect(isExactReversal(new Decimal(0), new Decimal(0))).toBe(false);
  });

  test('two drifts in the same direction do not reverse', () => {
    expect(isExactReversal(new Decimal('1000'), new Decimal('1000'))).toBe(false);
  });
});
