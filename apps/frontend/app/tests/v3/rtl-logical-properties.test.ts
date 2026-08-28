import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * The inline axis is decided by the reader's language, not by the author's
 * keyboard (SC-760).
 *
 * `<html dir>` has followed the chosen language since SC-201's first slice,
 * and until this ticket nothing under it was mirrored: v3 and `@scani/ui`
 * carried 166 physical `ml-`/`pr-`/`text-left`/`right-0` utilities, so an
 * Arabic reader would have got Arabic words in an English layout — legible
 * word by word and unreadable as a page.
 *
 * **This scan is not the verification, and must not be read as one.** SC-760
 * says so in as many words: a file with zero directional utilities left and a
 * file nobody checked read the same in a grep. What proves the layout mirrors
 * is the `dir=rtl` pass in `apps/e2e/visual`, against committed baselines.
 * This is the cheaper thing next to it — it stops the 167th utility arriving
 * six months from now in a file nobody screenshots, which is the only failure
 * a picture cannot catch because the picture would have to exist first.
 *
 * It is a text scan for the same reason `token-hygiene.test.ts` is one: the
 * defect is a class name that quietly means "physically left" instead of "the
 * edge the text starts at". Both render. Only one is right in two languages.
 */

/**
 * Both roots, and note this is deliberately NOT `helpers/v3-sources.ts`.
 *
 * That helper reads `apps/frontend/app/src/v3` and `packages/frontend/ui/src/v3`
 * — the v3 subtrees. The shadcn primitives every one of those surfaces is
 * built from live one level up, in `packages/frontend/ui/src/ui`, and so do
 * the two fixed banners in `src/components`. Sheet, Dialog, Toast, Select and
 * Alert between them accounted for more of this ticket's fixes than the whole
 * v3 subtree did, and a scan that could not see them would have reported a
 * clean tree over the drawer that opens on the wrong edge.
 *
 * So the population here is wider than the other three scans', on purpose. If
 * you are tidying this toward `v3Sources()`, that narrowing IS the defect.
 */
const ROOTS = [
  resolve(import.meta.dir, '../../src/v3'),
  resolve(import.meta.dir, '../../../../../packages/frontend/ui/src'),
] as const;

interface Source {
  path: string;
  name: string;
}

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
 * Prose about a class name is not a use of it, and several of this ticket's
 * fixes left a comment behind naming the utility they removed. Same rule, and
 * the same reason, as `token-hygiene.test.ts`.
 *
 * THIS IS STATEFUL, AND THE FIRST CUT WAS NOT — which cost a false red on the
 * gate. A per-line test catches `//`, ` *` and the OPENING line of a `/*` or
 * `{/*` block, and misses every CONTINUATION line of a JSX block comment,
 * because those begin with ordinary prose. The sentence
 *
 *     A number is written left-to-right in every locale
 *
 * is then read as code, and `left-to` matches the physical-inset pattern.
 *
 * That is not a curiosity here. These are the files where somebody explaining
 * WHY a rule exists has to write the words "left" and "right", so a scanner
 * that punishes the explanation is worst exactly where the explanation is most
 * needed. Rewording the one comment would have cleared the red and left the
 * trap armed for the next person.
 *
 * `blockDepth` tracks `/* ... *\/` across lines. A line that both opens and
 * closes is a comment and does not open a block.
 */
function commentSkipper(): (line: string) => boolean {
  let inBlock = false;
  return (line: string): boolean => {
    const trimmed = line.trimStart();
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      return true;
    }
    const startsComment =
      trimmed.startsWith('*') ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('{/*');
    if (!startsComment) return false;
    // Opens a block that this line does not close: everything until `*/` is prose.
    if (line.includes('/*') && !line.includes('*/')) inBlock = true;
    return true;
  };
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

