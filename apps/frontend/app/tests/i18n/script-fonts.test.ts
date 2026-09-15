import { describe, expect, test } from 'bun:test';
import { LANGUAGE_FORMATS } from '@scani/shared';
import { facesForLanguage, loadFontsForLanguage } from '../../src/i18n/script-fonts';

/**
 * Arabic pays for its face and nobody else does (SC-201).
 *
 * The whole value of this module is a NEGATIVE: the eight other languages
 * download exactly what they downloaded before. That is the assertion most
 * likely to rot — a face added to the wrong branch costs every reader 131 KB
 * and nothing goes red — so the other languages are enumerated from the locale
 * table rather than sampled.
 */
describe('facesForLanguage', () => {
  test('Arabic asks for three weights, and they are the three v3 uses', () => {
    // 400/500/600 — `font-normal`, `font-medium`, `font-semibold`. Pinned by
    // NAME so dropping one to save bytes is a visible diff rather than a
    // silently synthesised weight on a script whose letters join.
    expect(facesForLanguage('ar')).toEqual(['arabic-400', 'arabic-500', 'arabic-600']);
  });

  test('every other language we ship asks for nothing', () => {
    const asking = Object.keys(LANGUAGE_FORMATS).filter(
      (code) => code !== 'ar' && facesForLanguage(code).length > 0
    );
    expect(asking).toEqual([]);
  });

  test('the table it checked was not empty — the control for the case above', () => {
    // Without this, a locale table that resolved to nothing would satisfy the
    // assertion above over a module that asks for a face on every language.
    expect(Object.keys(LANGUAGE_FORMATS).length).toBeGreaterThan(5);
    expect(Object.keys(LANGUAGE_FORMATS)).toContain('ar');
  });

  test('a region, a case, an underscore — all still Arabic', () => {
    // The language can arrive from a header written by a client we do not
    // control, and a reader on `ar-EG` needs the face as much as one on `ar`.
    for (const tag of ['ar-EG', 'AR', 'ar_SA', 'ar-Arab-EG']) {
      expect(facesForLanguage(tag)).toHaveLength(3);
    }
  });

  test('junk asks for nothing rather than throwing', () => {
    for (const bad of [null, undefined, '', '   ', 'not a language', 'arabic']) {
      expect(facesForLanguage(bad)).toEqual([]);
    }
  });
});

describe('loadFontsForLanguage', () => {
  test('it never rejects, in either branch', async () => {
    // Under `bun test` the CSS imports fail — there is no bundler here — which
    // is precisely the case the swallow exists for: a font that cannot be
    // fetched must leave a page in a fallback face, never an unhandled
    // rejection inside a language change.
    await expect(loadFontsForLanguage('ar')).resolves.toBeUndefined();
    await expect(loadFontsForLanguage('en')).resolves.toBeUndefined();
  });

  test('Arabic is requested once however often the reader switches', () => {
    // The same promise object, not merely an equal one: a second request would
    // be a second set of three network fetches on every toggle back.
    expect(loadFontsForLanguage('ar')).toBe(loadFontsForLanguage('ar-EG'));
  });
});
