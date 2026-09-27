import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { buildComparison } from '../../../src/lib/returns/comparison';

/**
 * SC-1297 — assembling the card: the headline in money, the attribution bar,
 * the chart's points, and how far ahead or behind each benchmark the reader is.
 *
 * "Ahead" is a MONEY gap, not a rate gap: what the portfolio is worth now
 * minus what the same deposits would be worth in the benchmark now. That is
 * the question a rate cannot answer, because the deposits did not all arrive
 * at the start.
 */

const d = (n: string | number) => new Decimal(n);

const series = [
  { date: '2026-01-01', value: '1000', netExternalFlow: '0' },
  { date: '2026-01-02', value: '1100', netExternalFlow: '0' },
  { date: '2026-01-03', value: '1300', netExternalFlow: '100' },
];

const flatBtc = new Map([
  ['2026-01-01', d(10)],
  ['2026-01-02', d(10)],
  ['2026-01-03', d(10)],
]);

describe('buildComparison', () => {
  test('the headline is the money change over the window', () => {
    const card = buildComparison({
      series,
      netExternalFlow: '100',
      attribution: null,
      benchmarkPrices: new Map(),
    });

    expect(card.headline.change).toBe('300');
    expect(card.headline.from).toBe('2026-01-01');
    expect(card.headline.to).toBe('2026-01-03');
  });

  test('the attribution separates what was added from what was earned', () => {
    const card = buildComparison({
      series,
      netExternalFlow: '100',
      attribution: null,
      benchmarkPrices: new Map(),
    });

    expect(card.attribution.contributions).toBe('100');
    expect(card.attribution.gain).toBe('200');
    expect(card.attribution.market).toBeNull();
  });

  test('a benchmark with prices produces a chart line and a money gap', () => {
    const card = buildComparison({
      series,
      netExternalFlow: '100',
      attribution: null,
      benchmarkPrices: new Map([['btc', flatBtc]]),
    });

    // Flat benchmark: 1000 opening plus a 100 deposit is worth 1100 at the end,
    // against a real portfolio of 1300 — so the reader is 200 ahead.
    const gap = card.gaps.find((g) => g.key === 'btc');
    expect(gap?.money).toBe('200');
    expect(gap?.benchmarkValue).toBe('1100');

    expect(card.chart.map((p) => p.benchmarks.btc)).toEqual(['1000', '1000', '1100']);
  });

  test('a benchmark with no prices at all yields no gap and no line', () => {
    const card = buildComparison({
      series,
      netExternalFlow: '100',
      attribution: null,
      benchmarkPrices: new Map([['btc', new Map()]]),
    });

    expect(card.gaps.find((g) => g.key === 'btc')).toBeUndefined();
    expect(card.chart.every((p) => p.benchmarks.btc === undefined)).toBe(true);
  });

  test('a benchmark priced for only part of the window still gives a gap, and the line has a hole', () => {
    const partial = new Map([['2026-01-03', d(20)]]);

    const card = buildComparison({
      series,
      netExternalFlow: '100',
      attribution: null,
      benchmarkPrices: new Map([['btc', partial]]),
    });

    expect(card.chart[0]?.benchmarks.btc).toBeUndefined();
    // All 1100 of the reader's money buys in on the first priced day.
    expect(card.gaps.find((g) => g.key === 'btc')?.benchmarkValue).toBe('1100');
  });

  test('an empty window is an empty card rather than a zero one', () => {
    const card = buildComparison({
      series: [],
      netExternalFlow: '0',
      attribution: null,
      benchmarkPrices: new Map([['btc', flatBtc]]),
    });

    expect(card.headline.change).toBeNull();
    expect(card.chart).toEqual([]);
    expect(card.gaps).toEqual([]);
  });

  test('the chart ends on the value the headline is computed from', () => {
    const card = buildComparison({
      series,
      netExternalFlow: '100',
      attribution: null,
      benchmarkPrices: new Map([['btc', flatBtc]]),
    });

    expect(card.chart[card.chart.length - 1]?.portfolio).toBe('1300');
    expect(card.chart[card.chart.length - 1]?.date).toBe(card.headline.to ?? undefined);
  });
});
