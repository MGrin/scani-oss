import { afterEach, describe, expect, test } from 'bun:test';
import {
  APP_NUMBER_LOCALE,
  formatCompact,
  formatCurrency,
  formatNumber,
} from '../../src/format/currency';
import { APP_LOCALE, formatDate, formatDateTime, monthName } from '../../src/format/date';
import {
  AUTO_REGION,
  FORMAT_REGIONS,
  getFormatLocale,
  isFormatRegionSupported,
  LANGUAGE_FORMATS,
  resetFormatLocale,
  resolveFormatLocale,
  setFormatLocale,
  supportedFormatRegions,
} from '../../src/format/locale';

/**
 * The locale table, and the two things it must not break (SC-201).
 *
 * 1. **English renders exactly what it rendered before.** The pins were not
 *    lifted — they became the `en` row. Every assertion below that compares
 *    against `APP_LOCALE` / `APP_NUMBER_LOCALE` is checking that, and it is
 *    the only reason this change is safe to land with no translator involved.
 * 2. **The server stays on English by omission.** `@scani/shared` is imported
 *    by the api and the worker. If a module global could drift there, a
 *    statement would render in whichever reader's locale was set last.
 */

const REFERENCE = new Date(Date.UTC(2026, 6, 16, 13, 5));

afterEach(() => {
  resetFormatLocale();
});

describe('resolveFormatLocale', () => {
  test('English with no region is the two pins, exactly', () => {
    const locale = resolveFormatLocale('en', AUTO_REGION);
    expect(locale.dateLocale).toBe(APP_LOCALE);
    expect(locale.numberLocale).toBe(APP_NUMBER_LOCALE);
    expect(locale.dir).toBe('ltr');
  });

  test('the language decides, the device never does', () => {
    // Nothing in this module reads `navigator`. The one input is the language
    // the reader chose — which is the whole correction SC-175 asked for.
    expect(resolveFormatLocale('fr').dateLocale).toBe('fr-FR');
    expect(resolveFormatLocale('ja').numberLocale).toBe('ja-JP');
  });

  test('an explicit region overrides, and collapses the en split', () => {
    const locale = resolveFormatLocale('en', 'DE');
    expect(locale.dateLocale).toBe('en-DE');
    expect(locale.numberLocale).toBe('en-DE');
  });

  test('English text with European dates is one tag, and it renders', () => {
    // The mixed-preference reader this setting exists for: the interface
    // stays English, the dates stop being American.
    //
    // Matched rather than pinned, because the day separator is CLDR data and
    // not a property of this code: `en-DE` medium renders `16. Jul 2026` on
    // macOS ICU and `16 Jul 2026` on the Linux ICU that CI runs. Pinning
    // either one makes the suite pass on one platform and fail on the other.
    // What the test is actually about — the day leads the month — holds in
    // both, and `Jul 16` would still fail.
    const locale = resolveFormatLocale('en', 'DE');
    expect(REFERENCE.toLocaleDateString(locale.dateLocale, { dateStyle: 'medium' })).toMatch(
      /^16\.? Jul 2026$/
    );
    expect((1234567.5).toLocaleString(locale.numberLocale)).toBe('1.234.567,5');
  });

  test('a region already carries a language subtag rather than replacing it', () => {
    // `en` + Japan is `en-JP`, not `ja-JP`. Choosing where you read does not
    // choose what language you read in — the two settings stay independent.
    expect(resolveFormatLocale('en', 'JP').language).toBe('en');
    expect(resolveFormatLocale('en', 'JP').dateLocale).toBe('en-JP');
  });

  test('a regional interface language keeps only its base', () => {
    expect(resolveFormatLocale('pt-BR').language).toBe('pt');
    // …and its own default region, because the reader picked a language, not
    // a region. `pt-BR` selected as an interface language is still `pt`.
    expect(resolveFormatLocale('pt-BR').dateLocale).toBe('pt-PT');
  });

  test('junk from localStorage degrades to English rather than throwing', () => {
    for (const bad of [null, undefined, '', 'xx', 'not a language']) {
      expect(resolveFormatLocale(bad).dateLocale).toBe(APP_LOCALE);
    }
    expect(resolveFormatLocale('en', 'ZZ').region).toBe(AUTO_REGION);
    expect(resolveFormatLocale('en', 'ZZ').dateLocale).toBe(APP_LOCALE);
  });

  test('every offered region resolves to a tag Intl accepts', () => {
    for (const region of FORMAT_REGIONS) {
      const locale = resolveFormatLocale('en', region);
      expect(() => new Intl.DateTimeFormat(locale.dateLocale)).not.toThrow();
      expect(() => new Intl.NumberFormat(locale.numberLocale)).not.toThrow();
    }
  });

  test('English text with an unsupported region silently does nothing', () => {
    // Which is why `supportedFormatRegions` exists, and why the picker calls
    // it. `resolveFormatLocale` stays pure and deterministic — it hands back
    // the tag it was asked for, and `Intl` is where the region gets dropped.
    const locale = resolveFormatLocale('en', 'EG');
    expect(locale.dateLocale).toBe('en-EG');
    expect(new Intl.DateTimeFormat(locale.dateLocale).resolvedOptions().locale).toBe('en');
  });

  test('every language SC-201 ships has a row, and Arabic is the only rtl one', () => {
    for (const code of ['en', 'ru', 'fr', 'es', 'pt', 'zh', 'ja', 'ar', 'id']) {
      expect(LANGUAGE_FORMATS[code]).toBeDefined();
    }
    const rtl = Object.entries(LANGUAGE_FORMATS)
      .filter(([, format]) => format.dir === 'rtl')
      .map(([code]) => code);
    expect(rtl).toEqual(['ar']);
  });

  test('en is the only row that splits dates from numbers', () => {
    // The split is the two pins preserved, not a pattern. A second row with a
    // `numberRegion` is someone encoding an opinion that belongs in a comment.
    const split = Object.entries(LANGUAGE_FORMATS)
      .filter(([, format]) => format.numberRegion !== undefined)
      .map(([code]) => code);
    expect(split).toEqual(['en']);
  });
});

