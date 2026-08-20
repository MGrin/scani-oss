/**
 * Which locale code actually has a `ui` bundle to forward into `@scani/ui`?
 *
 * This is the decision SC-257 got wrong, extracted from `./index.ts` so a test
 * can reach it (SC-260).
 *
 * **The bug it exists to pin.** A browser set to British English reports
 * `en-GB`. `nonExplicitSupportedLngs` makes the *app* resolve that to `en`
 * happily, but `i18n.getResourceBundle('en-GB', …)` is literal and returns
 * `undefined` — so the forward into `@scani/ui` silently did nothing and every
 * list rendered `ui.dataView.noun.holdings` on screen.
 *
 * **Why it lives in its own file.** `./index.ts` discovers locales with
 * `import.meta.glob`, a Vite build-time API that is `undefined` under
 * `bun test`, so importing that module throws before a single test runs. The
 * decision therefore has to leave the module to be testable at all. Nothing
 * here touches `import.meta`, i18next, or the DOM.
 *
 * **Why not test it through the preload instead.** `tests/i18n-preload.ts`
 * mirrors boot rather than importing it, and pins `lng: 'en'` — as did the Bun
 * probe used to check the original fix. Both fixtures agreed with each other
 * and disagreed with the browser, which is precisely why the bug reached the
 * screen. A test written against the preload would exercise a second
 * implementation of the half that was already right.
 *
 * Candidate order is `[reported, ...resolved chain, base of reported]`: the
 * exact code first so a real `en-GB` bundle would win if one were ever added,
 * then whatever i18next resolved, then the bare language as a last resort.
 */
export function resolveUiLocale<T>(
  /** What the detector reported — `en-GB`, `zh-Hans-CN`, `fr`. */
  reported: string,
  /** `i18n.languages`: what i18next resolved the report to, best first. */
  resolved: readonly string[],
  /** Returns the code's `ui` bundle, or `undefined` when it has none. */
  lookup: (code: string) => T | undefined
): { code: string; bundle: T } | null {
  const base = reported.split('-')[0];
  for (const code of [reported, ...resolved, base ?? reported]) {
    if (!code) continue;
    const bundle = lookup(code);
    if (bundle !== undefined) return { code, bundle };
  }
  // No bundle anywhere. `null` rather than falling back to `reported`, which
  // would hand `@scani/ui` a code it has nothing for and put the raw key back
  // on screen — the same failure, one layer along.
  return null;
}
