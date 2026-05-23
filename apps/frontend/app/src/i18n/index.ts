import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

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

export const LANGUAGE_STORAGE_KEY = 'scani.language';

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

export default i18n;