async function scan(pattern: RegExp, files: Source[]): Promise<Hit[]> {
  const hits: Hit[] = [];
  for (const source of files) {
    const text = await Bun.file(source.path).text();
    // One skipper per FILE: the block state must not leak across files, or an
    // unterminated comment in one would blind the scanner to the next.
    const isComment = commentSkipper();
    text.split('\n').forEach((line, index) => {
      if (isComment(line) || !pattern.test(line)) return;
      hits.push({ file: source.name, line: index + 1, text: line.trim() });
    });
  }
  return hits;
}

const format = (hits: Hit[]): string[] =>
  hits.map((hit) => `${hit.file}:${hit.line} — ${hit.text}`);

/**
 * Centring is the one honest use of a physical inset on this axis.
 *
 * `left-1/2` paired with `-translate-x-1/2` is symmetric: it names a physical
 * edge and then cancels it, so it renders identically in both directions and
 * has no logical spelling that is any clearer. Tailwind has no `start-1/2`
 * that composes with a logical translate, and inventing one here would be a
 * second way to say the same thing.
 *
 * Listed by FILE AND LINE CONTENT rather than by file alone, so that adding a
 * genuinely wrong `left-4` to one of these files is still caught.
 */
const CENTRING = /(?:^|\s)(?:-?left-(?:1\/2|\[50%\]))(?=\s|'|"|`)/;

function withoutCentring(hits: Hit[]): Hit[] {
  return hits.filter((hit) => !CENTRING.test(hit.text));
}

describe('v3 and @scani/ui use logical properties on the inline axis', () => {
  const files = sources();

  /**
   * The denominator, asserted rather than assumed.
   *
   * Every test below is an ABSENCE claim, and an absence over an empty file
   * list is true for the wrong reason — a moved directory or a bad
   * `import.meta.dir` would turn this whole file green while checking nothing.
   * 300 is a floor well under the ~350 the two roots hold today, chosen so it
   * fails on a population that has collapsed rather than on one that shrank.
   */
  test('the scan has files to look at', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  /**
   * The must-be-FOUND control.
   *
   * The rules below all report zero, and a zero from a scanner that cannot
   * match is indistinguishable from a clean tree. This asserts the machinery
   * finds a pattern that is definitely present — `flex`, in a Tailwind
   * codebase — so a green above means "looked and found nothing" rather than
   * "did not look".
   */
  test('the scanner can find something that is there', async () => {
    expect((await scan(/\bflex\b/, files)).length).toBeGreaterThan(50);
  });

  test('no physical inline margin or padding utilities', async () => {
    const physical = /(?:^|[\s'"`:[])-?(?:ml|mr|pl|pr)-(?:\w|\[)/;
    expect(format(await scan(physical, files))).toEqual([]);
  });

  test('no physical text alignment', async () => {
    expect(format(await scan(/\btext-(?:left|right)\b/, files))).toEqual([]);
  });

  test('no physical inline borders or corner radii', async () => {
    const physical = /(?:^|[\s'"`:[])(?:border-[lr]|rounded-(?:[lr]|tl|tr|bl|br))(?:-|\b)/;
    expect(format(await scan(physical, files))).toEqual([]);
  });

  test('no physical float', async () => {
    expect(format(await scan(/\bfloat-(?:left|right)\b/, files))).toEqual([]);
  });

  /**
   * Insets, minus centring. This is the rule most likely to be met by someone
   * adding a badge or a close button, so the message has to say what to write
   * instead — `start-`/`end-` — rather than only what is wrong.
   */
  test('no physical inline insets except symmetric centring', async () => {
    const physical = /(?:^|[\s'"`:[])-?(?:left|right)-(?:\w|\[)/;
    const hits = withoutCentring(await scan(physical, files));
    expect(format(hits)).toEqual([]);
  });
});

/**
 * The scanner's own comment handling, pinned — because widening an exclusion is
 * the one edit that makes a check quieter, and a quieter check reads exactly
 * like a passing one.
 *
 * These three cases were run by hand as mutations first (a real `ml-2` in code,
 * a real `left-4` on the line after a block comment, and a comment stuffed with
 * physical utilities). They are here so they run every time instead of once.
 */
describe('the scanner reads code and not prose', () => {
  const classify = (snippet: string): number[] => {
    const skip = commentSkipper();
    const physical =
      /(?:^|[\s'"`:[])-?(?:left|right)-(?:\w|\[)|(?:^|[\s'"`:[])-?(?:ml|mr|pl|pr)-(?:\w|\[)/;
    const hits: number[] = [];
    snippet.split('\n').forEach((line, i) => {
      if (skip(line) || !physical.test(line)) return;
      hits.push(i + 1);
    });
    return hits;
  };

  test('a JSX block comment is prose all the way down, not just on line one', () => {
    // Line 3 is the case that broke the gate: a continuation line begins with an
    // ordinary word, so a per-line test sees code, and `left-to` matches.
    const snippet = [
      '<span>',
      '  {/* Why this exists:',
      '      A number is written left-to-right in every locale, and ml-2 is wrong.',
      '      Nor should left-4 right-4 pr-3 here count. */}',
      '</span>',
    ].join('\n');
    expect(classify(snippet)).toEqual([]);
  });

  test('and it stops being prose at the closing delimiter', () => {
    // The must-be-FOUND control on the same axis. An exclusion that ran on past
    // `*/` would silence the rest of the file and still report zero.
    const snippet = [
      '  {/* prose about left-to-right',
      '      and more prose */}',
      '  <span className="ml-2" />',
      '  <span className="left-4" />',
    ].join('\n');
    expect(classify(snippet)).toEqual([3, 4]);
  });

  test('a single-line comment does not open a block', () => {
    const snippet = ['  /* one-liner about left-to-right */', '  <span className="pr-3" />'].join(
      '\n'
    );
    expect(classify(snippet)).toEqual([2]);
  });
});

/**
 * The Sheet's two inline sides, pinned (SC-760).
 *
 * `start`/`end` anchor and border with logical utilities, which need no help.
 * The slide does: `slide-in-from-*` comes from tailwindcss-animate and sets a
 * physical `--tw-enter-translate-x`, so each side carries an `rtl:` pair that
 * wins on specificity under an RTL document.
 *
 * Dropping either pair leaves a panel anchored at one edge and sliding in from
 * the other — which type-checks, lints, renders, and is invisible to every
 * scan above, because the remaining classes are all perfectly logical. It is
 * only visible to someone watching the animation in an RTL document, and the
 * visual gate photographs the *settled* state.
 */
describe('the Sheet slides in from the edge it is anchored to', () => {
  const SHEET = resolve(import.meta.dir, '../../../../../packages/frontend/ui/src/ui/sheet.tsx');

  test('both inline sides carry an rtl: animation pair', async () => {
    const text = await Bun.file(SHEET).text();

    // Non-empty, so a moved or unreadable file cannot satisfy the four
    // `toContain`s below by having no content to contradict them.
    expect(text.length).toBeGreaterThan(1000);

    for (const cls of [
      'rtl:data-[state=open]:slide-in-from-right',
      'rtl:data-[state=closed]:slide-out-to-right',
      'rtl:data-[state=open]:slide-in-from-left',
      'rtl:data-[state=closed]:slide-out-to-left',
    ]) {
      expect(text).toContain(cls);
    }
  });

  /**
   * And that the sides are named for reading order rather than for the screen.
   * A `left`/`right` variant made logical would be a label that is false under
   * `dir="rtl"` — the value right and every reader of the name wrong.
   */
  test('the inline variants are named start and end', async () => {
    const text = await Bun.file(SHEET).text();
    expect(text).toContain('start:');
    expect(text).toContain('end:');
    expect(text).not.toMatch(/^\s+left:/m);
    expect(text).not.toMatch(/^\s+right:/m);
  });
});
