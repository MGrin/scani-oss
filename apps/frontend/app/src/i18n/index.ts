import { addUiLocale, setUiLanguage } from '@scani/ui/i18n';
import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import { resolveUiLocale } from './resolve-ui-locale';

// Auto-discover every JSON file under `locales/`. Adding `es.json` (or
// any other ISO code) is enough — no other file needs to be touched.
// Vite inlines the matched modules at build time, so the locales ship
// as part of the SPA bundle and there's no runtime fetch.
const localeModules = import.meta.glob<{ default: Record<string, unknown> }>('./locales/*.json', {
  eager: true,
});

type LocaleMeta = { name?: string; nativeName?: string };

export interface AvailableLanguage {
  code: string;
  name: string;
  nativeName: string;
}

const resources: Record<string, { translation: Record<string, unknown> }> = {};
const availableLanguages: AvailableLanguage[] = [];

for (const [path, mod] of Object.entries(localeModules)) {
  const code = path.replace(/^\.\/locales\//, '').replace(/\.json$/, '');
  const translation = { ...mod.default };
  const meta = (translation.$meta as LocaleMeta | undefined) ?? {};
  delete translation.$meta;
  resources[code] = { translation };
  availableLanguages.push({
    code,
    name: meta.name ?? code,
    nativeName: meta.nativeName ?? meta.name ?? code,
  });
}

availableLanguages.sort((a, b) => a.name.localeCompare(b.name));

export const AVAILABLE_LANGUAGES: ReadonlyArray<AvailableLanguage> = availableLanguages;

const LANGUAGE_STORAGE_KEY = 'scani.language';

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
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

export default i18n;
