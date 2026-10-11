import { describe, expect, test } from 'bun:test';
import {
  earliestFromDay,
  mergeFromDay,
  PORTFOLIO_HISTORY_BACKFILL,
  PORTFOLIO_HISTORY_LOOKBACK_DAYS,
  rebuildWindowDays,
} from '../../src/user-jobs/portfolio-history-backfill';

// The longest window the portfolio charts offer in the UI (1Y).
const MAX_CHART_WINDOW_DAYS = 365;

describe('PORTFOLIO_HISTORY_LOOKBACK_DAYS', () => {
  // A full recompute must reach strictly deeper than the longest chart
  // window. The rollup loop produces `lookbackDays` calendar days
  // ending today, so it only reaches back `lookbackDays - 1` days,
  // while the 1Y chart requests `today - 365d`. If the lookback is not
  // strictly greater than the chart window, the chart's oldest point
  // falls on an un-recomputed (stale) row — which the PnL chart's
  // window re-basing then anchors the whole curve to.
  test('reaches strictly deeper than the longest chart window', () => {
    expect(PORTFOLIO_HISTORY_LOOKBACK_DAYS - 1).toBeGreaterThan(MAX_CHART_WINDOW_DAYS);
  });
});

// SC-1607: an edit rebuilt the user's whole history (~1,860 days, median
// 42 min) because the job had no way to say where the edit's effect starts.
describe('a rebuild from a start day (SC-1607)', () => {
  const ANCHOR = new Date('2026-10-07T08:30:00.000Z');

  test('the window reaches the start day exactly: today is offset 0', () => {
    expect(rebuildWindowDays(1870, '2026-10-07', ANCHOR)).toBe(1);
    expect(rebuildWindowDays(1870, '2026-10-01', ANCHOR)).toBe(7);
  });

  test('a start day past the anchor still rebuilds today', () => {
    expect(rebuildWindowDays(1870, '2026-10-09', ANCHOR)).toBe(1);
  });

  test('never wider than the full-history bound the enqueue read', () => {
    expect(rebuildWindowDays(30, '2020-01-01', ANCHOR)).toBe(30);
  });

  test('control: no start day keeps the full-history window', () => {
    expect(rebuildWindowDays(1870, undefined, ANCHOR)).toBe(1870);
  });

  test('widening moves the start day earlier, never later', () => {
    expect(earliestFromDay('2026-10-01', new Date('2026-09-15T23:00:00Z'), null, undefined)).toBe(
      '2026-09-15'
    );
    expect(earliestFromDay('2026-10-01', new Date('2026-10-05T00:00:00Z'))).toBe('2026-10-01');
  });

  test('a full-history request stays full whatever the job learns', () => {
    expect(earliestFromDay(undefined, new Date('2026-09-15T00:00:00Z'))).toBeUndefined();
  });

  test('two requests merged keep the earlier start, and full absorbs any start', () => {
    expect(mergeFromDay('2026-10-01', '2026-09-20')).toBe('2026-09-20');
    expect(mergeFromDay('2026-09-20', '2026-10-01')).toBe('2026-09-20');
    expect(mergeFromDay(undefined, '2026-10-01')).toBeUndefined();
    expect(mergeFromDay('2026-10-01', undefined)).toBeUndefined();
  });

  test('the payload carries a start day, and only a calendar day', () => {
    const base = { userId: 'u', requestId: 'r', tokenIds: [], lookbackDays: 400 };
    expect(
      PORTFOLIO_HISTORY_BACKFILL.schema.safeParse({ ...base, fromDay: '2026-10-01' }).success
    ).toBe(true);
    expect(
      PORTFOLIO_HISTORY_BACKFILL.schema.safeParse({ ...base, fromDay: '2026-10-01T00:00:00Z' })
        .success
    ).toBe(false);
  });

  test('the start day is not part of the job id, so a pending rebuild can absorb an earlier one', () => {
    const base = { userId: 'u', requestId: 'r', tokenIds: [], lookbackDays: 400 };
    expect(PORTFOLIO_HISTORY_BACKFILL.computeJobId({ ...base, fromDay: '2026-10-01' })).toBe(
      PORTFOLIO_HISTORY_BACKFILL.computeJobId({ ...base, fromDay: '2026-09-01' })
    );
  });
});
