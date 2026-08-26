import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  committedShareOfObserved,
  Decimal,
  observedRunwayMonths,
  runwayDenominator,
} from '@scani/shared';

const SOURCE = readFileSync(
  path.resolve(import.meta.dir, '../../../src/v3/components/home/RunwayLine.tsx'),
  'utf8'
);

/**
 * The destination. Read here because SC-661's claim is about the PAIR: a link
 * is only honest while the page it points at answers the same question, and a
 * test that reads only the origin cannot see that half.
 */
const FORECAST_SOURCE = readFileSync(
  path.resolve(import.meta.dir, '../../../src/v3/components/money/ForecastView.tsx'),
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
  test('neither surface does its own division', () => {
    // SC-661 widened this from RunwayLine alone. The division moved into
    // `@scani/shared` because the forecast page answers the same question, and
    // two surfaces doing their own arithmetic is precisely how they came to
    // disagree about the same account at the same instant.
    expect(SOURCE).toContain('observedRunwayMonths(');
    expect(FORECAST_SOURCE).toContain('observedRunwayMonths(');
    // The PERCENTAGE too. It was duplicated inline on both surfaces in the
    // first cut of this ticket -- the same shape as the runway drift, caught
    // by reading the diff rather than by two figures disagreeing in front of
    // somebody, which is how the runway one was found.
    expect(SOURCE).toContain('committedShare(');
    expect(FORECAST_SOURCE).toContain('committedShare(');

    // The shapes a re-inlined computation would take, on either surface.
    for (const source of [SOURCE, FORECAST_SOURCE]) {
      expect(source).not.toMatch(/dividedBy\(\s*perMonth\s*\)/);
      expect(source).not.toMatch(/perMonthMean[^\n]*dividedBy\(/);
      expect(source).not.toContain('committedShareOfObserved(');
      expect(source).not.toMatch(/reduce\([^\n]*point\.outflow/);
    }
  });

  /**
   * SC-661. The observed branch links to the forecast page AGAIN, and the
   * destination answers the same way.
   *
   * SC-657 pinned the opposite, correctly: `ForecastView` projected the
   * committed recurring book, and the two surfaces reached OPPOSITE
   * conclusions -- measured 2026-08-26, this line read "About 27 months at
   * recent spending" while the page read "Lasts beyond 12 months, the book
   * nets +£8,907.62 a month". A link asserts the destination elaborates what
   * you tapped, so it was removed.
   *
   * ## Inverted and widened rather than deleted
   *
   * That test's own doc said SC-661 "deletes this test along with the
   * restriction". Deleting it would leave the restored link with no coverage
   * at all, and the next person to remove it -- for a good reason or a bad one
   * -- would meet nothing.
   *
   * **The second assertion is the one that matters.** A link test alone passes
   * again the moment somebody re-points `ForecastView` at the committed
   * projection, which is exactly the state this ticket fixed: the link would
   * survive and the contradiction would come back under it.
   */
  test('the observed branch links to a forecast page that answers from observed', () => {
    const start = SOURCE.indexOf('if (observedAnswer) {');
    const end = SOURCE.indexOf('if (!answer) return null;');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const observedBranch = SOURCE.slice(start, end);
    expect(observedBranch).toContain('V3_ROUTES.forecast');
    expect(observedBranch).toContain('<Link');

    // The half a link test cannot see: the destination's HERO figure is the
    // observed one. `observedMonths` gates the runway tile there, so a page
    // that went back to leading with `runway(runwayProjection)` fails here.
    expect(FORECAST_SOURCE).toContain("t('v3.money.forecast.observedRunway'");
    expect(FORECAST_SOURCE).toMatch(/observedMonths !== null \?[\s\S]{0,120}observedRunway/);
  });

  /**
   * SC-661's fourth finding, and the one no number would have shown.
   *
   * `RunwayLine`'s observed path has no `movements` guard -- it needs only a
   * non-zero burn. `ForecastView` used to bail to the empty state on
   * `movements.length === 0` alone, so an account with perimeter exits and no
   * recurring payments got a runway on the home screen and "no payments
   * recorded, add one" on the page it linked to. The two screens disagreed
   * about whether the feature existed, which is worse than disagreeing about a
   * figure.
   */
  test('the forecast page does not claim emptiness while home answers', () => {
    // The observed branch deliberately has NO movements guard, so somebody
    // "fixing" the asymmetry from the wrong end -- adding one here rather than
    // relaxing the page -- would silence the home line instead of answering on
    // the page. Sliced rather than regex-bounded so it cannot pass vacuously.
    const observedMemo = SOURCE.slice(
      SOURCE.indexOf('const observedAnswer = useMemo('),
      SOURCE.indexOf('const answer = useMemo(')
    );
    expect(observedMemo.length).toBeGreaterThan(200);
    expect(observedMemo).not.toContain('movements.length === 0');
    // Control: the committed fallback below it DOES carry that guard, so a
    // source file that simply stopped mentioning movements fails here.
    expect(SOURCE.slice(SOURCE.indexOf('const answer = useMemo('))).toContain(
      'movements.length === 0'
    );
    // The bail-out must be conjoined with "and observed cannot answer either".
    expect(FORECAST_SOURCE).toContain('forecast.movements.length === 0 && observedMonths === null');
    // Control: the bare form is what the bug was, so it must be absent.
    expect(FORECAST_SOURCE).not.toMatch(/if \(!forecast \|\| forecast\.movements\.length === 0\)/);
  });

  /**
   * The specific shapes that would reintroduce the bug. Not a general ban on
   * `+` — that would fire on unrelated arithmetic and get deleted.
   */
  test('nothing sums the two figures, on either surface', () => {
    // SC-661 widened this from RunwayLine alone, and the forecast page is now
    // the LARGER risk: it holds both figures, it is where a "total burn" line
    // would look most at home, and until this ticket it was outside the ban.
    for (const source of [SOURCE, FORECAST_SOURCE]) {
      expect(source).not.toMatch(/perMonthMean[^\n]*\.plus\(/);
      expect(source).not.toMatch(/\.plus\([^\n)]*committed/i);
      expect(source).not.toMatch(/committed[^\n]*\.plus\([^\n)]*observed/i);
    }
  });

  /**
   * A zero observed burn is "this window cannot answer", not "forever".
   * `liquid ÷ 0` is Infinity, and an infinite runway on the one screen the
   * owner scans is the most flattering possible way to be wrong.
   */
  test('a zero observed burn does not become an infinite runway', () => {
    // SC-661 moved this guard into `@scani/shared`, so it is asserted on the
    // helper rather than by grepping for `lessThanOrEqualTo(0)` in a component
    // that no longer divides. The property is unchanged and now covers both
    // surfaces at once.
    expect(runwayDenominator('0').isZero()).toBe(true);
    expect(observedRunwayMonths('112703.12', '0')).toBeNull();
    expect(observedRunwayMonths('112703.12', '-5')).toBeNull();
    // Control: a real burn still answers, so the nulls above are the guard
    // firing and not the helper refusing everything.
    expect(observedRunwayMonths('112703.12', '14087.89')).toBe(8);

    // And both callers must branch on that null rather than render it.
    expect(SOURCE).toContain('if (months === null) return null;');
    expect(FORECAST_SOURCE).toContain('observedMonths !== null');
  });

  test('the numbers it renders are the ones the pin describes', () => {
    const liquid = new Decimal('200000');
    const months = liquid.dividedBy(runwayDenominator('20000')).floor().toNumber();
    expect(months).toBe(10);

    const share = committedShareOfObserved('15000', '20000');
    expect((share as Decimal).times(100).toFixed(0)).toBe('75');
  });
});
