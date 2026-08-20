import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * A paginated read must reach the list surface as a paginated read (SC-244).
 *
 * The defect this guards: `FilesPage` and `AnsweredTransfersPage` each fetched
 * one page of a longer list and handed the rows to `V3DataView`, which searched
 * and filtered them and reported the result in the words it uses for a reader
 * who owns nothing — "No transfers match “Revolut”" over 25 of 579 rows.
 *
 * The fix makes that distinction ride on `mergeQueries`, so it survives only as
 * long as the infinite query goes through it. A page that flattens its pages
 * and passes `loadingOnly(...)`, or that merges some *other* query and drops
 * this one, compiles cleanly and renders the old lie. Neither type-check nor a
 * component test can see it — both look identical whether the set is whole or a
 * quarter of one — so it is checked here, the same way `route-split.test.ts`
 * checks a condition the compiler cannot.
 *
 * Two rules, and the second is the one that bites:
 *
 * 1. A file calling `useInfiniteQuery` must call `mergeQueries`.
 * 2. It must pass the infinite query's own identifier to it. Merging a
 *    neighbouring query and leaving this one out is exactly the shape that
 *    reads as complete.
 */

/**
 * v3 only, and deliberately: `mergeQueries` and `V3DataView` are v3's, and v2
 * has neither. That is not a clean bill of health for v2 — running this over
 * the whole tree found `v2/hooks/useDocuments.ts` doing exactly the same thing
 * behind v2's `DataView`, which is SC-312 and is not fixed here.
 */
const SRC = resolve(import.meta.dir, '../../src/v3');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** `const rows = trpc.x.y.useInfiniteQuery(` — the binding is what must be
 *  merged, so the name is what this captures. */
const INFINITE_BINDING = /const\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*?\.useInfiniteQuery\s*\(/g;

interface Site {
  file: string;
  binding: string;
  source: string;
}

async function infiniteQuerySites(): Promise<Site[]> {
  const sites: Site[] = [];
  for (const file of sourceFiles(SRC)) {
    const source = stripComments(await Bun.file(file).text());
    for (const match of source.matchAll(INFINITE_BINDING)) {
      sites.push({ file: relative(SRC, file), binding: match[1] as string, source });
    }
  }
  return sites;
}

describe('a page of a list is never handed over as the whole list', () => {
  /** If this ever returns nothing the two tests below pass vacuously, which is
   *  the failure mode a guard test has. */
  test('there are paginated reads to check', async () => {
    const sites = await infiniteQuerySites();
    expect(sites.length).toBeGreaterThan(0);
  });

  test('every infinite query is merged into the surface’s query state', async () => {
    const missing = (await infiniteQuerySites())
      .filter((site) => !site.source.includes('mergeQueries('))
      .map((site) => site.file);

    expect(missing).toEqual([]);
  });

  test('and it is THAT query that gets merged, not a neighbour', async () => {
    const dropped = (await infiniteQuerySites())
      .filter((site) => !new RegExp(`mergeQueries\\([^)]*\\b${site.binding}\\b`).test(site.source))
      .map((site) => `${site.file}: ${site.binding}`);

    expect(dropped).toEqual([]);
  });
});
