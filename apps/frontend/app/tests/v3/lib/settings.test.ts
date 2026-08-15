import { describe, expect, test } from 'bun:test';
import {
  type DataQualityReport,
  dataQualityRows,
  summariseUserAgent,
} from '../../../src/v3/lib/settings';

function report(overrides: Partial<DataQualityReport> = {}): DataQualityReport {
  return {
    duplicateTokens: [],
    holdings: {
      visible: 42,
      total: 60,
      zeroVisible: 0,
      zeroVisibleStale: 0,
      unpricedVisible: 0,
      unpriceableVisible: 0,
      negativeOpening: 0,
      missingCoverage: 0,
    },
    thresholds: { staleClosedDays: 30 },
    ...overrides,
  };
}

describe('summariseUserAgent', () => {
  /**
   * Order in both ladders is the whole implementation. Every Chromium browser
   * also claims "Safari", and an iPad in desktop mode claims "Mac OS X", so a
   * naive chain answers Safari-on-macOS for a Chrome-on-Windows session — and
   * a device row nobody recognises is a device row nobody revokes.
   */
  test('a more specific token wins over the compatibility one it also carries', () => {
    expect(
      summariseUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
      )
    ).toBe('Chrome on Windows');
    expect(
      summariseUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0'
      )
    ).toBe('Edge on Windows');
    expect(
      summariseUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
      )
    ).toBe('Safari on iOS');
  });

  test('an absent or unrecognised agent is said in words, never left blank', () => {
    expect(summariseUserAgent(null)).toBe('Unknown device');
    expect(summariseUserAgent('curl/8.4.0')).toBe('Browser on Unknown OS');
  });
});

describe('dataQualityRows', () => {
  test('a clean account warns about nothing', () => {
    expect(dataQualityRows(report()).some((row) => row.warn)).toBe(false);
  });

  /**
   * The thresholds are why this is a function rather than JSX. A handful of
   * zero-balance rows is normal; a single negative opening balance never is.
   */
  test('zero-balance holdings are only worth flagging past a handful', () => {
    const rowFor = (zeroVisible: number) =>
      dataQualityRows(report({ holdings: { ...report().holdings, zeroVisible } })).find(
        (row) => row.label === 'Zero-balance holdings still shown'
      );
    expect(rowFor(3)?.warn).toBe(false);
    expect(rowFor(9)?.warn).toBe(true);
  });

  test('a single negative opening balance is always worth flagging', () => {
    const rows = dataQualityRows(
      report({ holdings: { ...report().holdings, negativeOpening: 1 } })
    );
    expect(rows.find((row) => row.label.startsWith('Negative'))?.warn).toBe(true);
  });

  test('duplicate tokens are sampled into the hint rather than listed in full', () => {
    const duplicateTokens = Array.from({ length: 8 }, (_, index) => ({
      symbol: `T${index}`,
      count: 2,
    }));
    const row = dataQualityRows(report({ duplicateTokens }))[0];
    expect(row?.value).toBe(8);
    expect(row?.warn).toBe(true);
    expect(row?.hint).toBe('T0×2, T1×2, T2×2, T3×2, T4×2');
  });

  test('the sweep row names the threshold the server actually reported', () => {
    const rows = dataQualityRows(report({ thresholds: { staleClosedDays: 45 } }));
    expect(rows.some((row) => row.label.includes('45-day sweep'))).toBe(true);
  });
});

describe('dataQualityRows — unpriceable positions (SC-146)', () => {
  test('are counted without warning, because there is nothing to fix', () => {
    const rows = dataQualityRows(
      report({
        holdings: {
          visible: 69,
          total: 69,
          zeroVisible: 0,
          zeroVisibleStale: 0,
          unpricedVisible: 0,
          unpriceableVisible: 14,
          negativeOpening: 0,
          missingCoverage: 0,
        },
      })
    );

    const row = rows.find((r) => r.label === 'Shown positions nothing can price');
    expect(row?.value).toBe(14);
    expect(row?.warn).toBe(false);
    // The counter that *does* warn must not double-count them, or the panel
    // says a fully-priced portfolio has fourteen pricing failures.
    expect(rows.find((r) => r.label === 'Shown positions with no recent price')?.value).toBe(0);
  });
});
