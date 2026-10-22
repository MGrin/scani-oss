import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { STARTER_CATEGORY_NAMES, SUGGESTED_CATEGORY_KEYS } from '@scani/shared';
import ar from '../../../src/v3/i18n/locales/ar.json';
import en from '../../../src/v3/i18n/locales/en.json';
import es from '../../../src/v3/i18n/locales/es.json';
import fr from '../../../src/v3/i18n/locales/fr.json';
import id from '../../../src/v3/i18n/locales/id.json';
import ja from '../../../src/v3/i18n/locales/ja.json';
import pt from '../../../src/v3/i18n/locales/pt.json';
import ru from '../../../src/v3/i18n/locales/ru.json';
import zh from '../../../src/v3/i18n/locales/zh.json';

const LOCALES = { ar, en, es, fr, id, ja, pt, ru, zh };

describe('the server copy of the starter category names (SC-1722)', () => {
  test("matches the app's starter set in every locale", () => {
    expect(Object.keys(STARTER_CATEGORY_NAMES).sort()).toEqual(Object.keys(LOCALES).sort());
    for (const [locale, messages] of Object.entries(LOCALES)) {
      const suggested = messages.v3.categories.suggested as Record<string, string>;
      const names = STARTER_CATEGORY_NAMES[locale as keyof typeof STARTER_CATEGORY_NAMES];
      expect(Object.keys(names).sort()).toEqual([...SUGGESTED_CATEGORY_KEYS].sort());
      const inApp = Object.fromEntries(Object.keys(names).map((key) => [key, suggested[key]]));
      expect({ locale, ...inApp }).toEqual({ locale, ...names });
    }
  });
});
