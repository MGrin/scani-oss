import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { committedShareOfObserved, Decimal, runwayDenominator } from '@scani/shared';

const SOURCE = readFileSync(
  path.resolve(import.meta.dir, '../../../src/v3/components/home/RunwayLine.tsx'),
  'utf8'
);

/**
 * SC-657. The home-screen runway is `liquid ÷ observed`, and `committed` is a
 * SHARE of that — never a second addend.
 *
 * mgrin's recurring payments are paid out of the untracked current accounts,
 * so by the time one happens that money has already left the tracked
 * perimeter: it left when he moved it, and that move is already inside
 * `observed`. Adding them roughly doubles the burn and halves the runway.
 *
 * The arithmetic itself is pinned in `@scani/shared` (`lib/burn.ts` and its
 * test). What is pinned HERE is the wiring, because this file is where the
 * mistake would actually be written — two numbers on one line, and a
 * plausible-looking "total burn" a screen away.
 */
describe('SC-657 — the home runway divides by observed alone', () => {
  test('it goes through runwayDenominator rather than doing its own division', () => {
    expect(SOURCE).toContain('runwayDenominator(');
    expect(SOURCE).toContain('committedShareOfObserved(');
  });

  /**
   * SC-657 / SC-661. The observed branch must NOT link to the forecast page.
   *
   * `ForecastView` still projects the committed recurring book, and on the
   * demo persona the two surfaces reach OPPOSITE conclusions -- measured
   * 2026-08-26: this line rendered "About 27 months at recent spending" while
   * the forecast page rendered "Lasts beyond 12 months · the book nets
   * +£8,907.62 a month". A link asserts the destination elaborates what you
   * tapped; pointing one at a page that contradicts it is worse than no link.
   *
   * This is pinned rather than commented because restoring the link is a
   * one-word edit that looks like an obvious improvement -- a missing
   * navigation affordance reads as an oversight, and nothing about the diff
   * would reveal that the destination disagrees. SC-661 reconciles the two
   * surfaces and deletes this test along with the restriction.
   */
  test('the observed branch does not link to the still-committed forecast page', () => {
    const start = SOURCE.indexOf('if (observedAnswer) {');
    const end = SOURCE.indexOf('if (!answer) return null;');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const observedBranch = SOURCE.slice(start, end);
    // The control: the committed FALLBACK below still links, so a source file
    // that simply stopped mentioning the route would pass this vacuously.
    expect(SOURCE.slice(end)).toContain('V3_ROUTES.forecast');
    expect(observedBranch).not.toContain('V3_ROUTES.forecast');
    expect(observedBranch).not.toContain('<Link');
  });

  /**
   * The specific shapes that would reintroduce the bug. Not a general ban on
   * `+` — that would fire on unrelated arithmetic and get deleted.
   */
  test('nothing sums the two figures', () => {
    expect(SOURCE).not.toMatch(/perMonthMean[^\n]*\.plus\(/);
    expect(SOURCE).not.toMatch(/\.plus\([^\n)]*committed/i);
    expect(SOURCE).not.toMatch(/committed[^\n]*\.plus\([^\n)]*observed/i);
  });

  /**
   * A zero observed burn is "this window cannot answer", not "forever".
   * `liquid ÷ 0` is Infinity, and an infinite runway on the one screen the
   * owner scans is the most flattering possible way to be wrong.
   */
  test('a zero observed burn does not become an infinite runway', () => {
    expect(SOURCE).toContain('lessThanOrEqualTo(0)');
    expect(runwayDenominator('0').isZero()).toBe(true);
  });

  test('the numbers it renders are the ones the pin describes', () => {
    const liquid = new Decimal('200000');
    const months = liquid.dividedBy(runwayDenominator('20000')).floor().toNumber();
    expect(months).toBe(10);

    const share = committedShareOfObserved('15000', '20000');
    expect((share as Decimal).times(100).toFixed(0)).toBe('75');
  });
});
