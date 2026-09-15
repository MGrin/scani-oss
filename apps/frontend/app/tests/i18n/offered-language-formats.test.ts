/**
 * A language may not be OFFERED until its figures are readable (SC-201).
 *
 * **The defect this exists for, and it is an ordering one.** SC-201 shipped as
 * four slices: slice 1 pinned Western digits and the Gregorian calendar onto
 * every Arabic tag, and slice 4 emptied `HELD_LANGUAGES` so a reader could
 * choose Arabic at all. Those are separate branches, and nothing but the order
 * they merge in stopped slice 4 landing alone — which would offer Arabic with
 * `ar-EG`'s CLDR defaults. Measured on Bun's ICU at that tree, 2026-09-15:
 *
 *     new Intl.NumberFormat('ar-EG').format(1234.5)  ->  '١٬٢٣٤٫٥'
 *
 * Correct Arabic, and unreadable against an exchange or bank statement printed
 * in 0-9, which is what these figures are read beside. No type-check sees it,
 * no other test sees it, and the screen looks deliberate.
 *
 * **So the coupling is asserted rather than sequenced.** A tree that offers a
 * language is a tree whose formats for that language are pinned; a tree that
 * lifts the hold without the pin cannot be gated green. That is a property of
 * the repository rather than of anyone's merge queue, which was the whole
 * objection — a queue is a list somebody maintains, and this is not.
 *
 * **Derived from what is offered, never a list.** Eight languages pass here
 * today and a ninth appears the moment its locale file does, with nothing to
 * remember. The eight are also the control: a test that could only ever fail
 * would look identical to this one on the day it is right.
 */
import { describe, expect, test } from 'bun:test';
import { AUTO_REGION, LANGUAGE_FORMATS, resolveFormatLocale } from '@scani/shared';
import { isOfferedLanguage } from '../../src/i18n/offered-languages';

const offered = Object.keys(LANGUAGE_FORMATS).filter((code) => isOfferedLanguage(code));

describe('every language a reader can choose formats in digits they can read', () => {
  test('the set is not empty, so nothing below passes by having nothing to check', () => {
    // The control for the two `test.each` blocks: `each` over an empty array
    // registers no tests and bun reports that as a clean run.
    expect(offered.length).toBeGreaterThanOrEqual(8);
    expect(offered).toContain('en');
  });

  test.each(offered)('%s resolves to Western digits', (code) => {
    const { numberLocale } = resolveFormatLocale(code, AUTO_REGION);
    expect(new Intl.NumberFormat(numberLocale).resolvedOptions().numberingSystem).toBe('latn');
  });

  /**
   * **Carried rather than exercised, and saying so is the point.** Every
   * offered language resolves to `gregory` today, Arabic included, because
   * `LANGUAGE_FORMATS.ar` defaults to `EG` and Egypt's CLDR calendar is
   * Gregorian. It is `ar-SA` that is not — and a reader cannot reach `ar-SA`,
   * because `normalizeRegion` only admits a region the app offers.
   *
   * It is here because the ruling names the calendar beside the digits, and
   * because the thing keeping it true is a DEFAULT REGION in a table, one
   * edit away from `SA`. An assertion that passes for a reason nobody wrote
   * down is the one that disappears when that reason does.
   */
  test.each(offered)('%s resolves to the Gregorian calendar', (code) => {
    const { dateLocale } = resolveFormatLocale(code, AUTO_REGION);
    expect(new Intl.DateTimeFormat(dateLocale).resolvedOptions().calendar).toBe('gregory');
  });
});
