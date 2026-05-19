import { describe, expect, test } from 'bun:test';
import { PORTFOLIO_HISTORY_LOOKBACK_DAYS } from '../../src/user-jobs/portfolio-history-backfill';

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
