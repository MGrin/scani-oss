import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import i18next from 'i18next';

/**
 * SC-811. `v3.vaults.detail.countingToward` heads the list of holdings that
 * count toward a vault, and its verb has the holdings as its subject. French and
 * Spanish gave the `_one` form a plural verb and Russian gave every other form a
 * singular one: each category had been copied from another rather than written.
 *
 * So the check is on categories, not on words: rendered for 1 and for a count in
 * each other category the locale has, with the digits removed, the heading must
 * DIFFER wherever the language marks the verb for number, and must read the SAME
 * where it does not. The second arm is what keeps the first honest — a test that
 * only demanded difference would push a translator to invent one.
 */

const LOCALES_DIR = new URL('../../../src/v3/i18n/locales/', import.meta.url).pathname;
const KEY = 'v3.vaults.detail.countingToward';

/** The verb agrees with the number of holdings. */
const AGREES = ['es', 'fr', 'pt', 'ru'];
/**
 * The heading does not change with number, correctly: English uses a
 * participle; Arabic gives a non-human plural feminine singular agreement;
 * Indonesian, Japanese and Chinese do not mark the verb for number.
 */
const INVARIANT = ['ar', 'en', 'id', 'ja', 'zh'];

const locales = readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();

const instance = i18next.createInstance();
await instance.init({
  resources: Object.fromEntries(
    locales.map((lng) => [
      lng,
      { translation: JSON.parse(readFileSync(join(LOCALES_DIR, `${lng}.json`), 'utf8')) },
    ])
  ),
  lng: 'en',
  fallbackLng: false,
  interpolation: { escapeValue: false },
});

/** The first count from 2 upward that falls in each non-`one` category. */
function otherCategoryCounts(lng: string): Map<string, number> {
  const rules = new Intl.PluralRules(lng);
  const found = new Map<string, number>();
  for (let n = 2; n < 200; n++) {
    const category = rules.select(n);
    if (category !== 'one' && !found.has(category)) found.set(category, n);
  }
  return found;
}

function heading(lng: string, count: number): string {
  return instance.t(KEY, { lng, count }).replace(/[\d٠-٩]+/g, '#');
}

describe(`SC-811 · ${KEY} agrees with its count`, () => {
  test('every locale is classified, so a new one cannot pass by being unlisted', () => {
    expect([...AGREES, ...INVARIANT].sort()).toEqual(locales);
  });

  for (const lng of AGREES) {
    test(`${lng}: the singular differs from every other category`, () => {
      const one = heading(lng, 1);
      const others = otherCategoryCounts(lng);
      expect(others.size).toBeGreaterThan(0);
      for (const [category, n] of others) {
        expect({ category, text: heading(lng, n) }).not.toEqual({ category, text: one });
      }
    });
  }

  for (const lng of INVARIANT) {
    test(`${lng}: the heading reads the same for any count`, () => {
      // Whether a form shows the count in brackets is a separate choice
      // (Arabic's zero, one and two do not), so only the words are compared.
      const words = (text: string) => text.replace(/\s*[(（]#件?[)）]/g, '').trim();
      const one = words(heading(lng, 1));
      for (const [, n] of otherCategoryCounts(lng)) {
        expect(words(heading(lng, n))).toBe(one);
      }
    });
  }
});
