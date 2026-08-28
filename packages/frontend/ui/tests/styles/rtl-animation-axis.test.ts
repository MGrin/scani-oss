import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import preset from '../../tailwind-preset.js';

/**
 * A KEYFRAME IS NOT A LOGICAL PROPERTY, AND NO GUARD HERE HAD A TERM FOR ONE
 * (SC-766, SC-767, SC-768).
 *
 * SC-760 converted 166 physical utilities in v3 and `@scani/ui` to logical
 * ones and left three animation defects standing. That is not an oversight in
 * the sweep — `transform: translateX(-100%)` means the same displacement in
 * Arabic as in English, so an animation that was right under LTR became the
 * one thing on a mirrored page moving against the reading direction, with the
 * markup around it already correct. The two halves then disagree, which reads
 * as a glitch rather than as an unconverted layout.
 *
 * MEASURED, because "the existing guard could not have caught it" is the kind
 * of claim that is easier to assert than to check. All five predicates in
 * `apps/frontend/app/tests/v3/rtl-logical-properties.test.ts` were run against
 * the three subjects, with both of that file's own must-be-FOUND controls
 * beside them:
 *
 *     SC-766  '0%': { transform: 'translateX(-100%)' }        none of 5
 *     SC-767  data-[state=closed]:slide-out-to-right-full     none of 5
 *     SC-768  from: { transform: 'translateX(100%)' }         none of 5
 *     control <span className="ml-2" />                       margin/padding
 *     control <span className="left-4" />                     inset
 *
 * So the machinery works and simply has no term for animation. And the three
 * failed for TWO different reasons, which is why one new predicate would not
 * have been enough:
 *
 *   POPULATION — `tailwind-preset.js` is a `.js` file sitting one level ABOVE
 *     `packages/frontend/ui/src`. That scan's `walk()` takes `.ts`/`.tsx` only
 *     and is rooted at `src`, so the preset is outside it twice over. Every
 *     keyframe this repo ships is unobserved by every text scan it has.
 *   PREDICATE — `toast.tsx` IS in that population. `slide-out-to-right-full`
 *     was read, matched nothing, and reported clean.
 *
 * The `Sheet` is pinned in that file, but by an exact four-`toContain` check
 * on one path. A whitelist naming one file cannot report a second file that
 * never had the pair, which is exactly what `toast.tsx` was.
 *
 * WHAT THIS FILE IS NOT. It does not establish that anything mirrors. Only the
 * `dir=rtl` pass in `apps/e2e/visual` does that, and it photographs the
 * SETTLED state, so it cannot see a sweep either — which is how all three of
 * these survived a ticket that added three RTL baselines. An animation is a
 * thing you have to watch. This is the cheaper instrument beside both: it
 * stops the fourth one arriving in a file nobody screenshots.
 */

/* -------------------------------------------------------------------------- */
/* Population A — the preset                                                   */
/* -------------------------------------------------------------------------- */

type Declarations = Record<string, unknown>;
type Keyframe = Record<string, Declarations>;

/**
 * Reach into the preset LOUDLY. `theme.extend` is optional in Tailwind's type,
 * and a `?? {}` here would make every absence claim below true over an empty
 * object — the preset failing to load and the preset being clean would read
 * identically. The denominator test catches that too; this makes it a thrown
 * error naming the key rather than a puzzling zero.
 */
function extendKey<T>(key: 'keyframes' | 'animation'): Record<string, T> {
  const value = preset.theme?.extend?.[key];
  if (!value) throw new Error(`tailwind-preset.js has no theme.extend.${key}`);
  return value as Record<string, T>;
}

const keyframes = extendKey<Keyframe>('keyframes');
const animations = extendKey<string>('animation');

/**
 * Read the STRUCTURE, not the text. `tailwind-preset.js` is a real module and
 * importing it gives real objects, so a reformat, a trailing comma or a
 * comment mentioning `translateX` cannot move this number in either direction.
 */
