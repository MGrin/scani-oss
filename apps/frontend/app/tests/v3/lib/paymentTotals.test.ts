import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { Decimal } from '@scani/shared';
import i18n from 'i18next';
import {
  annualizedAmount,
  type BaseCurrencyRate,
  convertAmountToBase,
  convertTotalsToBase,
  formatPaymentInterval,
  type HistoryEstimate,
  monthlyEquivalent,
  occurrencesPerYear,
  PAYMENT_INTERVAL_UNITS,
  sumAmountsByCurrency,
  sumMonthlyEquivalentByCurrency,
  unestimatedCount,
} from '../../../src/v3/lib/paymentTotals';

/**
 * The cadence sentence, translated (SC-320).
 *
 * It used to be `Every ${count} ${unit}s` in `src/v2/lib/paymentTotals.ts` —
 * hardcoded English that no scan of `src/v3` could see, because there is no
 * literal in any v3 file. Two v3 surfaces render it.
 *
 * The keys are built from the unit (`v3.money.cadence.every_${unit}`), so the
 * literal-key gate in `tests/lib/i18n-keys.test.ts` cannot see them either.
 * This file is the gate instead: it resolves every unit through the real `t`
 * against the `en.json` the app ships, so a missing or misspelled key shows up
 * as the raw key in an assertion rather than on a user's screen.
 */

/** The app's own `t` from the preload above — not a stub. A stub would make
 *  these tests agree with themselves rather than with `en.json`. */
const t = i18n.t.bind(i18n);

describe('formatPaymentInterval', () => {
  test('a once-per-unit cadence names the unit and prints no number', () => {
    // "Every 1 month" is not English. The count is there to select the noun's
    // form, which is why these are per-unit plural keys and not one frame.
    expect(formatPaymentInterval(t, 'month', 1)).toBe('Every month');
  });

  test('a multi-unit cadence pluralises the unit', () => {
    expect(formatPaymentInterval(t, 'week', 2)).toBe('Every 2 weeks');
    expect(formatPaymentInterval(t, 'year', 3)).toBe('Every 3 years');
  });

  test('every unit the wire can hold resolves to a sentence, not a key', () => {
    for (const unit of PAYMENT_INTERVAL_UNITS) {
      for (const count of [1, 2]) {
        const rendered = formatPaymentInterval(t, unit, count);
        expect(rendered).not.toContain('v3.money.cadence');
        expect(rendered.startsWith('Every ')).toBe(true);
      }
    }
  });

  test('an unrecognised unit prints as data rather than as invented grammar', () => {
    // `payments.interval_unit` is a `text` column, so a value outside the
    // enum is reachable. Rendering the cadence must not throw: this is the
    // display path, and the row still has a vendor and an amount worth
    // showing. Same fallback shape as the account export (SC-235).
    expect(formatPaymentInterval(t, 'fortnight', 2)).toBe('Every 2 × fortnight');
  });
});

describe('occurrencesPerYear', () => {
  test('weekly, fortnightly and every-4-weeks land on 52/n', () => {
    expect(occurrencesPerYear('week', 1)).toBe(52);
    expect(occurrencesPerYear('week', 2)).toBe(26);
    expect(occurrencesPerYear('week', 4)).toBe(13);
  });

  test('monthly, quarterly and yearly', () => {
    expect(occurrencesPerYear('month', 1)).toBe(12);
    expect(occurrencesPerYear('quarter', 1)).toBe(4);
    expect(occurrencesPerYear('year', 1)).toBe(1);
  });

  test('zero or negative intervalCount is treated as never-recurring', () => {
    expect(occurrencesPerYear('month', 0)).toBe(0);
    expect(occurrencesPerYear('month', -1)).toBe(0);
  });
});

