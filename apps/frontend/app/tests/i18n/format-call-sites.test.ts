import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { commentSkipper } from '../v3/helpers/source-scan';

/**
 * Nothing the SPA renders may take its date or number format from the DEVICE
 * (SC-762).
 *
 * The `setFormatLocale` seam has existed since SC-201's first slice and every
 * helper in `@scani/shared/format` reads it, so a unit test on a formatter
 * passes whatever the call sites do. **The defect this guards is a call site
 * that never asked** — `new Date(x).toLocaleDateString()` and
 * `n.toLocaleString()` with no argument take the runtime's locale, which is the
 * one thing SC-175 was reverted over: a reader on a Russian device saw Russian
 * dates under English copy.
 *
 * Three slices of SC-201 each found one of these BY EYE — `lib/tape.ts` pinned
 * to `en-US` under a comment promising it was not, `PortfolioChart`'s own
 * twelve-string English month table, and the two SC-762 fixed. Finding the
 * fourth by eye is not a plan. The population is small, the pattern is exact,
 * and a scan is the only part of this that keeps working while attention is
 * elsewhere.
 *
 * ## What this is NOT
 *
 * It is not a claim that the interface is localised, and it cannot see a call
 * site that passes the WRONG locale — `toLocaleDateString('en-US')` is invisible
 * here and would be wrong for every reader who did not choose it. What proves
 * the rendered page follows the chosen language is a render:
 * `tests/v3/components/balanceGaps.test.tsx` does that for the surface this
 * ticket fixed, with two arms that must differ. This is the cheaper thing
 * beside it — it stops the next one arriving in a file nobody renders.
 */

/**
 * The SPA and the kit it renders from — WIDER than `helpers/v3-sources.ts` on
 * purpose, and narrower than `apps/frontend` also on purpose.
 *
 * Wider, because the defect is not a v3 one: `src/lib/utils.ts` and
 * `src/lib/timezone.ts` sit outside `src/v3` and both format, and the shadcn
 * primitives under `packages/frontend/ui/src/ui` are rendered by every v3
 * surface. A scan rooted at `src/v3` would report a clean tree over them.
 *
 * Narrower, because **`apps/frontend/admin` and `apps/frontend/cloud` have no
 * language to follow.** Measured 2026-08-28: 0 files under either import
 * `useTranslation`, against 164 in this app. Their English formatting is a
 * decision rather than an oversight, and a guard that reddened on
 * `keys.ts`'s `toLocaleString('en-US')` would be demanding they follow a
 * setting that does not exist — a false positive whose remedy looks like a fix.
 */
const ROOTS = [
  resolve(import.meta.dir, '../../src'),
  resolve(import.meta.dir, '../../../../../packages/frontend/ui/src'),
] as const;

interface Source {
  path: string;
  name: string;
}

/**
 * Enumerated from DISK, not from `git ls-files`, and that is load-bearing.
 *
 * An index read is blind to a file that has been written and not yet staged, so
 * the first honest run of this guard against new work would be CI's — which is
 * the shape that let a new router pass `docs:check` locally and fail upstream
 * (SC-463). A wider population than a diff is the cost, and it is the right way
 * round: this guard exists to catch a file nobody was looking at.
 */
function walk(dir: string, root: string, out: Source[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, root, out);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push({ path: full, name: relative(resolve(root, '..'), full) });
    }
  }
}

function sources(): Source[] {
  const out: Source[] = [];
  for (const root of ROOTS) walk(root, root, out);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `x.toLocaleString()` / `.toLocaleDateString()` / `.toLocaleTimeString()` with
 * an EMPTY argument list.
 *
 * Empty parentheses rather than "no locale I recognise", because that is the
 * whole defect and it is exactly detectable. `toLocaleDateString(undefined, …)`
 * is the same bug spelled longer and is caught too; anything with a real first
 * argument is a decision this scan has no opinion about.
 */
const ARGUMENTLESS_TO_LOCALE = /\.toLocale(?:Date|Time)?String\(\s*(?:\)|undefined\s*[,)])/;

/**
 * `new Intl.NumberFormat()` and friends with no locale — EXCEPT the one shape
 * that is asking the runtime what it is rather than formatting for a reader.
 *
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` is how `lib/timezone.ts`
 * reads the browser's zone, which is the only honest source for it and has
 * nothing to do with the reader's language. Excluding it by the
 * `.resolvedOptions()` that follows keeps the exception keyed to what the call
 * DOES rather than to a filename, so moving that helper does not silently
 * re-arm the rule against it.
 */
const ARGUMENTLESS_INTL =
  /\bIntl\.(?:DateTimeFormat|NumberFormat|RelativeTimeFormat|ListFormat|PluralRules|DisplayNames)\(\s*(?:undefined\s*)?\)(?!\s*\.resolvedOptions)/;

interface Hit {
  file: string;
  line: number;
  text: string;
}

