import { describe, expect, test } from 'bun:test';
import { EMAIL_STRINGS } from '../../src/i18n';
import { renderMagicLinkEmail } from '../../src/templates/magic-link';
import { renderVerificationEmail } from '../../src/templates/verification';
import { SCANI_BRAND } from '../../src/types';

/**
 * The letter says which way it reads (SC-201).
 *
 * A mail client has no stylesheet of ours and no script, so `<html dir>` is the
 * whole of right-to-left in an email: without it an Arabic letter renders its
 * paragraphs flush left with the punctuation at the wrong end of each line.
 *
 * **Both arms are required and neither alone is a check.** Asserting only that
 * Arabic carries `dir="rtl"` passes over a layout that hardcodes the attribute,
 * which would mirror the eight left-to-right letters as well; asserting only
 * that English carries `ltr` passes over a layout that ignores the bundle. The
 * pair is what says the value comes from the language.
 */
describe('the letter carries its own direction', () => {
  test('Arabic renders right-to-left and English left-to-right', () => {
    const ar = renderMagicLinkEmail({ brand: SCANI_BRAND, url: 'https://x', language: 'ar' });
    const en = renderMagicLinkEmail({ brand: SCANI_BRAND, url: 'https://x', language: 'en' });
    expect(ar.html).toContain('<html lang="ar" dir="rtl">');
    expect(en.html).toContain('<html lang="en" dir="ltr">');
  });

  test('a second template proves it is the layout and not one caller', () => {
    const ar = renderVerificationEmail({ brand: SCANI_BRAND, url: 'https://x', language: 'ar' });
    expect(ar.html).toContain('<html lang="ar" dir="rtl">');
  });

  /**
   * Named rather than counted: a bundle that starts claiming `rtl` fails here
   * by name, where `toHaveLength(1)` would pass over the wrong one. The
   * left-to-right arm is the denominator — without it a run over an empty
   * `EMAIL_STRINGS` would satisfy the first assertion.
   */
  test('Arabic is the only right-to-left letter, and every other one says ltr', () => {
    const byDir = (want: string) =>
      Object.entries(EMAIL_STRINGS)
        .filter(([, strings]) => strings.dir === want)
        .map(([code]) => code)
        .sort();
    expect(byDir('rtl')).toEqual(['ar']);
    expect(byDir('ltr')).toEqual(['en', 'es', 'fr', 'id', 'ja', 'pt', 'ru', 'zh']);
  });
});