describe('annualizedAmount / monthlyEquivalent — the annualise-then-divide rule', () => {
  test('a fortnightly $50 payment annualises to $1,300, not $1,200', () => {
    // 26 occurrences/year, not 24 (12 months x 2) — the naive "x2 per
    // month" framing that the brief calls out as plausible-looking wrong.
    expect(annualizedAmount('50', 'week', 2).toString()).toBe('1300');
  });

  test('fortnightly monthly-equivalent is annual/12, never amount x 2', () => {
    const monthly = monthlyEquivalent('50', 'week', 2);
    const naiveDoubled = new Decimal('50').times(2);

    // 1300 / 12 = 108.333...
    expect(monthly.toDecimalPlaces(2).toString()).toBe('108.33');
    expect(monthly.equals(naiveDoubled)).toBe(false);
    expect(monthly.greaterThan(naiveDoubled)).toBe(true);
  });

  test('weekly monthly-equivalent is annual/12, never amount x 4', () => {
    const monthly = monthlyEquivalent('100', 'week', 1);
    const naiveQuadrupled = new Decimal('100').times(4);

    // 52 x 100 / 12 = 433.33...
    expect(monthly.toDecimalPlaces(2).toString()).toBe('433.33');
    expect(monthly.equals(naiveQuadrupled)).toBe(false);
  });

  test('monthly payment is unaffected by the annualise/divide round trip', () => {
    expect(monthlyEquivalent('75', 'month', 1).toString()).toBe('75');
  });

  test('quarterly $300 annualises to $1,200, monthly-equivalent to $100', () => {
    expect(annualizedAmount('300', 'quarter', 1).toString()).toBe('1200');
    expect(monthlyEquivalent('300', 'quarter', 1).toString()).toBe('100');
  });
});

describe('sumAmountsByCurrency', () => {
  test('sums raw amounts grouped by currency, unrelated currencies stay separate', () => {
    const totals = sumAmountsByCurrency([
      { amount: '10.50', currencyTokenId: 'usd' },
      { amount: '5.25', currencyTokenId: 'usd' },
      { amount: '20', currencyTokenId: 'eur' },
    ]);

    expect(totals.get('usd')?.toString()).toBe('15.75');
    expect(totals.get('eur')?.toString()).toBe('20');
    expect(totals.size).toBe(2);
  });

  test('empty input yields an empty map', () => {
    expect(sumAmountsByCurrency([]).size).toBe(0);
  });
});

describe('sumMonthlyEquivalentByCurrency', () => {
  test('mixes cadences correctly instead of naively summing period amounts', () => {
    // A $50/fortnight payment (~$108.33/mo) plus a $300/quarter payment
    // ($100/mo) should NOT sum to $50*2 + $300/3 = $200 (the naive
    // per-period-scaled total) — it must sum the annualised-then-divided
    // monthly figures.
    const totals = sumMonthlyEquivalentByCurrency([
      {
        expectedAmount: '50',
        intervalUnit: 'week',
        intervalCount: 2,
        currencyTokenId: 'usd',
        historyEstimate: null,
      },
      {
        expectedAmount: '300',
        intervalUnit: 'quarter',
        intervalCount: 1,
        currencyTokenId: 'usd',
        historyEstimate: null,
      },
    ]);

    const total = totals.get('usd');
    expect(total).toBeDefined();
    expect(total?.toDecimalPlaces(2).toString()).toBe('208.33');
    expect(total?.equals(new Decimal('200'))).toBe(false);
  });

  test('skips entries with no expectedAmount and no history estimate', () => {
    const totals = sumMonthlyEquivalentByCurrency([
      {
        expectedAmount: null,
        intervalUnit: 'month',
        intervalCount: 1,
        currencyTokenId: 'usd',
        historyEstimate: null,
      },
    ]);

    expect(totals.size).toBe(0);
  });

  test('keeps different currencies in separate buckets', () => {
    const totals = sumMonthlyEquivalentByCurrency([
      {
        expectedAmount: '120',
        intervalUnit: 'month',
        intervalCount: 1,
        currencyTokenId: 'usd',
        historyEstimate: null,
      },
      {
        expectedAmount: '60',
        intervalUnit: 'month',
        intervalCount: 1,
        currencyTokenId: 'eur',
        historyEstimate: null,
      },
    ]);

    expect(totals.get('usd')?.toString()).toBe('120');
    expect(totals.get('eur')?.toString()).toBe('60');
  });
});

