import { describe, expect, test } from 'bun:test';
import {
  committedShareOfObserved,
  observedAffordability,
  observedRunwayMonths,
  runwayDenominator,
} from '@scani/shared';
import Decimal from 'decimal.js';

/**
 * SC-657. The two burn figures are NOT additive, and this file is the pin
 * mgrin asked for.
 *
 * His recurring payments are paid from the untracked current accounts, so by
 * the time one happens that money has already left the tracked perimeter — it
 * left when he moved it. `committed` is a SUBSET of `observed`, not a sibling.
 *
 * Adding them roughly doubles the burn and halves the runway, and it is the
 * kind of arithmetic that looks obviously right until somebody states the
 * relationship out loud. Two numbers on a screen look like they want summing.
 */
describe('SC-657 — committed is a subset of observed, never an addend', () => {
  const observed = '20000';
  const committed = '15000';
  const liquid = new Decimal('200000');

  test('the denominator is observed alone', () => {
    expect(runwayDenominator(observed).toString()).toBe('20000');
  });

  /**
   * THE FAILURE THIS FILE EXISTS FOR, in months rather than in the abstract.
   * The wrong arithmetic is not a rounding difference — it cuts the answer
   * nearly in half, and both numbers look plausible on a screen.
   */
  test('summing them would nearly halve the runway', () => {
    const right = liquid.dividedBy(runwayDenominator(observed));
    const wrong = liquid.dividedBy(new Decimal(observed).plus(committed));

    expect(right.toFixed(1)).toBe('10.0');
    expect(wrong.toFixed(1)).toBe('5.7');
    expect(right.greaterThan(wrong)).toBe(true);
  });

  /**
   * The signature is the guard, not this assertion — but the assertion is
   * what fails if somebody widens it. `runwayDenominator(observed, committed)`
   * must not become expressible: an overload taking both is an invitation to
   * add them inside, where no reviewer would see it.
   */
  test('the denominator cannot be handed both figures', () => {
    expect(runwayDenominator.length).toBe(1);
  });

  test('committed is expressed as a share of observed', () => {
    const share = committedShareOfObserved(committed, observed);
    expect(share).not.toBeNull();
    expect((share as Decimal).toFixed(2)).toBe('0.75');
  });

  /**
   * A share of nothing is a question with no answer, not 0%. Rendering
   * "0% committed" over a month he moved nothing out of tracked accounts
   * would be a confident statement about an empty set.
   */
  test('a share of zero observed is null, not zero', () => {
    expect(committedShareOfObserved(committed, '0')).toBeNull();
    expect(committedShareOfObserved('0', '0')).toBeNull();
  });

  /**
   * Not clamped, deliberately. Over 100% means the book commits more per
   * month than actually left the perimeter — the book is stale, or the month
   * was funded from cash already outside. That divergence is precisely what
   * showing two numbers exists to reveal, so hiding it defeats the feature.
   */
  test('a share above 100% is reported, not clamped', () => {
    const share = committedShareOfObserved('30000', '20000');
    expect((share as Decimal).toFixed(2)).toBe('1.50');
  });
});

/**
 * SC-661. The runway division and the affordability answer moved into
 * `@scani/shared` so the home line and the forecast page cannot compute them
 * differently — which is not tidiness. They DID compute them differently, and
 * reached opposite conclusions about one account at one instant: home said
 * "About 27 months at recent spending" while the forecast page said "Lasts
 * beyond 12 months, the book nets +£8,907.62 a month".
 */
describe('SC-661 — one division, shared by both surfaces', () => {
  /** mgrin's real production figures, 2026-08-26. */
  const LIQUID = '112703.12';
  const OBSERVED = '14087.89';

  test('it reproduces the figure production renders', () => {
    expect(observedRunwayMonths(LIQUID, OBSERVED)).toBe(8);
  });

  /**
   * `liquid ÷ 0` is `Infinity`, and an infinite runway on the one screen the
   * owner scans is the most flattering possible way to be wrong. The caller
   * gets "this window cannot answer" and has to decide what to say.
   */
  test('a zero or negative burn is unanswerable, not forever', () => {
    expect(observedRunwayMonths(LIQUID, '0')).toBeNull();
    expect(observedRunwayMonths(LIQUID, '-1')).toBeNull();
  });

  test('it floors rather than rounds', () => {
    // 10000 ÷ 3000 = 3.33. Rounding would print 3 here too, so the case that
    // discriminates is the one that rounds UP: 10000 ÷ 2600 = 3.85.
    expect(observedRunwayMonths('10000', '3000')).toBe(3);
    expect(observedRunwayMonths('10000', '2600')).toBe(3);
  });

  /**
   * THE REASON THE PANEL CHANGED MODELS. `affordability()` returns
   * `monthsLost: null` unless BOTH walks run out inside the twelve-month
   * window, and mgrin's book nets +$10,819.53 a month, so neither ever did —
   * the panel could only answer "affordable", whatever he typed. A control
   * that cannot return a second answer is not a control.
   */
  test('a purchase always costs a statable number of months', () => {
    const verdict = observedAffordability(LIQUID, OBSERVED, '30000');

    expect(verdict?.monthsBefore).toBe(8);
    expect(verdict?.monthsAfter).toBe(5);
    expect(verdict?.monthsLost).toBe(3);
    expect(verdict?.affordable).toBe(true);
    expect(verdict?.remaining.toString()).toBe('82703.12');
  });

  test('a purchase larger than the balance leaves no runway, not negative months', () => {
    const verdict = observedAffordability(LIQUID, OBSERVED, '200000');

    expect(verdict?.affordable).toBe(false);
    expect(verdict?.monthsAfter).toBe(0);
    expect(verdict?.monthsLost).toBe(8);
    // Flooring a negative would print -6 months, which reads as a quantity
    // rather than as "there is nothing left".
    expect(verdict?.monthsAfter).toBeGreaterThanOrEqual(0);
  });

  test('an unanswerable burn is unanswerable for affordability too', () => {
    expect(observedAffordability(LIQUID, '0', '1000')).toBeNull();
  });
});
