import { describe, expect, test } from 'bun:test';
import {
  anyPhysicalInline,
  CENTRING,
  PHYSICAL_INLINE_RULES,
  violations,
} from './physical-inline-rules';
import { commentSkipper } from './source-scan';

/**
 * The scanner's own comment handling, pinned — because widening an exclusion is
 * the one edit that makes a check quieter, and a quieter check reads exactly
 * like a passing one.
 *
 * These three cases were run by hand as mutations first (a real `ml-2` in code,
 * a real `left-4` on the line after a block comment, and a comment stuffed with
 * physical utilities). They were pinned in each guard that carried a copy of
 * the scanner, which is what made the copies proven rather than assumed. There
 * is one implementation now (SC-773), so they are pinned once, here, beside it.
 */
describe('the scanner reads code and not prose', () => {
  const classify = (snippet: string): number[] => {
    const skip = commentSkipper();
    const physical = anyPhysicalInline();
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
 * Every rule, with the markup it must catch and the logical spelling it must
 * leave alone.
 *
 * The second half is the one that matters. A rule that reports everything makes
 * the guard useless in a way a green build never shows: the guards using this
 * list assert an EMPTY result, so an over-broad pattern reds against real code
 * and the cheapest way to clear it is to loosen the rule that just fired.
 */
const EXAMPLES: Record<string, { physical: string; logical: string }> = {
  'no physical inline margin or padding utilities': {
    physical: '<span className="ml-2 pr-3" />',
    logical: '<span className="ms-2 pe-3" />',
  },
  'no physical text alignment': {
    physical: '<td className="text-right" />',
    logical: '<td className="text-end" />',
  },
  'no physical inline borders or corner radii': {
    physical: '<div className="border-l rounded-tr-md" />',
    logical: '<div className="border-s rounded-se-md" />',
  },
  'no physical float': {
    physical: '<img className="float-left" />',
    logical: '<img className="float-start" />',
  },
  'no physical inline insets except symmetric centring': {
    physical: '<button className="right-4" />',
    logical: '<button className="end-4" />',
  },
};

describe('the physical-inline rule set', () => {
  /**
   * A rule added without a worked example fails here rather than shipping
   * unproven. This is the drift SC-773 exists for, one level up: the list is
   * now single-sourced, so the remaining way to weaken it is to append a rule
   * nobody has demonstrated either half of.
   */
  test('every rule carries a worked example', () => {
    expect(PHYSICAL_INLINE_RULES.map((rule) => rule.title).sort()).toEqual(
      Object.keys(EXAMPLES).sort()
    );
  });

  for (const rule of PHYSICAL_INLINE_RULES) {
    test(`${rule.title} — catches the physical form, permits the logical one`, () => {
      const example = EXAMPLES[rule.title];
      if (!example) throw new Error(`no example for ${rule.title}`);
      const hit = (text: string) =>
        violations(rule, rule.pattern.test(text) ? [{ file: 'x', line: 1, text }] : []);
      expect(hit(example.physical)).toHaveLength(1);
      expect(hit(example.logical)).toEqual([]);
    });
  }

  /**
   * The exemption, and the exact width of it.
   *
   * The two spellings the tree actually uses are exempt. The pattern requires a
   * line start or whitespace before the utility, so centring written as the
   * FIRST class in an attribute would not be exempt — unreachable rather than
   * merely rare, since the utility does nothing without a positioning class and
   * both occurrences in the scanned roots carry one (`fixed` in `dialog.tsx`,
   * `absolute` in `PullToRefresh.tsx`).
   *
   * **THE EXCLUSION IS PER LINE, AND THE v3 GUARD'S DOCBLOCK OVERSTATES IT.**
   * It says the hits are listed by "FILE AND LINE CONTENT rather than by file
   * alone, so that adding a genuinely wrong `left-4` to one of these files is
   * still caught". True across FILES and false within a LINE: `violations()`
   * drops any hit whose line matches `CENTRING`, so a second inset utility
   * sharing that line goes unreported. Pinned below as it behaves, not as that
   * sentence reads.
   *
   * Narrow, and left alone deliberately — SC-773 is behaviour-neutral by
   * construction, and widening or narrowing an exemption is the edit that makes
   * a guard quieter. Only the INSET rule carries this exemption, so a `ml-2` on
   * the same line is still caught by the margin rule.
   */
  test('symmetric centring is exempt, per line, for its own rule only', () => {
    const inset = PHYSICAL_INLINE_RULES.find((rule) => rule.except === CENTRING);
    if (!inset) throw new Error('the centring exemption is no longer attached to a rule');
    const hits = (rule: typeof inset, text: string) =>
      violations(rule, rule.pattern.test(text) ? [{ file: 'x', line: 1, text }] : []);

    expect(hits(inset, "'absolute left-1/2 -translate-x-1/2 z-50 transition-all'")).toEqual([]);
    expect(hits(inset, "'fixed left-[50%] top-[50%] z-50 translate-x-[-50%]'")).toEqual([]);

    // A line with no centring on it is caught as normal.
    expect(hits(inset, '<div className="absolute left-4" />')).toHaveLength(1);

    // ...but sharing the centring line hides it. This is the overstatement.
    expect(hits(inset, '<div className="absolute left-1/2 left-4" />')).toEqual([]);

    // The exemption belongs to one rule, so another rule still fires there.
    const margin = PHYSICAL_INLINE_RULES.find((rule) => rule.title.includes('margin or padding'));
    if (!margin) throw new Error('the margin rule has been renamed');
    expect(hits(margin, '<div className="absolute left-1/2 ml-2" />')).toHaveLength(1);
  });
});