describe('convertTotalsToBase', () => {
  const EUR = 'token-eur';
  const USD = 'token-usd';
  const GBP = 'token-gbp';
  const NOW = new Date('2026-08-13T12:00:00Z');
  const FRESH = '2026-08-13T06:00:00Z';

  const rates = (entries: Array<[string, BaseCurrencyRate | null]>) => new Map(entries);

  test('one figure, not a list: every currency lands in base', () => {
    const total = convertTotalsToBase(
      new Map([
        [EUR, new Decimal('94.97')],
        [USD, new Decimal('23')],
        [GBP, new Decimal('180')],
      ]),
      {
        baseCurrencyTokenId: EUR,
        ratesStatus: 'ready',
        rateByCurrencyTokenId: rates([
          [USD, { rate: '0.9', asOf: FRESH }],
          [GBP, { rate: '1.17', asOf: FRESH }],
        ]),
        now: NOW,
      }
    );
    // 94.97 + (23 × 0.9) + (180 × 1.17)
    expect(total.amount.toString()).toBe('326.27');
    expect(total.convertedFrom).toEqual([USD, GBP]);
    expect(total.unconverted).toEqual([]);
  });

  test('the base currency is not "converted from" itself', () => {
    const total = convertTotalsToBase(new Map([[EUR, new Decimal('40')]]), {
      baseCurrencyTokenId: EUR,
      ratesStatus: 'ready',
      rateByCurrencyTokenId: rates([]),
      now: NOW,
    });
    expect(total.amount.toString()).toBe('40');
    expect(total.convertedFrom).toEqual([]);
    expect(total.ratesAsOf).toBeNull();
  });

  // The failure that would be worse than the per-currency list it replaces:
  // a bill we cannot price quietly leaving the figure the user reads as
  // "what I owe".
  test('an un-convertible currency is never folded in, and never dropped', () => {
    const total = convertTotalsToBase(
      new Map([
        [EUR, new Decimal('100')],
        [USD, new Decimal('23')],
      ]),
      {
        baseCurrencyTokenId: EUR,
        ratesStatus: 'ready',
        rateByCurrencyTokenId: rates([[USD, null]]),
        now: NOW,
      }
    );
    expect(total.amount.toString()).toBe('100');
    expect(total.unconverted).toEqual([{ currencyTokenId: USD, amount: new Decimal('23') }]);
  });

  test('nothing converts before the base currency resolves, and it says so', () => {
    const total = convertTotalsToBase(new Map([[USD, new Decimal('23')]]), {
      baseCurrencyTokenId: null,
      ratesStatus: 'loading',
      rateByCurrencyTokenId: rates([]),
      now: NOW,
    });
    expect(total.amount.toString()).toBe('0');
    // `unknown`, not `unconverted`: there is no claim to make about USD yet.
    expect(total.unconverted).toEqual([]);
    expect(total.unknown).toHaveLength(1);
    expect(total.pending).toBe(true);
  });

  test('the oldest rate behind the figure is the one reported, and dates it stale', () => {
    const total = convertTotalsToBase(
      new Map([
        [USD, new Decimal('10')],
        [GBP, new Decimal('10')],
      ]),
      {
        baseCurrencyTokenId: EUR,
        ratesStatus: 'ready',
        rateByCurrencyTokenId: rates([
          [USD, { rate: '1', asOf: FRESH }],
          [GBP, { rate: '1', asOf: '2026-08-09T06:00:00Z' }],
        ]),
        now: NOW,
      }
    );
    expect(total.ratesAsOf?.toISOString()).toBe('2026-08-09T06:00:00.000Z');
    expect(total.stale).toBe(true);
  });
});

/**
 * The reported bug, as arithmetic (SC-210).
 *
 * mgrin opened Money and read $425 where the answer was $888, because every
 * foreign payment was silently dropped while the rates were in flight — and
 * on a failed fetch it stayed $425 for good. These tests pin the distinction
 * that makes both cases expressible: a rate the source ANSWERED for and did
 * not have is a fact about the currency; a rate nobody has told us about is a
 * fact about the fetch, and the two must never produce the same figure with
 * the same confidence.
 */
