/**
 * Which locale files a reader may actually select (SC-201).
 *
 * The locale directory is the list of languages everywhere else: a JSON file in
 * `locales/` is a language the picker offers and `?lng=` accepts. That is the
 * right default, and it has exactly one case where it is wrong: a translation
 * that is complete while the interface around it is not ready for it.
 *
 * **Arabic is that case.** Its strings land before the right-to-left layout
 * pass and before the PDF and web fonts that shape Arabic script, so a reader
 * who could pick it would get correct words in a half-mirrored interface. Main
 * deploys on merge, so "nobody will find the setting yet" is not a hold. A
 * held language keeps its files, and `i18n-locales.test.ts` keeps them
 * complete, but `index.ts` registers neither its bundle nor its code, so the
 * picker omits it and `?lng=ar` falls back to English.
 *
 * Lives outside `index.ts` for the reason `resolve-ui-locale.ts` does: that
 * module uses `import.meta.glob`, which is undefined under `bun test`.
 *
 * **Remove a language from this set in the PR that makes it ready**, not after.
 */
const HELD_LANGUAGES: ReadonlySet<string> = new Set(['ar']);

export function isOfferedLanguage(code: string): boolean {
  return !HELD_LANGUAGES.has(code);
}