function inlineOffsets(frames: Keyframe): string[] {
  const out: string[] = [];
  for (const step of Object.values(frames)) {
    for (const value of Object.values(step)) {
      for (const match of String(value).matchAll(/translateX\(([^)]*)\)/g)) {
        out.push((match[1] ?? '').trim());
      }
    }
  }
  return out;
}

/** `translateX(0)` is a declaration, not a displacement. */
const movesOnInlineAxis = (frames: Keyframe): boolean =>
  inlineOffsets(frames).some((offset) => Number.parseFloat(offset) !== 0);

const unit = (offset: string): string => offset.replace(/^[+-]?[\d.]+/, '');

const isNegationOf = (a: string, b: string): boolean =>
  unit(a) === unit(b) && Number.parseFloat(a) === -Number.parseFloat(b);

/**
 * Every keyframe that displaces on the inline axis, and the counterpart it
 * owes. A name ending `-rtl` IS a counterpart and owes nothing further —
 * without that clause the rule demands `loading-bar-rtl-rtl` and recurses.
 */
function unpairedKeyframes(all: Record<string, Keyframe>, registered: Record<string, string>) {
  const findings: string[] = [];
  for (const [name, frames] of Object.entries(all)) {
    if (!movesOnInlineAxis(frames)) continue;
    if (name.endsWith('-rtl')) {
      const base = name.slice(0, -'-rtl'.length);
      if (!all[base]) findings.push(`keyframe \`${name}\` has no base \`${base}\``);
      continue;
    }
    const counterpart = `${name}-rtl`;
    if (!all[counterpart]) {
      findings.push(
        `keyframe \`${name}\` displaces on the inline axis with no \`${counterpart}\` counterpart`
      );
      continue;
    }
    if (!registered[counterpart]) {
      findings.push(`keyframe \`${counterpart}\` exists but is not registered under \`animation\``);
      continue;
    }
    const base = inlineOffsets(frames);
    const mirror = inlineOffsets(all[counterpart]);
    if (base.length !== mirror.length) {
      findings.push(
        `\`${counterpart}\` has ${mirror.length} inline offsets against \`${name}\`'s ${base.length}`
      );
      continue;
    }
    base.forEach((offset, index) => {
      const mirrored = mirror[index] ?? '';
      if (!isNegationOf(offset, mirrored)) {
        findings.push(
          `\`${counterpart}\` step ${index} is \`${mirrored}\`, not the negation of \`${name}\`'s \`${offset}\``
        );
      }
    });
  }
  return findings;
}

