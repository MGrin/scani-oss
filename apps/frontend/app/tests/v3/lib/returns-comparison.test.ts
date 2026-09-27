import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import {
  COMPARISON_SERIES,
  type ComparisonPayload,
  comparisonView,
} from '../../../src/v3/lib/returns-comparison';

function payload(overrides: Record<string, unknown> = {}): ComparisonPayload {
  return {
    comparison: {
      headline: { change: '24000', from: '2026-01-01', to: '2026-09-19' },
      attribution: {
        contributions: '4000',
        gain: '20000',
        market: '18000',
        currency: '2000',
        crossEffect: '0',
      },
      chart: [
        { date: '2026-01-01', portfolio: '100000', benchmarks: { btc: '100000' } },
        { date: '2026-06-01', portfolio: '110000', benchmarks: { btc: '108000', sp500: '104000' } },
        { date: '2026-09-19', portfolio: '124000', benchmarks: { btc: '119800', sp500: '112000' } },
      ],
      gaps: [
        { key: 'sp500', money: '12000', benchmarkValue: '112000' },
        { key: 'btc', money: '4200', benchmarkValue: '119800' },
      ],
    },
    baseCurrencyId: 'usd',
    truncated: false,
    ...overrides,
  } as unknown as ComparisonPayload;
}

describe('comparisonView (SC-1297)', () => {
  test('a day a benchmark has no price is a HOLE, not a bridge', () => {
    const view = comparisonView(payload());
    // S&P 500 starts on the second point; the first must carry null so
    // `connectNulls={false}` refuses to draw a segment across it.
    expect(view?.points[0]?.sp500).toBeNull();
    expect(view?.points[1]?.sp500).toBeCloseTo(104000, 6);
    // Control: the portfolio and BTC are present on that same day.
    expect(view?.points[0]?.portfolio).toBeCloseTo(100000, 6);
    expect(view?.points[0]?.btc).toBeCloseTo(100000, 6);
  });

  test('a benchmark with no point anywhere gets no line and no legend entry', () => {
    const view = comparisonView(payload());
    expect(view?.lines).toEqual(['btc', 'sp500']);
    // Inflation was never priced, so it is absent rather than drawn flat.
    expect(view?.points[0]?.us_inflation).toBeNull();
  });

  test('lines keep a fixed order, so a missing benchmark never repaints another', () => {
    const one = payload();
    const withoutBtc = payload({
      comparison: {
        ...(one.comparison as object),
        chart: (one.comparison as { chart: { benchmarks: Record<string, string> }[] }).chart.map(
          (point) => ({ ...point, benchmarks: { sp500: point.benchmarks.sp500 ?? '104000' } })
        ),
      },
    });
    expect(comparisonView(withoutBtc)?.lines).toEqual(['sp500']);
    // The S&P's colour is a property of the S&P, not of its position.
    expect(COMPARISON_SERIES.sp500.color).toBe(COMPARISON_SERIES.sp500.color);
  });

  test('gaps come back in display order with the money signed', () => {
    const view = comparisonView(payload(), [
      { key: 'btc', cumulative: 19.8 },
      { key: 'sp500', cumulative: 12 },
    ]);
    expect(view?.gaps.map((gap) => gap.key)).toEqual(['btc', 'sp500']);
    expect(view?.gaps[0]?.money).toBeCloseTo(4200, 6);
    expect(view?.gaps[0]?.cumulative).toBeCloseTo(19.8, 6);
  });

  test('a benchmark whose own return is unknown still shows its money gap', () => {
    const view = comparisonView(payload(), []);
    expect(view?.gaps[0]?.money).toBeCloseTo(4200, 6);
    expect(view?.gaps[0]?.cumulative).toBeNull();
  });

  test('no comparison, or a chart of one point, is nothing to draw', () => {
    expect(comparisonView({ comparison: null, baseCurrencyId: null, truncated: false })).toBeNull();
    const single = payload();
    (single.comparison as { chart: unknown[] }).chart = [
      { date: '2026-01-01', portfolio: '100000', benchmarks: {} },
    ];
    expect(comparisonView(single)?.points).toEqual([]);
  });
});
