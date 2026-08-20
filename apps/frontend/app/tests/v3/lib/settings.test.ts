import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import {
  type DataQualityReport,
  dataQualityRows,
  summariseUserAgent,
} from '../../../src/v3/lib/settings';

// The real resolver against the real `en.json`, so the assertions below —
// which are UNCHANGED — prove the extraction moved no English (SC-202).
const t = i18n.t.bind(i18n);

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
        t,
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
      )
    ).toBe('Chrome on Windows');
    expect(
      summariseUserAgent(
        t,
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0'
      )
    ).toBe('Edge on Windows');
    expect(
      summariseUserAgent(
        t,
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
      )
    ).toBe('Safari on iOS');
  });

  test('an absent or unrecognised agent is said in words, never left blank', () => {
    expect(summariseUserAgent(t, null)).toBe('Unknown device');
    expect(summariseUserAgent(t, 'curl/8.4.0')).toBe('Browser on Unknown OS');
  });
});

describe('dataQualityRows', () => {
  test('a clean account warns about nothing', () => {
    expect(dataQualityRows(t, report()).some((row) => row.warn)).toBe(false);
  });

  /**
   * SC-217. The two silence rows say different things about whose fault the
   * silence is, and only one of them is actionable.
   *
   *   "nothing can price"  — a claim about the ASSET. Airdropped or delisted,
   *                          no market quotes it. Never warns, by design
   *                          (SC-146): warning forever trains the reader to
   *                          ignore the panel.
   *   "missing a price
   *    source we can use"  — a claim about OUR CONFIGURATION. The token
   *                          carries no provider id, so the pricing router
   *                          has nothing to route on and the hourly job
   *                          returns nothing every time it asks.
   *
   * Both TRUMP rows sat in the second state for three months and read as
   * ordinary unpriced positions. Filing them under the first sentence would
   * have asserted "no market" about a token with a live market.
   */
  test('an unroutable token warns, where a token with no market does not', () => {
    const rows = dataQualityRows(
      t,
      report({
        unroutableTokens: [{ symbol: 'TRUMP', segment: 'evm:8453:0x62f8' }],
        holdings: { ...report().holdings, unpricedVisible: 1, unpriceableVisible: 3 },
      })
    );

    const ours = rows.find((r) => r.label === 'Shown positions missing a price source we can use');
    const theirs = rows.find((r) => r.label === 'Shown positions nothing can price');

    expect(ours?.value).toBe(1);
    expect(ours?.warn).toBe(true);
    expect(ours?.hint).toContain('TRUMP');
    // The distinction is the assertion: three tokens with no market sit
    // beside one we simply cannot route, and only the second is a defect.
    expect(theirs?.value).toBe(3);
    expect(theirs?.warn).toBe(false);
  });

  test('it names the tokens, because a bare count is not actionable', () => {
    const rows = dataQualityRows(
      t,
      report({
        unroutableTokens: [
          { symbol: 'TRUMP', segment: null },
          { symbol: 'FOO', segment: null },
        ],
      })
    );
    const ours = rows.find((r) => r.label === 'Shown positions missing a price source we can use');
    expect(ours?.hint).toContain('TRUMP');
    expect(ours?.hint).toContain('FOO');
    // And says whose fault it is, since that is the whole point of splitting
    // it out from the row above.
    expect(ours?.hint).toContain('our configuration');
  });

  /**
   * The field is optional on the type so a counter added server-side does not
   * have to be rendered before the screen type-checks. An older API therefore
   * reports nothing here rather than crashing or warning about `undefined`.
   */
  test('an API that does not send the counter yet warns about nothing', () => {
    const rows = dataQualityRows(t, report({ unroutableTokens: undefined }));
    const ours = rows.find((r) => r.label === 'Shown positions missing a price source we can use');
    expect(ours?.value).toBe(0);
    expect(ours?.warn).toBe(false);
  });

  /**
   * The thresholds are why this is a function rather than JSX. A handful of
   * zero-balance rows is normal; a single negative opening balance never is.
   */
  test('zero-balance holdings are only worth flagging past a handful', () => {
    const rowFor = (zeroVisible: number) =>
      dataQualityRows(t, report({ holdings: { ...report().holdings, zeroVisible } })).find(
        (row) => row.label === 'Zero-balance holdings still shown'
      );
    expect(rowFor(3)?.warn).toBe(false);
    expect(rowFor(9)?.warn).toBe(true);
  });

  test('a single negative opening balance is always worth flagging', () => {
    const rows = dataQualityRows(
      t,
      report({ holdings: { ...report().holdings, negativeOpening: 1 } })
    );
    expect(rows.find((row) => row.label.startsWith('Negative'))?.warn).toBe(true);
  });

  /**
   * SC-270. This used to sample five, so a row reading `8` sat above five
   * chips with nothing saying three were missing — a count that disagrees
   * with its own list. The number and the list now agree by construction,
   * which is cheaper than any "+N more" and needs no new copy while
   * SC-202/SC-266 are extracting these strings.
   */
  test('every duplicate symbol is listed, so the count matches what is shown', () => {
    const duplicateTokens = Array.from({ length: 8 }, (_, index) => ({
      symbol: `T${index}`,
      count: 2,
    }));

    const row = dataQualityRows(t, report({ duplicateTokens }))[0];

    expect(row?.value).toBe(8);
    expect(row?.warn).toBe(true);
    expect(row?.hint?.split(', ')).toHaveLength(8);
    expect(row?.hint).toBe('T0×2, T1×2, T2×2, T3×2, T4×2, T5×2, T6×2, T7×2');
  });

  test('the chip count never disagrees with the value, at any length', () => {
    // The invariant rather than one example — a future cap that forgets to
    // say what it dropped fails here.
    for (const length of [1, 5, 6, 20]) {
      const duplicateTokens = Array.from({ length }, (_, i) => ({ symbol: `T${i}`, count: 2 }));
      const row = dataQualityRows(t, report({ duplicateTokens }))[0];
      expect(row?.hint?.split(', ')).toHaveLength(row?.value as number);
    }
  });

  /**
   * The hazard the panel exists to point at (SC-197). `UЅDС` uses Cyrillic Ѕ
   * and С, so it is a different string from `USDC` and forms its own group —
   * it is never *inside* the real symbol's count. Listed plainly, the two
   * chips draw identically and the reader has no way to tell which is which.
   */
  test('a homoglyph says what it imitates, because its chip is otherwise identical', () => {
    const row = dataQualityRows(
      t,
      report({
        duplicateTokens: [
          { symbol: 'UЅDС', count: 2, lookalikeOf: 'USDC' },
          { symbol: 'USDC', count: 3 },
        ],
      })
    )[0];

    expect(row?.hint).toBe('UЅDС×2 (displays as USDC), USDC×3');
  });

  /**
   * SC-271. The duplicate row is built on `HAVING COUNT(*) > 1`, so it can
   * only ever reach a homoglyph that itself exists twice — and an attacker
   * airdropping an impersonating token sends ONE. SC-270 could only be
   * demonstrated by seeding the homoglyph twice, which is the artificial case;
   * this row is the real one.
   */
  test('a single held homoglyph is counted, which the duplicate row cannot do', () => {
    const rows = dataQualityRows(
      t,
      report({
        // Not a duplicate by any reading: one token, one row.
        duplicateTokens: [],
        lookalikeTokens: [{ symbol: 'UЅDС', lookalikeOf: 'USDC' }],
      })
    );
    const row = rows.find((r) => r.label.includes('imitates another'));

    expect(row?.value).toBe(1);
    expect(row?.warn).toBe(true);
    expect(row?.hint).toBe('UЅDС (displays as USDC)');
  });

  test('it says what each one imitates, and the count matches the list', () => {
    const rows = dataQualityRows(
      t,
      report({
        lookalikeTokens: [
          { symbol: 'UЅDС', lookalikeOf: 'USDC' },
          { symbol: 'ЕTH', lookalikeOf: 'ETH' },
        ],
      })
    );
    const row = rows.find((r) => r.label.includes('imitates another'));

    expect(row?.value).toBe(2);
    expect(row?.hint?.split(', ')).toHaveLength(2);
    expect(row?.hint).toBe('UЅDС (displays as USDC), ЕTH (displays as ETH)');
  });

  test('it is silent, not zero-with-a-warning, when there are none', () => {
    const row = dataQualityRows(t, report()).find((r) => r.label.includes('imitates another'));

    expect(row?.value).toBe(0);
    expect(row?.warn).toBe(false);
    expect(row?.hint).toBeUndefined();
  });

  test('an older API that reports no such field is not an error', () => {
    // Same contract as `unroutableTokens`: a counter added server-side must
    // not have to ship before this screen type-checks.
    const row = dataQualityRows(t, report({ lookalikeTokens: undefined })).find((r) =>
      r.label.includes('imitates another')
    );

    expect(row?.value).toBe(0);
    expect(row?.warn).toBe(false);
  });

  test('the duplicate row keeps its own meaning — the count is not widened', () => {
    // Folding lookalikes into "Duplicate token rows" would change what that
    // number means, and this panel has just been made honest about counts.
    const rows = dataQualityRows(
      t,
      report({ lookalikeTokens: [{ symbol: 'UЅDС', lookalikeOf: 'USDC' }] })
    );

    expect(rows[0]?.label).toBe('Shown positions sharing a symbol with another token row');
    expect(rows[0]?.value).toBe(0);
    expect(rows[0]?.warn).toBe(false);
  });

  test('an ordinary symbol carries no such note', () => {
    const row = dataQualityRows(
      t,
      report({ duplicateTokens: [{ symbol: 'DOG', count: 3, lookalikeOf: null }] })
    )[0];

    expect(row?.hint).toBe('DOG×3');
  });

  test('the sweep row names the threshold the server actually reported', () => {
    const rows = dataQualityRows(t, report({ thresholds: { staleClosedDays: 45 } }));
    expect(rows.some((row) => row.label.includes('45-day sweep'))).toBe(true);
  });
});