describe('every inline-axis keyframe in the preset has a mirrored counterpart', () => {
  /**
   * The denominator. Every assertion below is an absence claim, and an absence
   * over an empty object is true for the wrong reason — a renamed `extend` key
   * or a preset that failed to load would turn this whole block green while
   * checking nothing.
   */
  test('the preset exposes keyframes and animations to scan', () => {
    expect(Object.keys(keyframes).length).toBeGreaterThan(5);
    expect(Object.keys(animations).length).toBeGreaterThan(5);
  });

  /**
   * The must-be-FOUND control on the population itself. A rule about inline
   * displacement is vacuous over a preset that has none, and this repo's
   * preset could plausibly have none — that is the state SC-768 left it one
   * deletion away from.
   */
  test('at least one keyframe actually displaces on the inline axis', () => {
    const moving = Object.entries(keyframes).filter(([, frames]) => movesOnInlineAxis(frames));
    expect(moving.map(([name]) => name).sort()).toEqual(['loading-bar', 'loading-bar-rtl']);
  });

  test('no inline-axis keyframe is missing its mirror', () => {
    expect(unpairedKeyframes(keyframes, animations)).toEqual([]);
  });

  /**
   * Three mutations, run by hand first and kept here so they run every time.
   * The first two are the must-be-FOUND arms; the third is must-be-ABSENT, and
   * it is the one that matters — without it, a rule that flagged EVERY
   * keyframe would pass both found-arms and report the block axis as broken.
   * A false red here says "your fade-in is wrong under RTL", which is a remedy
   * somebody would plausibly act on.
   */
  test('the rule fires on an unpaired inline keyframe, and not on a block-axis one', () => {
    const unpaired = { drift: { '0%': { transform: 'translateX(40%)' } } };
    expect(unpairedKeyframes(unpaired, {})).toHaveLength(1);

    const wrongDirection = {
      drift: { '0%': { transform: 'translateX(40%)' } },
      'drift-rtl': { '0%': { transform: 'translateX(40%)' } },
    };
    expect(unpairedKeyframes(wrongDirection, { 'drift-rtl': 'drift-rtl 1s' })).toHaveLength(1);

    const blockAxis = {
      'fade-in': { from: { opacity: 0 }, to: { opacity: 1 } },
      rise: { from: { transform: 'translateY(10px)' }, to: { transform: 'translateY(0)' } },
      still: { from: { transform: 'translateX(0)' } },
    };
    expect(unpairedKeyframes(blockAxis, {})).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Population B — the sources                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The same two roots the SC-760 scan uses, and for the same stated reason: the
 * shadcn primitives every v3 surface is built from live in
 * `packages/frontend/ui/src/ui`, one level above the `v3` subtrees. `Sheet` and
 * `Toast` between them account for every inline-axis slide in this repo, and a
 * scan narrowed to `v3` would see neither.
 */
const ROOTS = [
  resolve(import.meta.dir, '../../src'),
  resolve(import.meta.dir, '../../../../../apps/frontend/app/src/v3'),
] as const;

interface Source {
  path: string;
  name: string;
}

function walk(dir: string, out: Source[]): Source[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)) {
      out.push({ path, name: relative(resolve(import.meta.dir, '../../../../..'), path) });
    }
  }
  return out;
}

const sources = (): Source[] =>
  ROOTS.flatMap((root) => walk(root, [])).sort((a, b) => a.name.localeCompare(b.name));

/**
 * Prose about a utility is not a use of it, and this rule cannot be documented
 * without writing the forbidden strings down — `toast.tsx` and
 * `JobDetailHeader.tsx` both now carry a comment naming the exact utility they
 * pair. That is not an edge case: the files a guard most needs to be right
 * about are the ones explaining why the guard exists (SC-760, whose first cut
 * went red on its own author's sentence).
 *
 * STATEFUL, for the reason that ticket paid for: a per-line test catches `//`,
 * ` *` and the OPENING line of a `/*` or `{/*` block, and misses every
 * CONTINUATION line, because those begin with an ordinary word.
 *
 * Deliberately a local copy rather than an import from
 * `apps/frontend/app/tests/v3/`. This package sits BELOW that app, so reaching
 * up into its test tree inverts the dependency direction the workspace layout
 * exists to enforce. Other guards in this repo still carry per-line copies
 * with the bug SC-760 fixed here; SC-776 names them, dates the reading and
 * carries the falsifier. Deliberately a POINTER and not a list: a ticket is
 * allowed to be a snapshot and this docblock is not, and a count asserted in
 * a comment goes stale the moment one of them is fixed — silently, since
 * nothing compiles prose.
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
    if (line.includes('/*') && !line.includes('*/')) inBlock = true;
    return true;
  };
}

/**
 * What counts as inline-axis motion, derived rather than listed.
 *
 * `tailwindcss-animate`'s `slide-in-from-*` / `slide-out-to-*` set a physical
 * `--tw-enter-translate-x`; the `animate-*` half is read out of the preset
 * above, so a keyframe added tomorrow is covered the day it is written without
 * anybody updating a list here.
 */
const physicalAnimations = (): string[] =>
  Object.entries(keyframes)
    .filter(([, frames]) => movesOnInlineAxis(frames))
    .map(([name]) => name);

function inlineAxisPattern(): RegExp {
  const named = physicalAnimations()
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return new RegExp(`slide-(?:in-from|out-to)-(?:left|right)|(?:^|:)animate-(?:${named})$`);
}

type Verdict = 'rtl' | 'justified' | 'bare' | null;

