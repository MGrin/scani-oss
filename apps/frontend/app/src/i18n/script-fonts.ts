/**
 * The Arabic web face, fetched only by readers who chose Arabic (SC-201).
 *
 * `v3-tokens.css` names `IBM Plex Sans Arabic` in `--font-sans` for every
 * language, which costs nothing on its own — a family the document never loads
 * is skipped per glyph. This module is what turns that name into bytes, and it
 * runs for `ar` and no other language, so the other eight download exactly what
 * they downloaded before.
 *
 * ## Three weights, and why not the variable face
 *
 * v3 uses `font-normal`, `font-medium` and `font-semibold` — 400, 500 and 600.
 * Latin gets those from one variable file; Plex Sans Arabic ships static cuts,
 * so it is three requests of ~43 KB each, **131 KB total** against the ~250 KB
 * budget this was measured for. Loading only 400 would save 88 KB and render
 * every medium and semibold label with a synthesised weight, which on a script
 * whose letters join is a visibly different typeface rather than a slightly
 * bolder one.
 *
 * ## Why an `import()` and not a `<link>`
 *
 * Vite fingerprints and inlines what it can see. A hand-written `<link>` to a
 * path inside `node_modules` is not built, so it would 404 in production while
 * working in dev — the failure shape that only shows up after a deploy. The
 * dynamic import is also why this file lives under `apps/frontend/app` rather
 * than in `@scani/ui`: `AGENTS.md` lifts the no-`await import` rule for
 * `apps/frontend/*` only, and `@scani/ui` is not in it.
 *
 * ## It never rejects into a render
 *
 * A font that fails to arrive is a page in a fallback face, which is degraded
 * and readable. A rejected promise in a language-change handler is a blank
 * screen, and the installed PWA has no URL bar to leave one by. So the failure
 * is swallowed deliberately and the request is not retried: the next language
 * change calls this again, and until then the stack's later entries are doing
 * exactly the job they are there for.
 */

/**
 * Which extra faces a language needs — the DECISION, with no fetching in it.
 *
 * Separated from the loader below for the reason `resolve-ui-locale.ts` is
 * separated from `i18n/index.ts` (SC-260): a rule that only runs inside a
 * dynamic `import()` is a rule no test can reach, and under `bun test` that
 * import fails for reasons having nothing to do with the rule — so a test
 * written against the loader would pass whatever this returned.
 *
 * Keyed on the BASE subtag, so `ar-EG` and `ar` agree: the value can arrive
 * from a browser header we do not control.
 */
export function facesForLanguage(language: string | null | undefined): readonly string[] {
  const base = (language ?? '').split(/[-_]/)[0]?.toLowerCase() ?? '';
  return base === 'ar' ? ARABIC_FACES : [];
}

/** 400, 500, 600 — `font-normal`, `font-medium`, `font-semibold` in v3. */
const ARABIC_FACES = ['arabic-400', 'arabic-500', 'arabic-600'] as const;

/** Resolves once per page, however many times a reader switches languages. */
let arabicFace: Promise<void> | undefined;

function loadArabic(): Promise<void> {
  // Spelled out rather than built from `ARABIC_FACES`: Vite resolves a dynamic
  // import by reading the literal, so an interpolated specifier either fails to
  // bundle or pulls in every file the pattern matches.
  arabicFace ??= Promise.all([
    import('@fontsource/ibm-plex-sans-arabic/arabic-400.css'),
    import('@fontsource/ibm-plex-sans-arabic/arabic-500.css'),
    import('@fontsource/ibm-plex-sans-arabic/arabic-600.css'),
  ])
    .then(() => undefined)
    .catch(() => undefined);
  return arabicFace;
}

/**
 * Fetch whatever face `language` needs, or nothing at all.
 *
 * Returns a promise callers may ignore. The same promise every time for one
 * language, so switching back and forth does not re-request.
 */
export function loadFontsForLanguage(language: string | null | undefined): Promise<void> {
  return facesForLanguage(language).length > 0 ? loadArabic() : Promise.resolve();
}