async function scan(pattern: RegExp, files: readonly Source[]): Promise<Hit[]> {
  const hits: Hit[] = [];
  for (const source of files) {
    const text = await Bun.file(source.path).text();
    // One skipper per FILE: block state must not leak across files, or an
    // unterminated comment in one would blind the scanner to the next.
    const isComment = commentSkipper();
    text.split('\n').forEach((line, index) => {
      if (isComment(line) || !pattern.test(line)) return;
      hits.push({ file: source.name, line: index + 1, text: line.trim() });
    });
  }
  return hits;
}

/**
 * The failure message names both remedies and neither is "delete the call".
 *
 * A guard that says only "this is forbidden" invites the reader to remove the
 * date, which is never right. The two real answers are the shared helper (which
 * reads the seam and gives the whole app one date format) or an explicit locale
 * where the call genuinely means English — a server-rendered statement has no
 * reader to follow.
 */
const format = (hits: readonly Hit[]): string[] =>
  hits.map(
    (hit) =>
      `${hit.file}:${hit.line} — ${hit.text}  [use formatDate/formatDateTime/formatNumber from ` +
      `@scani/shared, or pass an explicit locale if this output is deliberately not the reader's]`
  );

describe('the SPA formats for the chosen language, never the device (SC-762)', () => {
  const files = sources();

  /**
   * The denominator, asserted rather than assumed.
   *
   * Both rules below are ABSENCE claims and an absence over an empty file list
   * is true for the wrong reason — a moved directory or a bad `import.meta.dir`
   * turns this whole file green while examining nothing. 300 is a floor under
   * the 384 the two roots hold today, set so it fails on a population that has
   * collapsed rather than on one that shrank.
   */
  test('the scan has files to look at', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  /**
   * The must-be-FOUND control, on the PATTERNS rather than on the tree.
   *
   * A control that greps the real tree for something common proves the walker
   * runs and proves nothing about whether these two regexes can match the
   * defect — and the defect is now absent from the tree, so there is nothing
   * real left to find. These are the exact shapes SC-762 removed, quoted from
   * the two commits, and the must-be-ABSENT arm beside each is the spelling
   * that is legitimate.
   */
  test('the rules match the defect and spare the legitimate call', () => {
    expect(ARGUMENTLESS_TO_LOCALE.test('from: new Date(gap.from).toLocaleDateString(),')).toBe(
      true
    );
    expect(ARGUMENTLESS_TO_LOCALE.test('max: PDF_MAX_ROWS.toLocaleString(),')).toBe(true);
    expect(
      ARGUMENTLESS_TO_LOCALE.test('at.toLocaleDateString(getFormatLocale().dateLocale, {')
    ).toBe(false);
    // `undefined` is the same bug spelled longer, and Intl reads it as "the runtime's".
    expect(ARGUMENTLESS_TO_LOCALE.test('d.toLocaleDateString(undefined, { dateStyle: 1 })')).toBe(
      true
    );
    // A call whose argument is on the NEXT line. The scan is per-line, so the
    // rule must not fire on an open parenthesis alone — the first cut of this
    // regex made the closing `)` optional and reported two clean call sites.
    expect(
      ARGUMENTLESS_TO_LOCALE.test('return new Date(Date.UTC(y, m, 15)).toLocaleDateString(')
    ).toBe(false);
    expect(ARGUMENTLESS_INTL.test('new Intl.NumberFormat().format(1)')).toBe(true);
    expect(ARGUMENTLESS_INTL.test('Intl.DateTimeFormat().resolvedOptions().timeZone')).toBe(false);
    expect(ARGUMENTLESS_INTL.test('new Intl.NumberFormat(locale, { useGrouping: false })')).toBe(
      false
    );
  });

  /**
   * And that the SCANNER — walker, comment state and all — reports a planted
   * defect rather than only the regexes doing so.
   *
   * The two arms above test patterns against strings. This one drives the whole
   * path over a real file, so a walker that reached no files or a comment
   * skipper that swallowed every line would still be caught.
   */
  test('the scanner reports a planted defect, and not one written in prose', async () => {
    const probe = {
      path: resolve(import.meta.dir, 'fixtures/argumentless-format.txt'),
      name: 'probe',
    };
    const hits = await scan(ARGUMENTLESS_TO_LOCALE, [probe]);
    // Exactly the one on the code line. The fixture's comment says the same
    // words, and a scanner that counted 2 here is the SC-760 defect returning.
    expect(hits.map((hit) => hit.line)).toEqual([6]);
  });

  test('no date is formatted from the device locale', async () => {
    expect(format(await scan(ARGUMENTLESS_TO_LOCALE, files))).toEqual([]);
  });

  test('no Intl formatter is constructed without a locale', async () => {
    expect(format(await scan(ARGUMENTLESS_INTL, files))).toEqual([]);
  });
});