/**
 * TWO BARE FORMS ARE CORRECT AS-IS, AND BOTH ARE TRUE BY CONSTRUCTION OF THE
 * CLASS NAME — this is not an exemption list somebody can append to.
 *
 * `data-[side=...]` follows the side Radix RESOLVED the content onto after
 * collision detection, which is a physical fact about the viewport in any
 * language. A popover pushed to the physical left should slide in from the
 * physical right whatever the reader's language, exactly as `Toast`'s swipe
 * utilities follow the pointer. Converting these would BREAK them. Applies to
 * `popover.tsx`, `select.tsx` and `tooltip.tsx`.
 *
 * A `1/2` or `[50%]` value is the centring case, and it is MEASURED rather
 * than argued. Compiling `dialog.tsx`'s classes through this repo's own
 * postcss+tailwind harness:
 *
 *     .translate-x-[-50%]        --tw-translate-x:       -50%
 *     .slide-in-from-left-1/2    --tw-enter-translate-x: -50%
 *     .slide-out-to-left-1/2     --tw-exit-translate-x:  -50%
 *     .slide-in-from-left-2      --tw-enter-translate-x: -0.5rem   (contrast)
 *
 * `tailwindcss-animate`'s enter keyframe REPLACES `transform` with
 * `translate3d(var(--tw-enter-translate-x), ...)`, so the animated X and the
 * resting X are the same `-50%`: the dialog does not move on the inline axis
 * at all. It is the animation-axis twin of the `left-1/2 -translate-x-1/2`
 * pair the SC-760 scan already exempts by name, and mirroring it would
 * introduce a sideways lurch that is not there today.
 */
function classify(token: string, pattern: RegExp): Verdict {
  if (!pattern.test(token)) return null;
  if (token.includes('rtl:')) return 'rtl';
  if (token.includes('data-[side=')) return 'justified';
  if (/-(?:1\/2|\[50%\])$/.test(token)) return 'justified';
  return 'bare';
}

interface FileVerdict {
  name: string;
  bare: string[];
  rtl: string[];
  justified: string[];
}

async function classifyFiles(files: Source[]): Promise<FileVerdict[]> {
  const pattern = inlineAxisPattern();
  const out: FileVerdict[] = [];
  for (const source of files) {
    const text = await Bun.file(source.path).text();
    out.push({ ...classifyText(text, pattern), name: source.name });
  }
  return out;
}

