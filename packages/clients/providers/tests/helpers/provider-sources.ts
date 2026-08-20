/**
 * Reading providers as SOURCE.
 *
 * The guards built on this exist because the defects they catch are invisible
 * to a per-provider test: nothing reads a provider's look-back and its declared
 * horizon together (SC-418), and nothing reads its page cap and its retraction
 * together (SC-426). Both were found by a person reading twelve files, which is
 * not a thing anyone will remember to do for the thirteenth.
 *
 * Every reader here must be able to come back empty — a scan that cannot fail
 * passes on a file that declares nothing. The negative controls in the tests
 * that use them are what establish that.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ProviderSource {
  name: string;
  source: string;
}

/** Every `src/providers/<name>/index.ts`, read once. */
export function providerSources(): ProviderSource[] {
  const dir = new URL('../../src/providers/', import.meta.url).pathname;
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      source: (() => {
        try {
          return readFileSync(join(dir, entry.name, 'index.ts'), 'utf8');
        } catch {
          return '';
        }
      })(),
    }));
}

/** The look-back constant a `since`-less run substitutes, if it substitutes one. */
export function substitutedWindow(source: string): string | null {
  const match = source.match(
    /ctx\.since\s*\?\?\s*new Date\(\s*until\.getTime\(\)\s*-\s*([A-Za-z_$][\w$]*)\s*\)/
  );
  return match?.[1] ?? null;
}

/** The constant the file declares as its horizon, if it declares one. */
export function declaredHorizon(source: string): string | null {
  const match = source.match(/readonly transactionHistoryHorizonMs\s*=\s*([A-Za-z_$][\w$]*)\s*;/);
  return match?.[1] ?? null;
}

/**
 * The page-cap constants any loop in the file is bounded by, in source order.
 *
 * Matches the two shapes the catalog uses — `for (let page = 0; page < CAP;`
 * and `while (pages < CAP)` / `while (currentPage <= CAP)` — against an
 * identifier naming pages. A cap under a different name is invisible to this,
 * which is why the tests assert the discovered population rather than trusting
 * the scan to be exhaustive.
 */
export function pageCapLoops(source: string): string[] {
  const pattern = /[<>]=?\s*(MAX_[A-Z0-9_]*PAGES?[A-Z0-9_]*)\b/g;
  return [...new Set([...source.matchAll(pattern)].map((m) => m[1] as string))];
}

/**
 * How the file can tell the caller its walk came back short, if it can.
 *
 * Two legitimate shapes, and they are not interchangeable. A `BaseCexProvider`
 * subclass returns its verdict as the paginator's terminal value and the base
 * forwards it; a provider that hand-rolls its loops has no terminal value to
 * return and collects capped walks in a `PageCapWatch` instead.
 */
export function truncationChannel(source: string): 'verdict' | 'page-cap-watch' | null {
  if (/hasCompleteTxHistory:\s*false/.test(source)) return 'verdict';
  if (/\bPageCapWatch\b/.test(source)) return 'page-cap-watch';
  return null;
}
