import { afterEach, describe, expect, test } from 'bun:test';
import {
  APP_LOCALE,
  AUTO_REGION,
  formatDate,
  getFormatLocale,
  resetFormatLocale,
} from '@scani/shared';
import {
  applyFormatLocale,
  REGION_STORAGE_KEY,
  readStoredRegion,
  writeStoredRegion,
} from '../../src/i18n/format-locale';

/**
 * The browser half of the formatting locale (SC-201).
 *
 * Testable at all only because it takes its document and its storage as
 * arguments — `src/i18n/index.ts` cannot be imported under `bun test`, so the
 * logic that lives there is logic nothing can cover (SC-260).
 */

const REFERENCE = new Date(Date.UTC(2026, 6, 16));

function fakeDocument() {
  return { documentElement: { lang: '', dir: '' } as Pick<HTMLElement, 'lang' | 'dir'> };
}

/** Storage that works, and storage that throws the way Lockdown Mode does. */
function fakeStorage(initial?: Record<string, string>) {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    read: (key: string) => map.get(key) ?? null,
  };
}

const hostileStorage = {
  getItem() {
    throw new Error('storage disabled');
  },
  setItem() {
    throw new Error('storage disabled');
  },
};

afterEach(() => {
  resetFormatLocale();
});

describe('applyFormatLocale', () => {
  test('publishes to the formatters and to the document', () => {
    const doc = fakeDocument();
    const locale = applyFormatLocale('fr', AUTO_REGION, doc);

    expect(locale.dateLocale).toBe('fr-FR');
    expect(getFormatLocale().dateLocale).toBe('fr-FR');
    // The claim the whole slice rests on: a call site that passes no locale.
    expect(formatDate(REFERENCE)).toBe('16 juil. 2026');
  });

  test('`lang` is the language of the TEXT, not the format tag', () => {
    // English copy with German dates is English copy. A screen reader that
    // reads `en-DE` as German would be worse than no attribute at all.
    const doc = fakeDocument();
    applyFormatLocale('en', 'DE', doc);
    expect(doc.documentElement.lang).toBe('en');
    expect(getFormatLocale().dateLocale).toBe('en-DE');
  });

  test('`dir` follows the language, and English is ltr', () => {
    const doc = fakeDocument();
    applyFormatLocale('en', AUTO_REGION, doc);
    expect(doc.documentElement.dir).toBe('ltr');

    // No `ar` locale file exists, so no reader can reach this today — the
    // assertion is that the seam is wired, not that the layout is mirrored.
    applyFormatLocale('ar', AUTO_REGION, doc);
    expect(doc.documentElement.dir).toBe('rtl');
  });

  test('English with nothing chosen is still the pin', () => {
    const doc = fakeDocument();
    expect(applyFormatLocale('en', AUTO_REGION, doc).dateLocale).toBe(APP_LOCALE);
    expect(formatDate(REFERENCE)).toBe('16 Jul 2026');
  });
});

describe('the stored region', () => {
  test('absent means auto', () => {
    expect(readStoredRegion(fakeStorage())).toBe(AUTO_REGION);
    expect(readStoredRegion(null)).toBe(AUTO_REGION);
  });

  test('round-trips', () => {
    const storage = fakeStorage();
    writeStoredRegion(storage, 'DE');
    expect(storage.read(REGION_STORAGE_KEY)).toBe('DE');
    expect(readStoredRegion(storage)).toBe('DE');
  });

  test('a browser with storage off still renders dates', () => {
    // Both calls throw internally. Neither may escape: a region that cannot be
    // remembered is a lost preference, not a blank screen.
    expect(() => writeStoredRegion(hostileStorage, 'DE')).not.toThrow();
    expect(readStoredRegion(hostileStorage)).toBe(AUTO_REGION);
  });

  test('a stale or hand-edited value degrades to auto', () => {
    const doc = fakeDocument();
    const stored = readStoredRegion(fakeStorage({ [REGION_STORAGE_KEY]: 'ZZ' }));
    expect(applyFormatLocale('en', stored, doc).dateLocale).toBe(APP_LOCALE);
  });
});
