import { describe, expect, test } from 'bun:test';
import { formatDate, formatDateTime, formatIsoDate, formatRelative } from '../../src/format/date';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatRelative', () => {
  test('returns "just now" for recent (<45s)', () => {
    expect(formatRelative(new Date(Date.now() - 1000))).toBe('just now');
    expect(formatRelative(new Date(Date.now() - 30 * 1000))).toBe('just now');
  });

  test('uses Xm ago for under an hour', () => {
    expect(formatRelative(new Date(Date.now() - 5 * MIN))).toBe('5m ago');
  });

  test('uses Xh ago for under a day', () => {
    expect(formatRelative(new Date(Date.now() - 3 * HOUR))).toBe('3h ago');
  });

  test('uses Xd ago for under 30 days', () => {
    expect(formatRelative(new Date(Date.now() - 5 * DAY))).toBe('5d ago');
  });

  test('falls back to a locale date for >30 days', () => {
    const old = new Date('2020-01-15T00:00:00Z');
    const out = formatRelative(old);
    expect(out).not.toContain('ago');
    expect(out.length).toBeGreaterThan(0);
  });

  /**
   * SC-175 — the fallback is the ambiguous one, and it is invisible until
   * history ages past 30 days.
   *
   * `toLocaleDateString()` with no options is numeric: `7/5/2026` is 5 July to
   * half the world and 7 May to the other half, and this list's whole job is
   * judging whether two rows are the same movement of money. A month NAME
   * cannot be read backwards.
   */
  test('the >30d fallback names the month rather than numbering it', () => {
    const old = new Date('2020-01-15T00:00:00Z');
    // English only — `dateStyle: 'medium'` is not a month name everywhere
    // (de-DE renders `15.01.2020`), and the UI ships in English, so these are
    // the locales in which the ambiguity SC-175 is about actually bites: `7/5`
    // is 5 July in en-GB and 7 May in en-US, and both readers see this string.
    for (const locale of ['en-US', 'en-GB', 'en-AU', 'en-CA']) {
      expect(formatRelative(old, locale)).toMatch(/\p{L}{3}/u);
    }
  });

  test('the >30d fallback IS formatDate, so a row and the sheet it opens agree', () => {
    const old = new Date('2020-01-15T00:00:00Z');
    for (const locale of [undefined, 'en-US', 'en-GB']) {
      expect(formatRelative(old, locale)).toBe(formatDate(old, locale));
    }
  });

  test('returns "—" for null/undefined/invalid input', () => {
    expect(formatRelative(null)).toBe('—');
    expect(formatRelative(undefined)).toBe('—');
    expect(formatRelative('not-a-date')).toBe('—');
  });

  test('accepts string ISO input', () => {
    expect(formatRelative(new Date(Date.now() - 5 * MIN).toISOString())).toBe('5m ago');
  });
});

/**
 * SC-175 — these helpers hard-defaulted to `en-US` and every call site in the
 * app omitted the argument, so a European reader was shown month-first dates
 * while anything reaching for a bare `toLocaleDateString()` on the same screen
 * printed day-first. Nothing asserted the default, so nothing caught it.
 */
describe('locale handling', () => {
  const when = '2026-07-16T01:06:00Z';

  test("no locale argument means APP_LOCALE, NOT the runtime's", () => {
    // The first SC-175 fix made these follow the runtime locale. That shipped
    // `14 \u0430\u0432\u0433. 2026 \u0433., 16:43` to a reader whose device was Russian, inside an
    // interface with no i18n and every other string in English.
    //
    // Asserted against the literal, deliberately. The previous version of this
    // test compared the helper to `toLocaleDateString(undefined, ...)` — which
    // is the same call the helper makes, so it passed no matter what the
    // default was, and only *looked* like it pinned anything because the
    // machine running it happened to be en-US.
    expect(formatDate(when)).toBe('16 Jul 2026');

    // `formatDateTime` is pinned by naming the locale, not by its rendering.
    // The connector between date and time in `en-GB` medium/short is
    // ICU-version dependent — `at` on some builds, `,` on others — so a
    // literal here pins whichever ICU the machine happens to ship and fails
    // on a runner with a different one. Naming `en-GB` explicitly is the
    // opposite of the `undefined` the previous version passed: if the default
    // drifts back to `en-US`, or to the runtime's, both lines below fail.
    expect(formatDateTime(when)).toBe(formatDateTime(when, 'en-GB'));
    expect(formatDateTime(when)).not.toBe(formatDateTime(when, 'en-US'));
  });

  test('is stable when the runtime locale is not English', () => {
    // The production report was from a Russian device. Nothing about the
    // reader's OS may reach the string.
    const ru = new Date(when).toLocaleDateString('ru-RU', { dateStyle: 'medium' });
    expect(ru).not.toBe(formatDate(when));
    expect(formatDate(when)).toBe('16 Jul 2026');
  });

  test('an explicit locale is still honoured, and the orders really do differ', () => {
    expect(formatDate(when, 'en-GB')).not.toBe(formatDate(when, 'en-US'));
  });

  test('formatDateTime opens with exactly what formatDate prints', () => {
    // The invariant behind the fix: a peek that shows the moment to the minute
    // and a row that shows only the day must not disagree about the day.
    for (const locale of ['en-US', 'en-GB', 'de-DE']) {
      expect(formatDateTime(when, locale).startsWith(formatDate(when, locale))).toBe(true);
    }
  });
});

describe('formatIsoDate', () => {
  test('renders YYYY-MM-DD for any valid input', () => {
    expect(formatIsoDate('2026-04-28T15:30:00Z')).toBe('2026-04-28');
    expect(formatIsoDate(new Date('2026-04-28T15:30:00Z'))).toBe('2026-04-28');
  });

  test('returns "—" for invalid input', () => {
    expect(formatIsoDate(null)).toBe('—');
    expect(formatIsoDate('garbage')).toBe('—');
  });
});

describe('formatDateTime / formatDate', () => {
  test('formatDate renders a medium-style date string', () => {
    const out = formatDate('2026-04-28T15:30:00Z');
    expect(out).toMatch(/2026/);
    expect(out).not.toMatch(/15:30/);
  });

  test('formatDateTime includes the time portion', () => {
    const out = formatDateTime('2026-04-28T15:30:00Z');
    expect(out).toMatch(/2026/);
  });

  test('both return "—" for invalid input', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDateTime(null)).toBe('—');
  });
});
