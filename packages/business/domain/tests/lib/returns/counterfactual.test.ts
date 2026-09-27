import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { counterfactualSeries } from '../../../src/lib/returns/counterfactual';

/**
 * SC-1297 — "the same money, in BTC instead".
 *
 * The reader's own external flows, routed into a benchmark and valued on every
 * day of the window. The cases that matter are the ones where a naive
 * implementation is quietly wrong: money that was already invested when the
 * window opened, a withdrawal, a withdrawal larger than the position, and a
 * benchmark with no price for the first days of the window.
 */

const d = (n: string | number) => new Decimal(n);

/** A flat price of 10 on every day named. */
function flatPrices(days: string[], price = 10) {
  return new Map(days.map((day) => [day, d(price)]));
}

describe('counterfactualSeries', () => {
  test('opening value buys in on the first day, so an old portfolio is compared fairly', () => {
    const days = ['2026-01-01', '2026-01-02', '2026-01-03'];
    const prices = new Map([
      ['2026-01-01', d(10)],
      ['2026-01-02', d(11)],
      ['2026-01-03', d(12)],
    ]);

    const series = counterfactualSeries({
      days,
      prices,
      openingValue: d(1000),
      flowsByDay: new Map(),
    });

    // 100 units bought on day one, marked at each day's price.
    expect(series.get('2026-01-01')?.toString()).toBe('1000');
    expect(series.get('2026-01-02')?.toString()).toBe('1100');
    expect(series.get('2026-01-03')?.toString()).toBe('1200');
  });

  test('a deposit inside the window buys at that day price', () => {
    const days = ['2026-01-01', '2026-01-02', '2026-01-03'];
    const prices = new Map([
      ['2026-01-01', d(10)],
      ['2026-01-02', d(20)],
      ['2026-01-03', d(40)],
    ]);

    const series = counterfactualSeries({
      days,
      prices,
      openingValue: d(0),
      flowsByDay: new Map([['2026-01-02', d(200)]]),
    });

    expect(series.get('2026-01-01')?.toString()).toBe('0');
    // 10 units at 20 on the day it went in …
    expect(series.get('2026-01-02')?.toString()).toBe('200');
    // … worth double when the price doubles.
    expect(series.get('2026-01-03')?.toString()).toBe('400');
  });

  test('a withdrawal sells units at that day price', () => {
    const days = ['2026-01-01', '2026-01-02', '2026-01-03'];
    const prices = new Map([
      ['2026-01-01', d(10)],
      ['2026-01-02', d(20)],
      ['2026-01-03', d(20)],
    ]);

    const series = counterfactualSeries({
      days,
      prices,
      openingValue: d(100), // 10 units
      flowsByDay: new Map([['2026-01-02', d(-100)]]), // sells 5 units at 20
    });

    expect(series.get('2026-01-02')?.toString()).toBe('100');
    expect(series.get('2026-01-03')?.toString()).toBe('100');
  });

  test('a withdrawal larger than the position empties it and never goes negative', () => {
    const days = ['2026-01-01', '2026-01-02', '2026-01-03'];
    const prices = flatPrices(days);

    const series = counterfactualSeries({
      days,
      prices,
      openingValue: d(100),
      flowsByDay: new Map([['2026-01-02', d(-500)]]),
    });

    expect(series.get('2026-01-02')?.toString()).toBe('0');
    expect(series.get('2026-01-03')?.toString()).toBe('0');
  });

  test('days with no price are absent, and the line resumes when prices return', () => {
    const days = ['2026-01-01', '2026-01-02', '2026-01-03'];
    const prices = new Map([
      ['2026-01-03', d(20)],
      // 01 and 02 unpriced: the benchmark has no history that far back.
    ]);

    const series = counterfactualSeries({
      days,
      prices,
      openingValue: d(100),
      flowsByDay: new Map([['2026-01-02', d(100)]]),
    });

    // Nothing is invented for a day whose price is unknown …
    expect(series.has('2026-01-01')).toBe(false);
    expect(series.has('2026-01-02')).toBe(false);
    // … and the money still waiting to be invested buys in at the first
    // priced day, so the comparison is not silently short.
    expect(series.get('2026-01-03')?.toString()).toBe('200');
  });

  test('with one opening position and no flows it matches a plain price ratio', () => {
    const days = ['2026-01-01', '2026-06-30'];
    const prices = new Map([
      ['2026-01-01', d('37.5')],
      ['2026-06-30', d('56.25')],
    ]);

    const series = counterfactualSeries({
      days,
      prices,
      openingValue: d(1000),
      flowsByDay: new Map(),
    });

    const ratio = d('56.25').div(d('37.5'));
    expect(series.get('2026-06-30')?.toString()).toBe(d(1000).mul(ratio).toString());
  });
});
