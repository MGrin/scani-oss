import i18n from 'i18next';
import { locales } from '@/i18n';
import { loadersByCode } from '@/i18n/locale-loader';
import englishLocale from './locales/en.json';

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
// Deep-merge, and do not overwrite: the shell bundle is already registered and
// this adds a disjoint branch to it.
i18n.addResourceBundle('en', 'translation', englishLocale, true, false);

// Every other language is a chunk of its own (SC-1498): nine bundled locales
// were 273 KB brotli against English's 31, 46% of this chunk.
locales.register(
  loadersByCode(
    import.meta.glob<{ default: Record<string, unknown> }>([
      './locales/*.json',
      '!./locales/en.json',
    ])
  )
);

// Top-level await, so every module that imports this one — `V3App` and the
// billing screens — evaluates after the reader's language is in, and none of
// them can render a v3 key in English first. `warmInterface` requests this
// chunk before the route mounts, so the fetch overlaps the session probe.
// A fetch that fails leaves the bundled English, which is a working screen.
const active = locales.active();
if (active) await locales.ensure(active).catch(() => undefined);
