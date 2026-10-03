import { describe, expect, test } from 'bun:test';
import { isChunkLoadError } from '@scani/ui/lib/lazy-chunk';
import i18next from 'i18next';
import { createLocaleLoader, loadersByCode } from '../../src/i18n/locale-loader';

async function instance(lng = 'en') {
  const i18n = i18next.createInstance();
  await i18n.init({
    resources: { en: { translation: { hello: 'Hello', v3: { title: 'Title' } } } },
    lng,
    fallbackLng: 'en',
    supportedLngs: ['en', 'ru', 'fr'],
  });
  return i18n;
}

const shellRu = async () => ({ default: { $meta: { name: 'Russian' }, hello: 'Привет' } });
const v3Ru = async () => ({ default: { v3: { title: 'Заголовок' } } });

describe('locales on demand (SC-1498)', () => {
  test('a language is switched to only after every source has its strings', async () => {
    const i18n = await instance();
    const locales = createLocaleLoader(i18n);
    locales.register({ ru: shellRu });
    locales.register({ ru: v3Ru });
    const seen: string[] = [];
    i18n.on('languageChanged', () => seen.push(`${i18n.t('hello')} / ${i18n.t('v3.title')}`));

    await locales.change('ru');

    // Read at the moment of the switch: neither a raw key nor the fallback.
    expect(seen).toEqual(['Привет / Заголовок']);
    expect(i18n.getResourceBundle('ru', 'translation').$meta).toBeUndefined();
  });

  test('a source that registers later brings its half of the active language', async () => {
    const i18n = await instance('ru');
    const locales = createLocaleLoader(i18n);
    locales.register({ ru: shellRu });
    await locales.ensure('ru');
    expect(i18n.t('v3.title')).toBe('Title');

    locales.register({ ru: v3Ru });
    await locales.ensure(locales.active() ?? 'en');

    expect(i18n.t('v3.title')).toBe('Заголовок');
  });

  test('each file is fetched once however often it is asked for', async () => {
    const i18n = await instance();
    const locales = createLocaleLoader(i18n);
    let fetches = 0;
    locales.register({
      ru: async () => {
        fetches += 1;
        return shellRu();
      },
    });
    await Promise.all([locales.ensure('ru'), locales.ensure('ru')]);
    await locales.ensure('ru');
    expect(fetches).toBe(1);
  });

  test('a failed fetch rejects readably, leaves the language alone and can be retried', async () => {
    const i18n = await instance();
    const locales = createLocaleLoader(i18n);
    let attempts = 0;
    locales.register({
      fr: async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('Failed to fetch dynamically imported module');
        return { default: { hello: 'Bonjour' } };
      },
    });

    const failure = await locales.change('fr').catch((error: unknown) => error);
    expect(isChunkLoadError(failure)).toBe(true);
    expect(i18n.language).toBe('en');

    await locales.change('fr');
    expect(i18n.t('hello')).toBe('Bonjour');
  });

  test('the active language is the first detected code a source can load', async () => {
    const i18n = await instance('ru');
    const locales = createLocaleLoader(i18n);
    expect(locales.active()).toBeUndefined();
    locales.register({ ru: shellRu });
    expect(locales.active()).toBe('ru');
  });

  test('loadersByCode keys a glob by language code', () => {
    const keyed = loadersByCode({ './locales/ru.json': shellRu, './locales/fr.json': v3Ru });
    expect(Object.keys(keyed).sort()).toEqual(['fr', 'ru']);
  });
});