function classifyText(text: string, pattern: RegExp): Omit<FileVerdict, 'name'> {
  // One skipper per FILE: block state must not leak across files, or an
  // unterminated comment in one would blind the scanner to the next.
  const isComment = commentSkipper();
  const bare: string[] = [];
  const rtl: string[] = [];
  const justified: string[] = [];
  for (const line of text.split('\n')) {
    if (isComment(line)) continue;
    for (const token of line.split(/[\s'"`]+/)) {
      const verdict = classify(token, pattern);
      if (verdict === 'bare') bare.push(token);
      else if (verdict === 'rtl') rtl.push(token);
      else if (verdict === 'justified') justified.push(token);
    }
  }
  return { bare, rtl, justified };
}

/**
 * THE FLOOR, stated rather than left to be discovered. This pairs PER FILE, so
 * a file that already carries one `rtl:` counterpart and gains a second
 * unpaired utility passes. It is deliberately the coarser rule: the failure it
 * exists for is a component built with no RTL awareness at all — which is what
 * `toast.tsx` was, and what a new primitive copied in from shadcn will be —
 * and pairing per line would red on any class list wrapped across two.
 */
const unpairedFiles = (verdicts: FileVerdict[]): FileVerdict[] =>
  verdicts.filter((verdict) => verdict.bare.length > 0 && verdict.rtl.length === 0);

const report = (verdicts: FileVerdict[]): string[] =>
  verdicts.map(
    (verdict) =>
      `${verdict.name} — ${verdict.bare.join(', ')}. Pair it with an \`rtl:\` counterpart on ` +
      `the opposite edge, as sheet.tsx and toast.tsx do. If instead the motion follows a ` +
      `PHYSICAL quantity — the pointer, or the side Radix resolved onto — it is correct as-is ` +
      `and belongs behind \`data-[side=\`; say so at the call site. Do not delete it.`
  );

describe('inline-axis animation utilities are paired for RTL', () => {
  const files = sources();

  test('the scan has files to look at', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  /**
   * The must-be-FOUND control. Every assertion below reports zero, and a zero
   * from a scanner that cannot match is indistinguishable from a clean tree —
   * the whole reason SC-767 sat unreported under a green suite. This asserts
   * the real tree contains inline-axis motion the classifier can see, in all
   * three verdicts, so a green means "looked and found nothing wrong".
   */
  test('the classifier finds real inline-axis motion in all three verdicts', async () => {
    const verdicts = await classifyFiles(files);
    const total = (pick: (v: FileVerdict) => string[]) =>
      verdicts.reduce((sum, verdict) => sum + pick(verdict).length, 0);
    expect(total((v) => v.rtl)).toBeGreaterThan(0);
    expect(total((v) => v.justified)).toBeGreaterThan(0);
    expect(total((v) => v.bare)).toBeGreaterThan(0);
  });

  test('no file uses a bare inline-axis animation without an rtl: counterpart', async () => {
    expect(report(unpairedFiles(await classifyFiles(files)))).toEqual([]);
  });

  /**
   * Mutations, all four run by hand first. Arms 1 and 2 are must-be-FOUND;
   * arms 3 and 4 are must-be-ABSENT and are the ones protecting working code.
   * A guard that flagged `data-[side=` would send somebody to "fix" three
   * primitives whose animation is correct, with the guard's blessing — the
   * expensive kind of false positive, because its remedy is plausible.
   */
  test('the rule separates an unpaired file from the three legitimate forms', () => {
    const pattern = inlineAxisPattern();
    const check = (text: string) => unpairedFiles([{ ...classifyText(text, pattern), name: 'x' }]);

    // 1. SC-767 exactly, as toast.tsx stood before this ticket.
    expect(check(`cva('data-[state=closed]:slide-out-to-right-full')`)).toHaveLength(1);

    // 2. SC-766: an animate-* built on a preset keyframe that displaces on X.
    expect(check(`<div className="motion-safe:animate-loading-bar" />`)).toHaveLength(1);

    // 3. The paired form, and the two structurally-justified bare ones.
    expect(
      check(
        `cva('data-[state=closed]:slide-out-to-right-full rtl:data-[state=closed]:slide-out-to-left-full')`
      )
    ).toEqual([]);
    expect(check(`cva('data-[side=left]:slide-in-from-right-2')`)).toEqual([]);
    expect(check(`cva('data-[state=open]:slide-in-from-left-1/2')`)).toEqual([]);

    // 4. The block axis is not this rule's business and must never be flagged.
    expect(check(`cva('data-[state=open]:slide-in-from-top-full')`)).toEqual([]);
  });

  /**
   * The scanner reads code and not prose, on the same axis as SC-760's fix.
   * The must-be-FOUND half is the second arm: an exclusion that ran on past
   * `*\/` would silence the rest of a file and still report zero, which is a
   * quieter check that reads exactly like a passing one.
   */
  test('a block comment is prose all the way down, and stops at its delimiter', () => {
    const pattern = inlineAxisPattern();
    const prose = [
      '<span>',
      '  {/* Why this exists:',
      '      slide-out-to-right-full was wrong under RTL, and so was',
      '      animate-loading-bar. */}',
      '</span>',
    ].join('\n');
    expect(classifyText(prose, pattern).bare).toEqual([]);

    const resumes = [
      '  /* prose about slide-out-to-right-full',
      '     and more prose */',
      '  <span className="data-[state=closed]:slide-out-to-right-full" />',
    ].join('\n');
    expect(classifyText(resumes, pattern).bare).toEqual([
      'data-[state=closed]:slide-out-to-right-full',
    ]);
  });
});