describe('the process default', () => {
  test('nothing set means English — this is what the server renders', () => {
    // `resetFormatLocale` puts it back to the value it holds at import time.
    // No server code calls `setFormatLocale`, so this IS the api and worker's
    // locale for the process lifetime.
    expect(getFormatLocale().dateLocale).toBe(APP_LOCALE);
    expect(getFormatLocale().numberLocale).toBe(APP_NUMBER_LOCALE);
  });

  test('omitting the argument renders what the pins rendered', () => {
    expect(formatDate(REFERENCE)).toBe(formatDate(REFERENCE, APP_LOCALE));
    expect(formatDate(REFERENCE)).toBe('16 Jul 2026');
    expect(formatDateTime(REFERENCE)).toBe(formatDateTime(REFERENCE, APP_LOCALE));
    expect(monthName(7)).toBe('July');
    expect(formatCurrency(1234.5, 'USD')).toBe('$1,234.50');
    expect(formatNumber(1234.5)).toBe('1,234.5');
    expect(formatCompact(12_345, 'USD')).toBe(
      formatCompact(12_345, 'USD', { locale: APP_NUMBER_LOCALE })
    );
  });
});

describe('setFormatLocale', () => {
  test('the helpers follow it without a single call site changing', () => {
    // The property the whole slice rests on: `formatDate(x)` and
    // `formatCurrency(x, 'USD')` are unchanged at all 44 v3 call sites and
    // they now render the reader's locale.
    setFormatLocale('en', 'DE');
    // Matched, not pinned — see the note on the `en-DE` case above.
    expect(formatDate(REFERENCE)).toMatch(/^16\.? Jul 2026$/);
    expect(formatNumber(1234.5)).toBe('1.234,5');

    setFormatLocale('fr');
    expect(formatDate(REFERENCE)).toBe('16 juil. 2026');
    expect(monthName(7)).toBe('juillet');
  });

  test('an explicit locale argument still wins', () => {
    // `apps/backend/api/src/lib/pdf/layout.ts` passes one. A statement must
    // not change because a browser somewhere set a region.
    setFormatLocale('ja');
    expect(formatDate(REFERENCE, APP_LOCALE)).toBe('16 Jul 2026');
    expect(formatCurrency(1234.5, 'USD', { locale: APP_NUMBER_LOCALE })).toBe('$1,234.50');
  });

  test('resetFormatLocale restores English', () => {
    setFormatLocale('ru');
    resetFormatLocale();
    expect(formatDate(REFERENCE)).toBe('16 Jul 2026');
  });
});

describe('supportedFormatRegions', () => {
  test('every region it offers actually survives into the resolved locale', () => {
    for (const region of supportedFormatRegions('en')) {
      const tag = `en-${region}`;
      expect(new Intl.Locale(new Intl.DateTimeFormat(tag).resolvedOptions().locale).region).toBe(
        region
      );
      expect(new Intl.Locale(new Intl.NumberFormat(tag).resolvedOptions().locale).region).toBe(
        region
      );
    }
  });

  test('it drops something, or it is not doing anything', () => {
    // The count differs by runtime on purpose — Bun's ICU keeps 11 of the 12
    // for English and Chromium keeps 8 — so this asserts the filter bites
    // rather than a number that would be wrong in the other one.
    expect(supportedFormatRegions('en').length).toBeLessThan(FORMAT_REGIONS.length);
    expect(supportedFormatRegions('en').length).toBeGreaterThan(0);
  });

  test('it never invents a region the candidate list does not have', () => {
    for (const region of supportedFormatRegions('ru')) {
      expect(FORMAT_REGIONS).toContain(region);
    }
  });

  test('junk is unsupported rather than thrown', () => {
    expect(isFormatRegionSupported('en', 'ZZZZ')).toBe(false);
    expect(isFormatRegionSupported('en', '')).toBe(false);
  });
});
