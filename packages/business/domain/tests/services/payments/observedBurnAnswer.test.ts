import { describe, expect, test } from 'bun:test';
import {
  CONFIRMATION_TOLERANCE,
  observedBurnAnswerOf,
} from '../../../src/services/payments/ObservedBurnService';

/**
 * SC-661 — what the user has said about the MEASURED drain.
 *
 * Pure, so these are the assertions a reader can check by hand. The one
 * judgement in the feature lives here: how far the measurement may move before
 * a confirmation stops meaning anything.
 */

const EUR = 'eur-token-id';
const USD = 'usd-token-id';
const AT = new Date('2026-08-26T00:00:00Z');

const NO_ANSWER = {
  observedBurnOverride: null,
  observedBurnOverrideCurrencyId: null,
  observedBurnOverrideAt: null,
  observedBurnConfirmedValue: null,
  observedBurnConfirmedCurrencyId: null,
  observedBurnConfirmedAt: null,
};

const overriding = (amount: string, currency = EUR) => ({
  ...NO_ANSWER,
  observedBurnOverride: amount,
  observedBurnOverrideCurrencyId: currency,
  observedBurnOverrideAt: AT,
});

const confirming = (value: string, currency = EUR) => ({
  ...NO_ANSWER,
  observedBurnConfirmedValue: value,
  observedBurnConfirmedCurrencyId: currency,
  observedBurnConfirmedAt: AT,
});

describe('observedBurnAnswerOf', () => {
  test('an account that has said nothing is `none`, not an empty answer', () => {
    expect(observedBurnAnswerOf(NO_ANSWER, EUR, '8100')).toEqual({ kind: 'none' });
  });

  test('an override reports the figure the user chose, and when', () => {
    expect(observedBurnAnswerOf(overriding('6300'), EUR, '8100')).toEqual({
      kind: 'override',
      amount: '6300',
      at: AT,
    });
  });

  /**
   * An override REPLACES the measurement, so nothing about it expires when the
   * measurement moves — a stated 6,300 a month is 6,300 whatever the window
   * does next. Only agreement can be invalidated by the thing it agreed with
   * moving, which is why only the confirmed branch carries `matches`.
   */
  test('an override does not go stale when the measurement moves', () => {
    const far = observedBurnAnswerOf(overriding('6300'), EUR, '99999');
    expect(far).toEqual({ kind: 'override', amount: '6300', at: AT });
  });

  test('a confirmation of the current figure holds', () => {
    expect(observedBurnAnswerOf(confirming('8100'), EUR, '8100')).toEqual({
      kind: 'confirmed',
      value: '8100',
      at: AT,
      matches: true,
    });
  });

  /**
   * THE STATE THE STORED VALUE EXISTS FOR. Read against a bare timestamp this
   * row still says he agreed; read against the value he agreed WITH, it says he
   * agreed to something else. `matches: false` is the surface's instruction to
   * stop claiming agreement and name both figures.
   */
  test('a confirmation of a figure the measurement has left does NOT hold', () => {
    const answer = observedBurnAnswerOf(confirming('8100'), EUR, '11400');
    expect(answer).toMatchObject({ kind: 'confirmed', value: '8100', matches: false });
  });

  /**
   * Exact equality would make the feature useless — one new transaction moves a
   * six-month mean by cents — so there is a band, and its edges are asserted
   * rather than left to whoever next reads `CONFIRMATION_TOLERANCE`.
   */
  test('the tolerance band includes its own edge and excludes just past it', () => {
    expect(CONFIRMATION_TOLERANCE.toString()).toBe('0.05');

    // 8100 + exactly 5% = 8505.
    expect(observedBurnAnswerOf(confirming('8100'), EUR, '8505')).toMatchObject({
      matches: true,
    });
    expect(observedBurnAnswerOf(confirming('8100'), EUR, '8505.01')).toMatchObject({
      matches: false,
    });
    // Symmetric: moving DOWN by more than the band is equally not what he
    // confirmed. A one-sided band would quietly bless a falling drain, which is
    // the flattering direction.
    expect(observedBurnAnswerOf(confirming('8100'), EUR, '7695')).toMatchObject({
      matches: true,
    });
    expect(observedBurnAnswerOf(confirming('8100'), EUR, '7694.99')).toMatchObject({
      matches: false,
    });
  });

  test('a confirmed zero agrees only with another zero, and never divides by it', () => {
    expect(observedBurnAnswerOf(confirming('0'), EUR, '0')).toMatchObject({ matches: true });
    expect(observedBurnAnswerOf(confirming('0'), EUR, '0.01')).toMatchObject({ matches: false });
  });

  test('a confirmation cannot hold against a measurement that does not exist', () => {
    expect(observedBurnAnswerOf(confirming('8100'), EUR, null)).toMatchObject({ matches: false });
  });

  /**
   * The answer stores its own currency so a later base-currency change cannot
   ***REMOVED***
   * reporting `none` DELETES his answer from the screen with no event to notice
   * it by, and reporting it live shows a figure in the wrong unit. Saying it no
   * longer applies is the only reading that is true.
   */
  test('an answer in a currency the account has left no longer applies', () => {
    expect(observedBurnAnswerOf(overriding('6300', EUR), USD, '8100')).toEqual({
      kind: 'currencyChanged',
      at: AT,
    });
    expect(observedBurnAnswerOf(confirming('8100', EUR), USD, '8100')).toEqual({
      kind: 'currencyChanged',
      at: AT,
    });
  });

  test('an account with no base currency at all cannot hold a live answer', () => {
    expect(observedBurnAnswerOf(overriding('6300'), null, null)).toEqual({
      kind: 'currencyChanged',
      at: AT,
    });
  });
});
