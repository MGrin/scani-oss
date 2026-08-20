import '../../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import { historyScopes } from '../../../../src/v3/components/home/HistoryExport';
import { HOME_PERIODS } from '../../../../src/v3/lib/home';

/**
 * The scope table is a function of `t` now (SC-201) — `HOME_PERIODS` carries
 * i18n keys, and a module constant has no way to resolve one. Building it with
 * the real `t` keeps every assertion below about the rendered English.
 */
const t = i18n.t.bind(i18n);
const HISTORY_SCOPES = historyScopes(t);

/**
 * SC-97 — the export must not quietly widen the window on screen.
 *
 * The sheet used to open on a fixed "Last 90d" and did not offer the chart's
 * two shortest ranges at all, so a reader on 1M got 91 rows for a 30-day view
 * with nothing in the file saying so. Every other v3 export mirrors the screen
 * and offers wider as a deliberate opt-out; the assertion here is that this one
 * can no longer drift away from the control it sits next to.
 */
describe('net-worth export scopes', () => {
  test('offers every window the chart offers, in the chart order', () => {
    expect(HISTORY_SCOPES.slice(0, HOME_PERIODS.length).map((scope) => scope.key)).toEqual(
      HOME_PERIODS.map((period) => period.key)
    );
  });

  test('each window exports exactly the days it is named for', () => {
    for (const period of HOME_PERIODS) {
      const scope = HISTORY_SCOPES.find((option) => option.key === period.key);
      // The reported defect in one line: 1M on screen, 90 days in the file.
      expect(`${period.key}:${scope?.days}`).toBe(`${period.key}:${period.days}`);
      expect(scope?.label).toContain(t(period.labelKey));
    }
  });

  test('keeps the wider-than-the-chart option as the deliberate opt-out, last', () => {
    const last = HISTORY_SCOPES[HISTORY_SCOPES.length - 1];
    expect(last?.key).toBe('all');
    expect(last?.days).toBe(365 * 6);
  });
});
