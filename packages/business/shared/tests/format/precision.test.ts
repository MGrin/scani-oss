import { describe, expect, it } from 'bun:test';
import { moneyDecimals, quantityDecimals, roundToDecimals } from '../../src/format/precision';

describe('moneyDecimals', () => {
  it('gives an ordinary amount two decimals', () => {
    expect(moneyDecimals('98.33333333333333333333333333')).toBe(2);
    expect(moneyDecimals('130017.64836043886')).toBe(2);
    expect(moneyDecimals('0.01')).toBe(2);
    expect(moneyDecimals('-1234.5')).toBe(2);
  });

  it('gives zero two decimals rather than reaching for significance it has none of', () => {
    expect(moneyDecimals('0')).toBe(2);
    expect(moneyDecimals('0.000')).toBe(2);
  });

  it('extends only for a figure that would otherwise round to nothing', () => {
    // SC-179: LUNC at €0.0000771. `0.00` beside a quantity of 4,200,000 makes a
    // statement that contradicts its own total.
    expect(moneyDecimals('0.00007714915547392611')).toBe(8);
    expect(moneyDecimals('-0.00007714915547392611')).toBe(8);
    // Rounds to €0.01, which is a real answer — nothing to extend for.
    expect(moneyDecimals('0.009')).toBe(2);
  });

  it('extends no further than the figure has digits to justify', () => {
    // Three, not six: `0.004` says everything `0.004000` would.
    expect(moneyDecimals('0.004')).toBe(3);
    expect(moneyDecimals('0.0000000000000001')).toBe(16);
  });

  it('stops at the smallest unit any token has, so a bad price cannot run away', () => {
    expect(moneyDecimals('0.0000000000000000000000001')).toBe(18);
  });

  it('treats an unparseable figure as ordinary money', () => {
    expect(moneyDecimals('')).toBe(2);
    expect(moneyDecimals('n/a')).toBe(2);
  });
});

describe('quantityDecimals', () => {
  it('shows only the digits the quantity actually carries', () => {
    // SC-177: the realized ledger padded every one of these to 8dp.
    expect(quantityDecimals('500000000.00000000')).toBe(0);
    expect(quantityDecimals('1200.00000000')).toBe(0);
    expect(quantityDecimals('3')).toBe(0);
    expect(quantityDecimals('0.05000000')).toBe(2);
    expect(quantityDecimals('0.8241')).toBe(4);
  });

  it('caps an ordinary fraction where a balance stops meaning anything', () => {
    expect(quantityDecimals('1.123456789123')).toBe(8);
  });

  it('lifts that cap only to keep a dust balance from reading as zero', () => {
    // Capped at 8 this is `0.00000000` — a claim that the position is empty.
    expect(quantityDecimals('0.000000001')).toBe(9);
    expect(quantityDecimals('0.000000000123456789')).toBe(13);
  });

  it('reads a number as readily as a decimal string', () => {
    expect(quantityDecimals(84)).toBe(0);
    expect(quantityDecimals(0.2841)).toBe(4);
  });

  it('has nothing to show for a figure that is not one', () => {
    expect(quantityDecimals(Number.NaN)).toBe(0);
    expect(quantityDecimals(null)).toBe(0);
    expect(quantityDecimals('')).toBe(0);
  });
});

describe('roundToDecimals', () => {
  it('rounds rather than truncates, and never through a float', () => {
    expect(roundToDecimals('98.33333333333333333333333333', 2)).toBe('98.33');
    expect(roundToDecimals('0.867', 2)).toBe('0.87');
    expect(roundToDecimals('35.13513513513512', 2)).toBe('35.14');
    expect(roundToDecimals('-0.005', 2)).toBe('-0.01');
  });

  it('writes the decimals it was asked for, padding a short figure', () => {
    expect(roundToDecimals('12', 2)).toBe('12.00');
    expect(roundToDecimals('4914', 0)).toBe('4914');
  });

  it('never emits an exponent, whatever the magnitude', () => {
    expect(roundToDecimals('0.0000000000000001', 16)).toBe('0.0000000000000001');
    expect(roundToDecimals('1e21', 0)).toBe('1000000000000000000000');
  });

  it('leaves a figure it cannot parse exactly as it found it', () => {
    expect(roundToDecimals('n/a', 2)).toBe('n/a');
  });
});