describe('convertTotalsToBase — rates that have not arrived', () => {
  const EUR = 'token-eur';
  const USD = 'token-usd';
  const GBP = 'token-gbp';
  const NOW = new Date('2026-08-13T12:00:00Z');

  // The reported shape: the reader's own currency plus two foreign ones.
  const BOOK = new Map([
    [USD, new Decimal('425')],
    [EUR, new Decimal('300')],
    [GBP, new Decimal('163')],
  ]);

  test('a total mid-fetch is pending, and its foreign parts are unknown rather than unconvertible', () => {
    const total = convertTotalsToBase(BOOK, {
      baseCurrencyTokenId: USD,
      // What the map actually is while `tokens.getBaseCurrencyRates` is in
      // flight: empty. This is the exact state that rendered 425.
      rateByCurrencyTokenId: new Map(),
      ratesStatus: 'loading',
      now: NOW,
    });

    expect(total.pending).toBe(true);
    expect(total.unconverted).toEqual([]);
    expect(total.unknown.map((part) => part.currencyTokenId)).toEqual([EUR, GBP]);
    // `amount` is still the USD-only sum — the figure the bug showed. It stays
    // computable, because a caller that has nothing better to show needs it;
    // `pending` is what forbids showing it as the answer.
    expect(total.amount.toString()).toBe('425');
  });

  test('a failed fetch is not pending: nothing is coming, and the parts stay unknown', () => {
    const total = convertTotalsToBase(BOOK, {
      baseCurrencyTokenId: USD,
      rateByCurrencyTokenId: new Map(),
      ratesStatus: 'unavailable',
      now: NOW,
    });

    // Not pending — a caller that waits for a later render waits forever, and
    // that is the half of the report where the figure "sticks" on 425.
    expect(total.pending).toBe(false);
    expect(total.unknown).toHaveLength(2);
    // Still not `unconverted`: the currencies are fine, our request was not.
    expect(total.unconverted).toEqual([]);
  });

  test('once the rates land, the same book is one figure', () => {
    const total = convertTotalsToBase(BOOK, {
      baseCurrencyTokenId: USD,
      rateByCurrencyTokenId: new Map([
        [EUR, { rate: '1.1', asOf: '2026-08-13T06:00:00Z' }],
        [GBP, { rate: '1.0', asOf: '2026-08-13T06:00:00Z' }],
      ]),
      ratesStatus: 'ready',
      now: NOW,
    });

    expect(total.pending).toBe(false);
    expect(total.unknown).toEqual([]);
    // 425 + (300 × 1.1) + (163 × 1.0)
    expect(total.amount.toString()).toBe('918');
  });

  test('a currency the source answered for with no rate is unconvertible even mid-fetch', () => {
    // Both kinds of missing in one figure — the case that proves the two lists
    // are decided per part rather than per query. GBP came back rateless in an
    // earlier response; EUR has not come back at all.
    const total = convertTotalsToBase(BOOK, {
      baseCurrencyTokenId: USD,
      rateByCurrencyTokenId: new Map([[GBP, null]]),
      ratesStatus: 'loading',
      now: NOW,
    });

    expect(total.unconverted.map((part) => part.currencyTokenId)).toEqual([GBP]);
    expect(total.unknown.map((part) => part.currencyTokenId)).toEqual([EUR]);
  });

  test('rates that are ready and simply silent about a currency mean no rate', () => {
    // The one case where an absent entry is a complete answer: the query has
    // returned and this currency is not in it.
    const total = convertTotalsToBase(new Map([[GBP, new Decimal('163')]]), {
      baseCurrencyTokenId: USD,
      rateByCurrencyTokenId: new Map(),
      ratesStatus: 'ready',
      now: NOW,
    });

    expect(total.unconverted).toHaveLength(1);
    expect(total.unknown).toEqual([]);
    expect(total.pending).toBe(false);
  });

  test('a single-currency book never waits on rates it does not need', () => {
    // Nothing foreign on screen, so the empty map is the whole answer and the
    // figure must render immediately — a skeleton here would be a regression
    // for the majority of users, who hold one currency.
    const total = convertTotalsToBase(new Map([[USD, new Decimal('425')]]), {
      baseCurrencyTokenId: USD,
      rateByCurrencyTokenId: new Map(),
      ratesStatus: 'ready',
      now: NOW,
    });

    expect(total.pending).toBe(false);
    expect(total.amount.toString()).toBe('425');
  });
});

