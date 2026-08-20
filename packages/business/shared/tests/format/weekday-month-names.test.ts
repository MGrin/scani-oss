import { describe, expect, test } from 'bun:test';
import {
  APP_LOCALE,
  formatDayMonth,
  monthName,
  monthNameInDate,
  weekdayName,
} from '../../src/format/date';

/**
 * SC-300. `v3/lib/holdings.ts` interpolated a hand-rolled
 * `DAY_NAMES = ['Sunday', 'Monday', …]` into user-facing recurrence copy.
 *
 * The defect is NOT that the table was English — the app is English today and
 * `APP_LOCALE` is pinned to `en-GB` on purpose (SC-260). It is that a table
 * can never follow the locale when that pin lifts, and that the obvious
 * alternative — seven day names and twelve month names in the catalogue — is
 * 56 entries in every language for something every runtime already knows.
 *
 * **So these tests deliberately do not assert `'Monday'`.** Under `en-GB`
 * "comes from the locale" and "reads Monday" are the same observation; they
 * stop being the same the moment the pin lifts, and a test that pinned the
 * literal would keep passing over a table someone reintroduced.
 */

describe('the name comes from the locale, not from a table', () => {
  test('every weekday matches what Intl produces for that locale', () => {
    for (let d = 0; d <= 6; d++) {
      const viaIntl = new Date(Date.UTC(2024, 0, 7 + d)).toLocaleDateString(APP_LOCALE, {
        weekday: 'long',
        timeZone: 'UTC',
      });
      expect(weekdayName(d)).toBe(viaIntl);
    }
  });

  test('every month matches what Intl produces for that locale', () => {
    for (let m = 1; m <= 12; m++) {
      const viaIntl = new Date(Date.UTC(2024, m - 1, 15)).toLocaleDateString(APP_LOCALE, {
        month: 'long',
        timeZone: 'UTC',
      });
      expect(monthName(m)).toBe(viaIntl);
    }
  });

  test('THE ONE THAT FAILS ON A TABLE: another locale gives another language', () => {
    // A hardcoded array returns 'Monday' whatever locale it is handed. This is
    // the assertion that separates "we read the platform" from "we shipped a
    // list", and it is the reason the fix is not `v3.holdings.day.monday`.
    expect(weekdayName(1, 'fr-FR')).toBe('lundi');
    expect(weekdayName(1, 'ru-RU')).toBe('понедельник');
    expect(monthName(3, 'fr-FR')).toBe('mars');
    expect(monthName(3, 'de-DE')).toBe('März');
  });

  test('and it is not merely different — en-GB and fr-FR disagree on every day', () => {
    for (let d = 0; d <= 6; d++) {
      expect(weekdayName(d, 'fr-FR')).not.toBe(weekdayName(d, 'en-GB'));
    }
  });
});

describe('the indexing matches the columns it renders', () => {
  test('0 is Sunday and 6 is Saturday, as payment_schedules.day_of_week stores it', () => {
    // Off by one here shows a user the wrong day, silently and plausibly.
    expect(weekdayName(0, 'en-GB')).toBe('Sunday');
    expect(weekdayName(6, 'en-GB')).toBe('Saturday');
  });

  test('months are ONE-based, unlike Date itself', () => {
    // The array this replaced carried an empty string at index 0 precisely
    // because `payment_schedules.month` is 1-based and `Date`'s is not.
    expect(monthName(1, 'en-GB')).toBe('January');
    expect(monthName(12, 'en-GB')).toBe('December');
  });

  test('a runtime west of UTC does not shift the name by a day', () => {
    // `timeZone: 'UTC'` is load-bearing: without it, midnight UTC renders as
    // the previous evening and every name comes out one day early. Asserted
    // through an explicitly negative-offset locale-timezone pair.
    const shifted = new Date(Date.UTC(2024, 0, 7)).toLocaleDateString('en-US', {
      weekday: 'long',
      timeZone: 'America/Los_Angeles',
    });
    expect(shifted).toBe('Saturday');
    expect(weekdayName(0, 'en-US')).toBe('Sunday');
  });
});