describe('dataQualityRows — unpriceable positions (SC-146)', () => {
  test('are counted without warning, because there is nothing to fix', () => {
    const rows = dataQualityRows(
      t,
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

/**
 * The case the lookalike row exists for, and the one the interpolation could
 * quietly break (SC-271 / SC-202).
 *
 * `UЅDС` (Cyrillic Ѕ U+0405, С U+0421) and `USDC` are different strings that
 * draw identically. The chip has to show BOTH — that is the whole warning —
 * so nothing may collapse, dedupe or de-duplicate the two placeholders just
 * because their glyphs match.
 */
describe('a lookalike chip names both sides even when they look the same', () => {
  const CYRILLIC = 'UЅDС';

  test('the two placeholders both render, identical glyphs and all', () => {
    const row = dataQualityRows(
      t,
      report({ lookalikeTokens: [{ symbol: CYRILLIC, lookalikeOf: 'USDC' }] })
    ).find((r) => r.label.includes('imitates another'));

    expect(row?.hint).toBe(`${CYRILLIC} (displays as USDC)`);
    // Different code points, same picture — which is why the sentence has to
    // carry both rather than one of them.
    expect(CYRILLIC).not.toBe('USDC');
    expect(row?.hint?.includes('USDC')).toBe(true);
  });

  test('the duplicate chip keeps its count as well as both symbols', () => {
    const row = dataQualityRows(
      t,
      report({ duplicateTokens: [{ symbol: CYRILLIC, count: 2, lookalikeOf: 'USDC' }] })
    )[0];
    expect(row?.hint).toBe(`${CYRILLIC}×2 (displays as USDC)`);
  });
});
