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
