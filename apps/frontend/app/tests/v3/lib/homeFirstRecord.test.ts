import { describe, expect, test } from 'bun:test';
import {
  fromFirstRecord,
  type NetWorthPoint,
  netWorthChartPoints,
  resolvePeriodDelta,
} from '../../../src/v3/lib/home';

/**
 * SC-1248. A first holding added minutes ago arrives with a 30-day series,
 * every day of it today's balance at that day's price. Home drew it and put
 * "−$24.99 vs 30d" in red under it.
 */

function day(date: string, totalValue: string, beforeRecords: number | null, total = 1) {
  return {
    date,
    totalValue,
    holdingsWithKnownValue: total,
    holdingsTotal: total,
    holdingsBeforeRecords: beforeRecords,
  } satisfies NetWorthPoint;
}

// The walk's case: one EUR holding, created today.
const brandNew = [
  day('2026-08-20', '1487.05', 1),
  day('2026-09-01', '1470.10', 1),
  day('2026-09-18', '1462.06', 1),
];

describe('fromFirstRecord', () => {
  test('a portfolio with nothing on record before today has no history', () => {
    expect(fromFirstRecord(brandNew)).toEqual([]);
  });

  test('so there is no delta, and the chart is today alone', () => {
    const series = fromFirstRecord(brandNew);
    expect(resolvePeriodDelta(series, '1462.06')).toBeNull();
    expect(netWorthChartPoints(series, '1462.06', '2026-09-19')).toEqual([
      { date: '2026-09-19', value: 1462.06 },
    ]);
    // Control: the untrimmed series is exactly what produced the red loss.
    expect(resolvePeriodDelta(brandNew, '1462.06')?.absolute).toBeCloseTo(-24.99, 2);
  });

  test('history starts on the first day anything was on record', () => {
    const series = [
      day('2026-09-01', '100', 2, 2),
      day('2026-09-05', '150', 1, 2),
      day('2026-09-10', '160', 0, 2),
    ];
    expect(fromFirstRecord(series).map((p) => p.date)).toEqual(['2026-09-05', '2026-09-10']);
  });

  test('only the leading run goes: a projected day between real ones stays', () => {
    const series = [
      day('2026-09-01', '100', 0),
      day('2026-09-02', '101', 1),
      day('2026-09-03', '102', 0),
    ];
    expect(fromFirstRecord(series)).toHaveLength(3);
  });

  test('a row without the count is never dropped for its absence', () => {
    const series = [day('2026-09-01', '100', null), day('2026-09-02', '101', 1)];
    expect(fromFirstRecord(series)).toHaveLength(2);
  });
});
