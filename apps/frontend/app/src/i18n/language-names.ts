/**
 * What the language picker calls each locale (SC-1498).
 *
 * The names used to be read out of each locale file's `$meta`, which meant
 * loading all nine files to draw one menu. They are short and they do not
 * change, so they live here and the files load on demand. Each file still
 * carries its `$meta`; `tests/lib/i18n-locales.test.ts` fails when the two
 * disagree or a locale file has no entry here.
 */
export const LANGUAGE_NAMES: Readonly<Record<string, { name: string; nativeName: string }>> = {
  ar: { name: 'Arabic', nativeName: 'العربية' },
  en: { name: 'English', nativeName: 'English' },
  es: { name: 'Spanish', nativeName: 'Español' },
  fr: { name: 'French', nativeName: 'Français' },
  id: { name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
  ja: { name: 'Japanese', nativeName: '日本語' },
  pt: { name: 'Portuguese', nativeName: 'Português' },
  ru: { name: 'Russian', nativeName: 'Русский' },
  zh: { name: 'Chinese', nativeName: '简体中文' },
};
