/**
 * Which locale files a reader may actually select (SC-201).
 *
 * The locale directory is the list of languages everywhere else: a JSON file in
 * `locales/` is a language the picker offers and `?lng=` accepts. That is the
 * right default, and it has exactly one case where it is wrong: a translation
 * that is complete while the interface around it is not ready for it.
 *
 * **Arabic was that case, and the set is empty because it no longer is.** Its
 * strings landed before the right-to-left layout pass and before the fonts that
 * shape Arabic script, so a reader who could have picked it would have got
 * correct words in a half-mirrored interface set in whatever face the system
 * happened to offer. Main deploys on merge, so "nobody will find the setting
 * yet" was never a hold. Both conditions are now met: the layout pass scans
 * `src/v3` and `@scani/ui` for physical inline properties and photographs four
 * RTL screens, the web face loads for `ar` alone, and the PDF embeds the same
 * family's Arabic cut, so Arabic shapes there rather than being marked.
 *
 * **The mechanism stays, with nothing in it, deliberately.** It is three lines,
 * and the next language to arrive will land its strings before its layout in
 * exactly the same way — Hebrew and Persian both would. Deleting it would make
 * the next translator's choice "ship it half-ready or sit on the branch", which
 * is the choice this file exists to remove. An empty set is also the honest
 * statement that nothing is held today, which a deleted file cannot make.
 *
 * Lives outside `index.ts` for the reason `resolve-ui-locale.ts` does: that
 * module uses `import.meta.glob`, which is undefined under `bun test`.
 *
 * **Remove a language from this set in the PR that makes it ready**, not after.
 */
export const HELD_LANGUAGES: ReadonlySet<string> = new Set<string>([]);

/**
 * `held` is a parameter so the RULE can be tested while the set is EMPTY.
 *
 * Without it the only reachable assertion is "everything is offered", which a
 * function returning `true` unconditionally also satisfies — so the day the set
 * emptied, the check protecting the next held language would have quietly
 * stopped being a check. Callers pass nothing.
 */
export function isOfferedLanguage(
  code: string,
  held: ReadonlySet<string> = HELD_LANGUAGES
): boolean {
  return !held.has(code);
}
