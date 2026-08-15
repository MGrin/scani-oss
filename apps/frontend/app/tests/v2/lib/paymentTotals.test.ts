import { describe, expect, test } from 'bun:test';
import { Decimal } from '@scani/shared';
import {
  annualizedAmount,
  type BaseCurrencyRate,
  convertAmountToBase,
  convertTotalsToBase,
  describeConversion,
  formatOccurrenceStatus,
  formatPaymentInterval,
  monthlyEquivalent,
  occurrencesPerYear,
  sumAmountsByCurrency,
  sumMonthlyEquivalentByCurrency,
} from '../../../src/v2/lib/paymentTotals';

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

describe('formatPaymentInterval', () => {
  test('singular for intervalCount 1', () => {
    expect(formatPaymentInterval('week', 1)).toBe('Every week');
    expect(formatPaymentInterval('month', 1)).toBe('Every month');
  });

  test('pluralises for intervalCount > 1', () => {
    expect(formatPaymentInterval('week', 2)).toBe('Every 2 weeks');
    expect(formatPaymentInterval('quarter', 3)).toBe('Every 3 quarters');
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
      { expectedAmount: '50', intervalUnit: 'week', intervalCount: 2, currencyTokenId: 'usd' },
      { expectedAmount: '300', intervalUnit: 'quarter', intervalCount: 1, currencyTokenId: 'usd' },
    ]);

    const total = totals.get('usd');
    expect(total).toBeDefined();
    expect(total?.toDecimalPlaces(2).toString()).toBe('208.33');
    expect(total?.equals(new Decimal('200'))).toBe(false);
  });

  test('skips entries with no expectedAmount (variable-kind payments with no estimate)', () => {
    const totals = sumMonthlyEquivalentByCurrency([
      { expectedAmount: null, intervalUnit: 'month', intervalCount: 1, currencyTokenId: 'usd' },
    ]);

    expect(totals.size).toBe(0);
  });

  test('keeps different currencies in separate buckets', () => {
    const totals = sumMonthlyEquivalentByCurrency([
      { expectedAmount: '120', intervalUnit: 'month', intervalCount: 1, currencyTokenId: 'usd' },
      { expectedAmount: '60', intervalUnit: 'month', intervalCount: 1, currencyTokenId: 'eur' },
    ]);

    expect(totals.get('usd')?.toString()).toBe('120');
    expect(totals.get('eur')?.toString()).toBe('60');
  });
});

describe('formatOccurrenceStatus', () => {
  // "matched" is detection-era jargon for "settled"; direction decides
  // the verb, since money arriving is received, not paid.
  test('a settled occurrence reads as paid or received by direction', () => {
    expect(formatOccurrenceStatus('matched', 'outflow')).toBe('Paid');
    expect(formatOccurrenceStatus('matched', 'inflow')).toBe('Received');
  });

  test('the other statuses are direction-independent', () => {
    for (const direction of ['inflow', 'outflow']) {
      expect(formatOccurrenceStatus('scheduled', direction)).toBe('Scheduled');
      expect(formatOccurrenceStatus('skipped', direction)).toBe('Skipped');
      expect(formatOccurrenceStatus('missed', direction)).toBe('Missed');
    }
  });

  test('an unrecognised status passes through rather than rendering blank', () => {
    expect(formatOccurrenceStatus('something-new', 'outflow')).toBe('something-new');
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
        rateByCurrencyTokenId: rates([[USD, null]]),
        now: NOW,
      }
    );
    expect(total.amount.toString()).toBe('100');
    expect(total.unconverted).toEqual([{ currencyTokenId: USD, amount: new Decimal('23') }]);
  });

  test('nothing converts before the base currency resolves', () => {
    const total = convertTotalsToBase(new Map([[USD, new Decimal('23')]]), {
      baseCurrencyTokenId: null,
      rateByCurrencyTokenId: rates([]),
      now: NOW,
    });
    expect(total.amount.toString()).toBe('0');
    expect(total.unconverted).toHaveLength(1);
  });

  test('the oldest rate behind the figure is the one reported, and dates it stale', () => {
    const total = convertTotalsToBase(
      new Map([
        [USD, new Decimal('10')],
        [GBP, new Decimal('10')],
      ]),
      {
        baseCurrencyTokenId: EUR,
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

describe('convertAmountToBase', () => {
  const EUR = 'token-eur';
  const GBP = 'token-gbp';
  const NOW = new Date('2026-08-13T12:00:00Z');

  test('a row in another currency gets its base-currency equivalent', () => {
    const converted = convertAmountToBase('120', GBP, {
      baseCurrencyTokenId: EUR,
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
        rateByCurrencyTokenId: new Map(),
        now: NOW,
      })
    ).toBeNull();
  });

  test('no amount and no rate both mean no second line', () => {
    const context = {
      baseCurrencyTokenId: EUR,
      rateByCurrencyTokenId: new Map([[GBP, null]]),
      now: NOW,
    };
    expect(convertAmountToBase(null, GBP, context)).toBeNull();
    expect(convertAmountToBase('120', GBP, context)).toBeNull();
  });
});

describe('describeConversion', () => {
  const EUR = 'token-eur';
  const USD = 'token-usd';
  const symbolFor = (id: string) => (id === USD ? 'USD' : 'EUR');

  test('a converted total says so, and names what it folded in', () => {
    const total = convertTotalsToBase(new Map([[USD, new Decimal('23')]]), {
      baseCurrencyTokenId: EUR,
      rateByCurrencyTokenId: new Map([[USD, { rate: '0.9', asOf: '2026-08-13T06:00:00Z' }]]),
      now: new Date('2026-08-13T12:00:00Z'),
    });
    expect(describeConversion(total, symbolFor)).toBe("Converted from USD at today's rates");
  });

  test('a stale rate is dated rather than presented as current', () => {
    const total = convertTotalsToBase(new Map([[USD, new Decimal('23')]]), {
      baseCurrencyTokenId: EUR,
      rateByCurrencyTokenId: new Map([[USD, { rate: '0.9', asOf: '2026-08-09T06:00:00Z' }]]),
      now: new Date('2026-08-13T12:00:00Z'),
    });
    expect(describeConversion(total, symbolFor)).toContain('at rates from');
  });

  test('what could not be converted is named with its amount', () => {
    const total = convertTotalsToBase(new Map([[USD, new Decimal('23')]]), {
      baseCurrencyTokenId: EUR,
      rateByCurrencyTokenId: new Map([[USD, null]]),
    });
    expect(describeConversion(total, symbolFor)).toContain('not included — no recent rate');
  });

  test('a single-currency total needs no qualification', () => {
    const total = convertTotalsToBase(new Map([[EUR, new Decimal('40')]]), {
      baseCurrencyTokenId: EUR,
      rateByCurrencyTokenId: new Map(),
    });
    expect(describeConversion(total, symbolFor)).toBeNull();
  });
});
