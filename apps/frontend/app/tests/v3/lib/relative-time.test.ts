import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { formatRelative as sharedFormatRelative } from '@scani/shared';
import i18n from 'i18next';
import { formatRelative } from '../../../src/v3/lib/relative-time';

const t = i18n.t.bind(i18n);

const ago = (ms: number) => new Date(Date.now() - ms);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The English these produce is the English `@scani/shared`'s `formatRelative`
 * produces — the whole claim of the copy (SC-369), and checkable only because
 * the strings are asserted here rather than compared against the module they
 * came from.
 *
 * `i18n.t` rather than a stub, for the reason `job-labels.test.ts` gives: a
 * stub proves the function reached for a key, the real instance proves the key
 * is in `en.json`. A missing key resolves to itself, so a typo would put
 * `v3.common.relative.minutes` on every job row and nothing would throw.
 */
describe('formatRelative', () => {
  test.each([
    ['0s', 0, 'just now'],
    ['30s', 30 * SECOND, 'just now'],
    ['2m', 2 * MINUTE, '2m ago'],
    ['25m', 25 * MINUTE, '25m ago'],
    ['59m', 59 * MINUTE, '59m ago'],
    ['3h', 3 * HOUR, '3h ago'],
    ['23h', 23 * HOUR, '23h ago'],
    ['2d', 2 * DAY, '2d ago'],
    ['29d', 29 * DAY, '29d ago'],
  ])('%s ago reads as %p', (_label, offset, expected) => {
    expect(formatRelative(t, ago(offset))).toBe(expected);
  });

  // The one boundary worth pinning by hand: 45s is where "just now" stops, and
  // rounding sends it to 1m rather than to 45s.
  test('the just-now window ends at 45 seconds', () => {
    expect(formatRelative(t, ago(44 * SECOND))).toBe('just now');
    expect(formatRelative(t, ago(46 * SECOND))).toBe('1m ago');
  });

  /**
   * Past 30 days it hands off to the shared `formatDate`, which is the whole
   * reason this copy does not own an absolute format of its own: the fallback
   * is invisible until history ages past a month, so the day it first appears
   * is the day a list that read "3d ago" starts printing dates, and they have
   * to be the dates the sheet it opens prints (SC-175).
   */
  test('past 30 days it falls back to the shared absolute date, in en-GB', () => {
    expect(formatRelative(t, new Date('2026-07-16T01:06:00Z'))).toBe('16 Jul 2026');
  });

  test('an unreadable input is the same em-dash the shared version returns', () => {
    expect(formatRelative(t, null)).toBe('—');
    expect(formatRelative(t, undefined)).toBe('—');
    expect(formatRelative(t, 'not a date')).toBe('—');
  });

  /**
   * SC-1047. A future timestamp read `-5m ago` here, knowingly, until the
   * shared copy was fixed (SC-1038) and the two stopped agreeing. English has
   * one plural form for `-5` and `5`, so no key could expose it.
   */
  test.each([
    ['5m', 5 * MINUTE, 'in 5m'],
    ['59m', 59 * MINUTE, 'in 59m'],
    ['3h', 3 * HOUR, 'in 3h'],
    ['2d', 2 * DAY, 'in 2d'],
  ])('%s ahead reads as %p, never a signed count', (_label, offset, expected) => {
    expect(formatRelative(t, new Date(Date.now() + offset))).toBe(expected);
  });

  test('the same distance rounds to the same magnitude either side of now', () => {
    // `Math.round(-1.5)` is -1 and `Math.round(1.5)` is 2: rounding the signed
    // difference made 90s ahead read a unit smaller than 90s behind.
    expect(formatRelative(t, ago(90 * SECOND))).toBe('2m ago');
    expect(formatRelative(t, new Date(Date.now() + 90 * SECOND))).toBe('in 2m');
    expect(formatRelative(t, new Date(Date.now() + 30 * SECOND))).toBe('just now');
  });

  /**
   * The invariant this file's docstring states: v2 and v3 render the same
   * rows, so the keyed copy must print what the shared one prints, in both
   * directions. Offsets sit mid-unit so the few milliseconds between the two
   * calls cannot straddle a rounding edge.
   */
  test('it agrees with the shared formatRelative in English, past and future', () => {
    const offsets = [10 * SECOND, 100 * SECOND, 25.3 * MINUTE, 5.2 * HOUR, 3.1 * DAY, 45 * DAY];
    for (const offset of offsets) {
      for (const sign of [-1, 1]) {
        const when = new Date(Date.now() + sign * offset);
        expect(formatRelative(t, when)).toBe(sharedFormatRelative(when));
      }
    }
  });

  /**
   * The second defect SC-369 names: the shared four are plain English
   * concatenation, so they follow nothing, while every other renderer in
   * `shared/format/date.ts` goes through `Intl` with `APP_LOCALE`. Here the
   * words follow the interface language and — because the keys interpolate
   * `{{count, number}}` rather than a bare `{{count}}` — so does the numeral.
   */
  test('the words and the numeral both follow the interface language', async () => {
    // Two traps here, both of which make this test pass while asserting
    // nothing, so both are pinned rather than remembered:
    //
    //   - `Intl.PluralRules('ar').select(25)` is `many`, not `other`. A form
    //     i18next cannot find falls back to English, so a bundle carrying only
    //     `_one`/`_other` asserts against `25m ago`. Every form, same text.
    //   - `ar-EG`, not `ar`. Bare `ar` resolves to the `latn` numbering system
    //     (checked: `new Intl.NumberFormat('ar').resolvedOptions()`), so the
    //     numeral comes out `25` and the half of this claim about DIGITS
    //     silently stops being tested.
    const relative = Object.fromEntries(
      ['zero', 'one', 'two', 'few', 'many', 'other'].map((form) => [
        `minutes_${form}`,
        'منذ {{count, number}} د',
      ])
    );
    i18n.addResourceBundle('ar-EG', 'translation', { v3: { common: { relative } } }, true, true);
    await i18n.changeLanguage('ar-EG');
    try {
      // Arabic-Indic digits, from `{{count, number}}` rather than a bare
      // `{{count}}`: the numeral is half of following a locale, and the shared
      // version could follow neither half.
      expect(formatRelative(t, ago(25 * MINUTE))).toBe('منذ ٢٥ د');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
