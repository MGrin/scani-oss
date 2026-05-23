import { describe, expect, test } from 'bun:test';
import { enforceSign, inferCounterSign, negateFee } from '../../../src/core/utils/enforce-tx-sign';

describe('enforceSign — sign-by-kind rules', () => {
  test('sell flips a positive raw quantity to negative', () => {
    expect(enforceSign('1.5', 'sell')).toBe('-1.5');
  });

  test('withdraw flips a positive raw quantity to negative', () => {
    expect(enforceSign('0.25', 'withdraw')).toBe('-0.25');
  });

  test('fee flips a positive raw quantity to negative', () => {
    expect(enforceSign('5', 'fee')).toBe('-5');
  });

  test('buy flips a negative raw quantity to positive', () => {
    expect(enforceSign('-2', 'buy')).toBe('2');
  });

  test('deposit flips a negative raw quantity to positive', () => {
    expect(enforceSign('-1', 'deposit')).toBe('1');
  });

  test('reward keeps an already-positive quantity positive', () => {
    expect(enforceSign('0.01', 'reward')).toBe('0.01');
  });

  test('interest keeps an already-positive quantity positive', () => {
    expect(enforceSign('0.001', 'interest')).toBe('0.001');
  });

  test('sell with already-negative input stays negative (no double-flip)', () => {
    expect(enforceSign('-1.5', 'sell')).toBe('-1.5');
  });

  test('zero is preserved verbatim regardless of kind', () => {
    expect(enforceSign('0', 'sell')).toBe('0');
    expect(enforceSign('0', 'buy')).toBe('0');
    expect(enforceSign('0', 'fee')).toBe('0');
  });
});

describe('inferCounterSign — counter follows the opposite of primary', () => {
  test('primary positive (buy) → counter negative (you spent the quote)', () => {
    expect(inferCounterSign('1', '40000')).toBe('-40000');
  });

  test('primary negative (sell) → counter positive (you received the quote)', () => {
    expect(inferCounterSign('-1', '40000')).toBe('40000');
  });

  test('counter input is normalized via abs() before flipping', () => {
    expect(inferCounterSign('1', '-40000')).toBe('-40000');
    expect(inferCounterSign('-1', '-40000')).toBe('40000');
  });

  test('zero counter quantity stays zero', () => {
    expect(inferCounterSign('1', '0')).toBe('0');
    expect(inferCounterSign('-1', '0')).toBe('0');
  });
});

describe('negateFee — fees always flow out', () => {
  test('positive fee becomes negative', () => {
    expect(negateFee('5')).toBe('-5');
  });

  test('already-negative fee stays negative (abs() then negate)', () => {
    expect(negateFee('-5')).toBe('-5');
  });

  test('zero fee stays zero', () => {
    expect(negateFee('0')).toBe('0');
  });
});
