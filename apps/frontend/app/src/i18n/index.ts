import { addUiLocale, setUiLanguage } from '@scani/ui/i18n';
import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import { registerDurationFormatter } from './duration-format';
import { LANGUAGE_NAMES } from './language-names';
import { createLocaleLoader, loadersByCode } from './locale-loader';
import englishLocale from './locales/en.json';
import { isOfferedLanguage } from './offered-languages';
import { resolveUiLocale } from './resolve-ui-locale';

// English is bundled: it is the fallback every missing key resolves to, so it
// has to be there before the first render. Every other locale is a chunk of its
// own, fetched when it is the reader's language or when they pick it (SC-1498)
// — nine bundled locales were 57 KB brotli of this chunk against English's 4.6.
// Adding `es.json` is still enough for the strings; the picker's label for it
// comes from `language-names.ts`, which a test holds against each `$meta`.
const lazyLocales = loadersByCode(
  import.meta.glob<{ default: Record<string, unknown> }>(['./locales/*.json', '!./locales/en.json'])
);

export interface AvailableLanguage {
  code: string;
  name: string;
  nativeName: string;
}

const { $meta: _englishMeta, ...english } = englishLocale as Record<string, unknown>;

const availableLanguages: AvailableLanguage[] = ['en', ...Object.keys(lazyLocales)]
  .filter((code) => isOfferedLanguage(code))
  .map((code) => ({
    code,
    name: LANGUAGE_NAMES[code]?.name ?? code,
    nativeName: LANGUAGE_NAMES[code]?.nativeName ?? LANGUAGE_NAMES[code]?.name ?? code,
  }));

availableLanguages.sort((a, b) => a.name.localeCompare(b.name));

export const AVAILABLE_LANGUAGES: ReadonlyArray<AvailableLanguage> = availableLanguages;

const LANGUAGE_STORAGE_KEY = 'scani.language';

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: english } },
    fallbackLng: 'en',
    supportedLngs: availableLanguages.map((l) => l.code),
    // Keys are flat at the top level — nesting is expressed via dots.
    // Missing keys in a non-English locale fall back to English, so a
    // partial translation never breaks the UI.
    nonExplicitSupportedLngs: true,
    interpolation: { escapeValue: false },
    detection: {
      order: ['querystring', 'localStorage', 'navigator'],
      lookupQuerystring: 'lng',
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: ['localStorage'],
    },
  });

registerDurationFormatter(i18n);

/**
 * Keep `@scani/ui` on the same language as the app (SC-250).
 *
 * The package runs its OWN i18next instance, because three of its four
 * consumers have no i18n at all and a bare `useTranslation()` there renders the
 * raw key. That independence is the point, and it is also why the two have to
 * be joined up explicitly here rather than sharing a singleton.
 *
 * The `ui` half of each locale file is handed over rather than duplicated into
 * the package: `locales/` is the directory a translator is given, and a second
 * set of files somewhere else is a second set nobody remembers to translate.
 * A locale with no `ui` section simply keeps the package's bundled English,
 * which is the same partial-translation fallback the app already relies on.
 *
 * ## `ru.json` HAS MORE KEYS THAN `en.json`, AND THAT IS THIS FUNCTION WORKING
 *
 * Measured 2026-08-26: `locales/en.json` 406 keys, `locales/ru.json` 660. Of
 * the 254 difference, 64 are Russian plural forms (`_few` / `_many`, categories
 * English does not have) and **190 are `ui.*` keys with no `en` counterpart in
 * this directory** — `ui.dataView.*`, `ui.amountInput.*`, `ui.brand.*`.
 *
 * That asymmetry is required, not drift. English reaches `@scani/ui` from the
 * package's own statically-imported `locales/en.json`, so the app never needs
 * to carry it; every OTHER language reaches it only through the `addUiLocale`
 * call below. Delete the `ui.*` block from `ru.json` to "restore parity" and
 * every shared component silently renders English for Russian users — no error,
 * no missing key, just the fallback doing its job over a translation that is no
 * longer being handed across.
 *
 * Stated here because the count is what a reader meets first and it reads as
 * rot. One did, on this file, and got as far as drafting a cleanup ticket
 * before reading `addUiLocale` — two true facts (the package ships `en` only;
 * `ru` has 190 `ui.*` keys `en` lacks) joined by an invented mechanism that
 * happened to fit. The join is above; it is the only thing that distinguishes
 * the two readings, and nothing about the key counts points at it.
 */
function syncUiLocale(language: string | undefined): void {
  // `i18n.language` is unset until the detector has run, and this module is
  // imported for its side effect — so the first call can legitimately have
  // nothing to sync. The package keeps its own English until it does.
  if (!language) return;

  // Resolve against the language that actually HAS a bundle, not the one the
  // detector reported (SC-257). The decision lives in `resolveUiLocale` rather
  // than inline because this module cannot be imported under `bun test` —
  // `import.meta.glob` above is undefined there — so a loop written here is a
  // loop nothing can cover (SC-260).
  const match = resolveUiLocale(language, i18n.languages ?? [], (code) => {
    const bundle = i18n.getResourceBundle(code, 'translation') as
      | { ui?: Record<string, unknown> }
      | undefined;
    return bundle?.ui;
  });
  if (match) addUiLocale(match.code, { ui: match.bundle });
  setUiLanguage(language);
}

syncUiLocale(i18n.language);
// `initialized` as well as the immediate call: the detector runs inside
// `init`, so on a slower path the language can arrive after this module's body.
i18n.on('initialized', () => syncUiLocale(i18n.language));
i18n.on('languageChanged', syncUiLocale);

/** Loads a language's strings, from every chunk that carries some, on demand. */
export const locales = createLocaleLoader(i18n);
locales.register(lazyLocales);

/**
 * Settles once the reader's own language is in, so the first render is in it
 * rather than in English and then in it (SC-1498). Already settled for an
 * English reader, who waits for nothing.
 *
 * `changeLanguage` to the language already set is what makes i18next look
 * again: `resolvedLanguage` is worked out when the language is set, and it was
 * set before these strings existed. A fetch that fails is swallowed on purpose
 * — the reader gets the bundled English, which is a working app, where a
 * rejection here would be a blank page.
 */
export const activeLocaleReady: Promise<void> = (async () => {
  const code = locales.active();
  if (!code) return;
  try {
    await locales.ensure(code);
    await i18n.changeLanguage(i18n.language);
  } catch {
    // English stays.
  }
})();

export default i18n;
