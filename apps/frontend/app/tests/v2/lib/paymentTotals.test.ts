import { describe, expect, test } from 'bun:test';
import { Decimal } from '@scani/shared';
import {
  annualizedAmount,
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
