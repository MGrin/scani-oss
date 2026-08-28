import type { Hit } from './source-scan';

/**
 * What counts as naming a physical edge on the inline axis (SC-773).
 *
 * The scanner was duplicated and so was this, and only one of the two halves
 * was protected. SC-760's comment-handling mutations are pinned, so a repair to
 * the scanner in one file and not another goes red. **Nothing pinned the RULE
 * SET.** A sixth pattern added to the v3 guard — `justify-start`, `scroll-ml-`,
 * `divide-l`, another inset spelling — silently did not reach `cloud` and
 * `admin`, and no test anywhere would have failed. That is the population
 * failing quietly one level up: not the file list, the rules applied to it.
 *
 * One list, iterated by every guard on this axis, so a rule added here arrives
 * everywhere the day it is written.
 *
 * `title` is the test name. It is part of the rule rather than written at the
 * call site so that two guards cannot describe the same rule differently — a
 * reader comparing two red builds should not have to work out whether
 * "no physical text alignment" and "no text-left/right" are the same check.
 */
export interface InlineAxisRule {
  title: string;
  pattern: RegExp;
  /** Matches that are legitimate on this axis and must not be reported. */
  except?: RegExp;
}

/**
 * Centring is the one honest use of a physical inset on this axis.
 *
 * `left-1/2` paired with `-translate-x-1/2` is symmetric: it names a physical
 * edge and then cancels it, so it renders identically in both directions and
 * has no logical spelling that is any clearer. Tailwind has no `start-1/2` that
 * composes with a logical translate, and inventing one here would be a second
 * way to say the same thing.
 *
 * Matched against the LINE CONTENT rather than the file, so a file that centres
 * something does not get a blanket pass — a wrong `left-4` on ANOTHER line in
 * it is still caught.
 *
 * IT DOES NOT REACH INSIDE THE LINE, and the wording it replaces implied it
 * did. A second inset utility sharing the centring line is dropped with it, so
 * `left-1/2 left-4` reports nothing. Narrow — only this rule carries the
 * exemption, so a `ml-2` there is still caught by the margin rule — and pinned
 * both ways in `source-scan.test.ts` rather than described. Read that test
 * before widening this: an exemption is the one edit that makes a guard
 * quieter, and quieter reads exactly like passing.
 */
export const CENTRING = /(?:^|\s)(?:-?left-(?:1\/2|\[50%\]))(?=\s|'|"|`)/;

export const PHYSICAL_INLINE_RULES: readonly InlineAxisRule[] = [
  {
    title: 'no physical inline margin or padding utilities',
    pattern: /(?:^|[\s'"`:[])-?(?:ml|mr|pl|pr)-(?:\w|\[)/,
  },
  {
    title: 'no physical text alignment',
    pattern: /\btext-(?:left|right)\b/,
  },
  {
    title: 'no physical inline borders or corner radii',
    pattern: /(?:^|[\s'"`:[])(?:border-[lr]|rounded-(?:[lr]|tl|tr|bl|br))(?:-|\b)/,
  },
  {
    title: 'no physical float',
    pattern: /\bfloat-(?:left|right)\b/,
  },
  {
    // The rule most likely to be met by somebody adding a badge or a close
    // button, so a failure has to say what to write instead — `start-`/`end-`.
    title: 'no physical inline insets except symmetric centring',
    pattern: /(?:^|[\s'"`:[])-?(?:left|right)-(?:\w|\[)/,
    except: CENTRING,
  },
] as const;

/** The hits a rule actually reports, once its legitimate matches are removed. */
export function violations(rule: InlineAxisRule, hits: readonly Hit[]): Hit[] {
  const except = rule.except;
  return except ? hits.filter((hit) => !except.test(hit.text)) : [...hits];
}

/**
 * Every rule as one pattern, for callers testing a snippet rather than a tree.
 *
 * Built from the list rather than written out, so the pinned comment-handling
 * mutations exercise the rules that actually ship. A hand-copied union is how
 * the mutations would go on passing after somebody edits a rule above.
 */
export const anyPhysicalInline = (): RegExp =>
  new RegExp(PHYSICAL_INLINE_RULES.map((rule) => rule.pattern.source).join('|'));