describe('convertAmountToBase', () => {
  const EUR = 'token-eur';
  const GBP = 'token-gbp';
  const NOW = new Date('2026-08-13T12:00:00Z');

  test('a row in another currency gets its base-currency equivalent', () => {
    const converted = convertAmountToBase('120', GBP, {
      baseCurrencyTokenId: EUR,
      ratesStatus: 'ready',
      rateByCurrencyTokenId: new Map([[GBP, { rate: '1.17', asOf: '2026-08-13T06:00:00Z' }]]),
      now: NOW,
    });
    expect(converted?.amount.toString()).toBe('140.4');
    expect(converted?.stale).toBe(false);
  });

  test('a row already in base currency says nothing', () => {
    expect(
      convertAmountToBase('120', EUR, {
        baseCurrencyTokenId: EUR,
        ratesStatus: 'ready',
        rateByCurrencyTokenId: new Map(),
        now: NOW,
      })
    ).toBeNull();
  });

  test('no amount and no rate both mean no second line', () => {
    const context = {
      baseCurrencyTokenId: EUR,
      ratesStatus: 'ready' as const,
      rateByCurrencyTokenId: new Map([[GBP, null]]),
      now: NOW,
    };
    expect(convertAmountToBase(null, GBP, context)).toBeNull();
    expect(convertAmountToBase('120', GBP, context)).toBeNull();
  });
});

describe('sumMonthlyEquivalentByCurrency — the history estimate (SC-625)', () => {
  const variable = (historyEstimate: HistoryEstimate | null) => ({
    expectedAmount: null,
    intervalUnit: 'month' as const,
    intervalCount: 1,
    currencyTokenId: 'usd',
    historyEstimate,
  });

  test('a history estimate is counted where a declared one would be', () => {
    const totals = sumMonthlyEquivalentByCurrency([
      variable({ amount: '84.20', sourceDueDate: '2026-02-15' }),
    ]);
    expect(totals.get('usd')?.toString()).toBe('84.2');
  });

  test('it annualises like any other amount rather than being taken as monthly', () => {
    // A QUARTERLY payment estimated at 210 is 70 a month, not 210. The
    // substitution happens before the cadence maths, not after it — taking the
    // settled figure as already-monthly is the failure the annualisation rule
    // at the top of this file exists for, reached by a new route.
    const totals = sumMonthlyEquivalentByCurrency([
      {
        expectedAmount: null,
        intervalUnit: 'quarter',
        intervalCount: 1,
        currencyTokenId: 'usd',
        historyEstimate: { amount: '210', sourceDueDate: '2025-12-15' },
      },
    ]);
    expect(totals.get('usd')?.toString()).toBe('70');
  });

  test('a declared estimate beats history, never the other way round', () => {
    const totals = sumMonthlyEquivalentByCurrency([
      {
        expectedAmount: '100',
        intervalUnit: 'month',
        intervalCount: 1,
        currencyTokenId: 'usd',
        historyEstimate: { amount: '999', sourceDueDate: '2026-02-15' },
      },
    ]);
    expect(totals.get('usd')?.toString()).toBe('100');
  });

  test('unestimatedCount is the denominator, and it counts only what the sum left out', () => {
    const payments = [
      variable(null),
      variable(null),
      variable({ amount: '50', sourceDueDate: '2026-02-15' }),
      {
        expectedAmount: '10',
        intervalUnit: 'month' as const,
        intervalCount: 1,
        currencyTokenId: 'usd',
        historyEstimate: null,
      },
    ];

    // 50 + 10 in the total, and exactly the two it could not price counted.
    expect(sumMonthlyEquivalentByCurrency(payments).get('usd')?.toString()).toBe('60');
    expect(unestimatedCount(payments)).toBe(2);

    // The must-be-ABSENT control: on a book where everything is priced the
    // count is 0, so a non-zero reading is never just "this function runs".
    expect(unestimatedCount(payments.slice(2))).toBe(0);
  });
});