describe('input it cannot render', () => {
  test('out-of-range answers the way the rest of this file does', () => {
    for (const bad of [-1, 7, 1.5, Number.NaN]) expect(weekdayName(bad)).toBe('—');
    for (const bad of [0, 13, 2.5, Number.NaN]) expect(monthName(bad)).toBe('—');
  });
});

/**
 * A month inside a date is a different word from a month on its own (SC-413).
 *
 * The APY sheet rendered «Ежегодно, 15 февраль» — a stand-alone month dropped
 * into a Russian date, where the language wants the genitive «февраля». Four
 * of the eight languages `LANGUAGE_FORMATS` already has rows for inflect here;
 * English, French and German do not, which is why an English product ships
 * this defect and never sees it.
 *
 * Both helpers are asserted against literal words rather than against `Intl`
 * re-run with the same options — unlike the tests above, the point here is
 * exactly WHICH form comes back, and an assertion phrased as "whatever
 * `{ day, month }` produces" would pass over `{ month }` being asked for
 * again.
 */
describe('the month as it appears inside a date', () => {
  test('an inflecting language gets the inflected form', () => {
    expect(monthNameInDate(2, 'ru-RU')).toBe('февраля');
    expect(monthNameInDate(5, 'ru-RU')).toBe('мая');
    expect(monthNameInDate(2, 'pl-PL')).toBe('lutego');
    expect(monthNameInDate(2, 'cs-CZ')).toBe('února');
  });

  test('a language without the distinction is unchanged', () => {
    expect(monthNameInDate(2, 'en-GB')).toBe('February');
    expect(monthNameInDate(2, 'en-US')).toBe('February');
    expect(monthNameInDate(2, 'de-DE')).toBe('Februar');
    expect(monthNameInDate(2, 'fr-FR')).toBe('février');
  });

  test('the stand-alone form is still available and still differs', () => {
    // Both are needed: a picker lists «февраль» and a date reads «15 февраля».
    expect(monthName(2, 'ru-RU')).toBe('февраль');
    expect(monthNameInDate(2, 'ru-RU')).not.toBe(monthName(2, 'ru-RU'));
  });

  test('an impossible month is answered the way the rest of this file answers one', () => {
    for (const bad of [0, 13, 2.5, Number.NaN]) expect(monthNameInDate(bad)).toBe('—');
  });
});

describe('a day and a month together', () => {
  test('the ORDER is the locale’s, not the template’s', () => {
    // The reason this is one call rather than two interpolations: a template
    // that writes `{{day}} {{month}}` has already chosen day-first, and half
    // the English-speaking world reads the other one.
    expect(formatDayMonth(5, 4, 'en-GB')).toBe('5 April');
    expect(formatDayMonth(5, 4, 'en-US')).toBe('April 5');
  });

  test('the WORD is the locale’s too', () => {
    expect(formatDayMonth(15, 2, 'ru-RU')).toBe('15 февраля');
    expect(formatDayMonth(15, 2, 'pl-PL')).toBe('15 lutego');
    expect(formatDayMonth(15, 2, 'cs-CZ')).toBe('15. února');
    expect(formatDayMonth(15, 2, 'de-DE')).toBe('15. Februar');
  });

  test('29 February is a date', () => {
    // The reference year is a leap year precisely for this. The caller only
    // reaches here when the day exists in the year the reader is in, so the
    // one day that exists in some years must not be refused here.
    expect(formatDayMonth(29, 2, 'en-GB')).toBe('29 February');
  });

  test('a day the month does not have is refused, not rolled forward', () => {
    // `Date.UTC(2024, 1, 31)` is 2 March. Rendering that would be a sentence
    // about a different month than the one configured.
    expect(formatDayMonth(31, 2, 'en-GB')).toBe('—');
    expect(formatDayMonth(31, 4, 'en-GB')).toBe('—');
    expect(formatDayMonth(0, 4, 'en-GB')).toBe('—');
    expect(formatDayMonth(1.5, 4, 'en-GB')).toBe('—');
    expect(formatDayMonth(15, 13, 'en-GB')).toBe('—');
  });
});
