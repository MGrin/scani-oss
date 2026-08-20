import { createInstance, type i18n as I18nInstance, type ResourceLanguage } from 'i18next';
import { useTranslation } from 'react-i18next';
import en from './locales/en.json';

/**
 * `@scani/ui`'s OWN i18next instance (SC-250).
 *
 * **Why the package owns an instance instead of using the app's.** Four apps
 * consume this package — `frontend/app`, `frontend/cloud`, `frontend/admin`,
 * `frontend/landing` — and only `app` has i18next wired. A bare
 * `useTranslation()` inside a shared component resolves against the *default*
 * i18next instance, and in the other three that instance has never been
 * initialised. Measured, not assumed:
 *
 * - `useTranslation()` with no instance does **not** throw. It logs
 *   `NO_I18NEXT_INSTANCE` and returns `t = (key) => key`, so
 *   `cloud.scani.xyz`'s error surface would read
 *   `ui.toast.errorTitle` where it used to read "Something went wrong".
 * - `<Trans>` with no instance renders **empty** — `<p></p>`.
 *
 * Both are worse than the untranslated English they replace, and both are
 * silent: a console warning and a screen that looks merely broken. Failing at
 * render is the one option the ticket rules out, because the installed PWA has
 * no URL bar to leave a broken screen by (SC-62, SC-73).
 *
 * An owned instance removes the failure mode rather than guarding against it.
 * There is no provider to forget, no mount order to get wrong, and a consumer
 * that has never heard of i18next gets correct English for free — which is
 * exactly what `admin` and `landing` need, since neither should have to adopt
 * i18n to keep rendering a button.
 *
 * **Initialised eagerly at module load**, not lazily on first `t()`. The toast
 * helpers below are plain functions called from mutation callbacks, outside
 * React and outside any render, so there is no hook and no suspense boundary to
 * hang a "not ready yet" state off. `init` with in-memory resources and no
 * backend is synchronous.
 *
 * **The locale is imported statically**, not discovered with
 * `import.meta.glob`. That is a Vite build-time API and is `undefined` under
 * `bun test`, which is why the app's own i18n module cannot be imported by a
 * test at all (see `apps/frontend/app/tests/i18n-preload.ts`). This one can.
 */
export const uiI18n: I18nInstance = createInstance();

// NOT `.use(initReactI18next)`. That module's `init` calls react-i18next's
// `setI18n`, which sets the GLOBAL default instance every bare
// `useTranslation()` resolves against — so registering this one would make the
// app's own v3 components read from the package's bundle and render raw keys.
// Measured: doing it that way failed 28 tests across ten v3 surfaces, all of
// them rendering `v3.home.disclosure.show` and friends. It is the same defect
// this file exists to prevent, pointing the other way, and `ui-i18n.test.tsx`
// now pins it.
void uiI18n.init({
  resources: { en: { translation: stripMeta(en) } },
  lng: 'en',
  fallbackLng: 'en',
  // React escapes for us; double-escaping turns the apostrophe in "today's
  // rates" into `&#39;` on the screen.
  interpolation: { escapeValue: false },
});

/** `$meta` describes the locale to a language picker; it is not copy. */
function stripMeta(bundle: Record<string, unknown>): Record<string, unknown> {
  const { $meta: _meta, ...rest } = bundle;
  return rest;
}

/**
 * Teach the package a language, then switch to it.
 *
 * The app owns locale discovery — it is the only consumer that ships more than
 * English, and its `locales/` directory is the one a translator is given. This
 * is how those translations reach the shared components: the app hands over the
 * `ui` half of its bundle rather than this package growing a parallel set of
 * files that somebody has to remember to translate too.
 */
export function addUiLocale(language: string, resources: ResourceLanguage): void {
  uiI18n.addResourceBundle(language, 'translation', resources, true, true);
}

/**
 * Follow a host app's language.
 *
 * Deliberately a plain call rather than a subscription to the default instance:
 * a package that reaches for `i18next.on('languageChanged')` is back to
 * depending on the default instance existing, which is the thing this file
 * exists to avoid.
 */
export function setUiLanguage(language: string): Promise<unknown> {
  // Returns the promise rather than swallowing it: `changeLanguage` applies on
  // a microtask even with in-memory resources, so a caller that needs to read
  // the new language back — a test, mostly — has to be able to wait for it.
  return uiI18n.changeLanguage(language);
}

/**
 * The hook every component IN THIS PACKAGE must use.
 *
 * It exists so no call site can write a bare `useTranslation()`. That resolves
 * against react-i18next's global default, which is the host app's instance
 * where there is one and nothing at all in `cloud`, `admin` and `landing` —
 * the exact failure this file is here to remove.
 */
export function useUiTranslation(): ReturnType<typeof useTranslation> {
  return useTranslation(undefined, { i18n: uiI18n });
}

/**
 * The package's `t`, for module-level call sites — toast helpers, error copy,
 * anything called outside a render. Components use `useUiTranslation`.
 *
 * A wrapper, NOT `uiI18n.t.bind(uiI18n)` captured at module load: i18next
 * REPLACES `instance.t` on every `changeLanguage`, so a bound reference keeps
 * resolving against the language the module was imported in. That fails in the
 * one direction nobody would look — English stays correct forever and only the
 * translated build is wrong.
 */
export const uiT: I18nInstance['t'] = ((...args: Parameters<I18nInstance['t']>) =>
  uiI18n.t(...args)) as I18nInstance['t'];

/**
 * A key's ENGLISH value, whatever language the interface is in (SC-257).
 *
 * For identifiers rather than copy — today, the export filename.
 * `exportFileName` slugifies to `[a-z0-9-]`, so a Japanese or Arabic noun
 * slugs to empty and every list exports as `scani-export-<date>.csv`; and a
 * file someone keeps, re-imports and lays beside last month's should not
 * change its name because they changed language. The same reasoning as the
 * `APP_LOCALE` pin on dates: some strings are for machines and for continuity,
 * not for reading.
 */
export function englishNoun(key: string): string {
  return uiI18n.getFixedT('en')(key, { count: 2 });
}
