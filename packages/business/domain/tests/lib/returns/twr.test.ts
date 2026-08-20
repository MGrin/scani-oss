import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { computeTimeWeightedReturn, type ValuationPoint } from '../../../src/lib/returns/twr';

function point(date: string, value: number | string, flow: number | string = 0): ValuationPoint {
  return { date, value: new Decimal(value), netExternalFlow: new Decimal(flow) };
}

function pct(value: string | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

describe('computeTimeWeightedReturn — worked examples with known answers', () => {
  // The scenario the whole engine exists for. Prices never move; the owner
  // pays 500 in halfway through. A value delta reads +50%. The truth is 0%.
  test('scenario: flat portfolio with a mid-period deposit returns exactly 0%', () => {
    const result = computeTimeWeightedReturn([
      point('2026-01-01', 1000),
      point('2026-01-02', 1000),
      point('2026-01-03', 1500, 500),
      point('2026-01-04', 1500),
    ]);
    expect(result).not.toBeNull();
    expect(pct(result?.cumulative)).toBe(0);
    expect(result?.skippedPeriods).toBe(0);
    // The naive figure this replaces, stated so the test says what it fixes.
    expect(1500 / 1000 - 1).toBe(0.5);
  });

  test('scenario: flat portfolio with a mid-period withdrawal returns exactly 0%', () => {
    const result = computeTimeWeightedReturn([
      point('2026-01-01', 1000),
      point('2026-01-02', 600, -400),
      point('2026-01-03', 600),
    ]);
    expect(pct(result?.cumulative)).toBe(0);
  });

  test('scenario: doubles then halves — reports 0%, and never a made-up gain', () => {
    const result = computeTimeWeightedReturn([
      point('2026-01-01', 100),
      point('2026-01-02', 200),
      point('2026-01-03', 100),
    ]);
    expect(pct(result?.cumulative)).toBe(0);
    expect(pct(result?.periods[0]?.return)).toBe(1);
    expect(pct(result?.periods[1]?.return)).toBe(-0.5);
  });

  test('scenario: doubles, then a deposit, then halves — still -50% on the last leg', () => {
    const result = computeTimeWeightedReturn([
      point('2026-01-01', 100),
      point('2026-01-02', 200),
      point('2026-01-03', 400, 200),
      point('2026-01-04', 200),
    ]);
    expect(pct(result?.cumulative)).toBe(0);
    expect(pct(result?.periods[1]?.return)).toBe(0);
    expect(pct(result?.periods[2]?.return)).toBe(-0.5);
  });

  test('scenario: a deposit that would otherwise mask a real loss', () => {
    // Value goes 1000 -> 1200, but 400 of that was paid in. The portfolio
    // LOST 200 on 1000 = -20%, where the value delta says +20%.
    const result = computeTimeWeightedReturn([
      point('2026-01-01', 1000),
      point('2026-01-02', 1200, 400),
    ]);
    expect(pct(result?.cumulative)).toBeCloseTo(-0.2, 12);
  });

  test('it compounds, it does not average', () => {
    const result = computeTimeWeightedReturn([
      point('2026-01-01', 100),
      point('2026-01-02', 110),
      point('2026-01-03', 121),
    ]);
    expect(pct(result?.cumulative)).toBeCloseTo(0.21, 12);
  });
});

describe('computeTimeWeightedReturn — periods it cannot measure', () => {
  test('a period opening at zero is skipped and COUNTED, never dropped silently', () => {
    const result = computeTimeWeightedReturn([
      point('2026-01-01', 0),
      point('2026-01-02', 500, 500),
      point('2026-01-03', 550),
    ]);
    expect(result?.skippedPeriods).toBe(1);
    expect(result?.measuredPeriods).toBe(1);
    expect(result?.periods[0]?.measured).toBe(false);
    expect(result?.periods[0]?.return).toBeNull();
    expect(pct(result?.cumulative)).toBeCloseTo(0.1, 12);
  });

  test('a flow larger than the closing value floors at total loss, never past -100%', () => {
    const result = computeTimeWeightedReturn([
      point('2026-01-01', 100),
      point('2026-01-02', 10, 50),
    ]);
    expect(pct(result?.cumulative)).toBe(-1);
  });

  test('fewer than two points is null, which is not zero', () => {
    expect(computeTimeWeightedReturn([])).toBeNull();
    expect(computeTimeWeightedReturn([point('2026-01-01', 100)])).toBeNull();
  });
});

describe('computeTimeWeightedReturn — annualization', () => {
  test('a sub-year window reports null rather than extrapolating', () => {
    const result = computeTimeWeightedReturn([point('2026-01-01', 100), point('2026-02-01', 110)]);
    expect(result?.annualized).toBeNull();
    expect(result?.spanDays).toBe(31);
  });

  test('exactly one year annualizes to the cumulative figure', () => {
    const result = computeTimeWeightedReturn([point('2025-01-01', 100), point('2026-01-01', 120)]);
    expect(result?.spanDays).toBe(365);
    expect(pct(result?.annualized)).toBeCloseTo(0.2, 10);
  });

  test('two years of +44% annualizes to about +20%', () => {
    const result = computeTimeWeightedReturn([point('2024-01-01', 100), point('2026-01-01', 144)]);
    // 2024 is a leap year, so the span is 731 days, not 730.
    expect(result?.spanDays).toBe(731);
    expect(pct(result?.annualized)).toBeCloseTo(0.1997, 4);
  });
});
