import i18n from 'i18next';

/**
 * v3's strings, loaded with v3's code (SC-169).
 *
 * SC-132 moved 27% of the bundle behind the UI-generation split and left the
 * strings where they were: 1062 `v3.*` keys — **65 KB of JSON, 12.9 KB brotli**
 * — stayed in the entry chunk, downloaded before the shell could render by
 * every visitor including the ones who never sign in. That is the same defect
 * the code split was opened to fix, in the other half of the same feature.
 *
 * The split has to be at module level rather than at key level. Rollup assigns
 * a module to exactly one chunk, so a single `en.json` imported by both the
 * shell and this file lands in the shell's chunk whole — tree-shaking a JSON
 * module's named exports across a chunk boundary is not a thing. Hence two
 * files per locale rather than two slices of one, and hence the guard in
 * `tests/lib/i18n-locales.test.ts` that keeps the two directories in step.
 *
 * **Imported for its side effect from `V3App`**, which is what puts it in the
 * v3 chunk and what guarantees it has run before any v3 component renders: the
 * chunk's module bodies all evaluate before the route it defines is mounted.
 * `addResourceBundle` needs no re-render because nothing has read a key yet.
 */
const localeModules = import.meta.glob<{ default: Record<string, unknown> }>('./locales/*.json', {
  eager: true,
});

for (const [path, mod] of Object.entries(localeModules)) {
  const code = path.replace(/^\.\/locales\//, '').replace(/\.json$/, '');
  // Deep-merge, and do not overwrite: the shell bundle is already registered
  // and this adds a disjoint branch to it.
  i18n.addResourceBundle(code, 'translation', mod.default, true, false);
}
