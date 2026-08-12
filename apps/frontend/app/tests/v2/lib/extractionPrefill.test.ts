import { describe, expect, test } from 'bun:test';
import {
  buildInvoicePrefill,
  defaultMarkAnchorPaid,
  matchCurrencyToken,
} from '../../../src/v2/lib/extractionPrefill';

const invoice = {
  vendorNameRaw: '1Password',
  totalAmount: '95.88',
  currencyCode: 'USD',
  issueDate: '2026-07-26',
  paymentStatus: 'paid' as const,
  billingPeriod: 'year' as const,
};

describe('buildInvoicePrefill', () => {
  test('a fully parsed invoice fills every field it evidences', () => {
    expect(buildInvoicePrefill(invoice, '2026-08-11')).toEqual({
      vendorName: '1Password',
      amount: '95.88',
      currencyCode: 'USD',
      anchorDate: '2026-07-26',
      intervalUnit: 'year',
      markAnchorPaid: true,
    });
  });

  // The invoice, not today, is the anchor: anchoring on upload date would
  // put the next yearly payment on the wrong day forever.
  test('the anchor is the issue date, falling back to today only when absent', () => {
    expect(buildInvoicePrefill(invoice, '2026-08-11').anchorDate).toBe('2026-07-26');
    expect(buildInvoicePrefill({ ...invoice, issueDate: null }, '2026-08-11').anchorDate).toBe(
      '2026-08-11'
    );
  });

  test('an unknown billing period falls back to yearly', () => {
    expect(
      buildInvoicePrefill({ ...invoice, billingPeriod: null }, '2026-08-11').intervalUnit
    ).toBe('year');
  });

  test('each billing period carries through unchanged', () => {
    for (const period of ['week', 'month', 'quarter', 'year'] as const) {
      expect(
        buildInvoicePrefill({ ...invoice, billingPeriod: period }, '2026-08-11').intervalUnit
      ).toBe(period);
    }
  });

  // Extractions parsed before `paymentStatus` / `billingPeriod` existed
  // carry neither key at all — not even as null.
  test('an extraction missing the newer fields still prefills', () => {
    const legacy = {
      vendorNameRaw: 'Hetzner',
      totalAmount: '12.00',
      currencyCode: 'EUR',
      issueDate: '2026-01-05',
    };
    expect(buildInvoicePrefill(legacy, '2026-08-11')).toEqual({
      vendorName: 'Hetzner',
      amount: '12.00',
      currencyCode: 'EUR',
      anchorDate: '2026-01-05',
      intervalUnit: 'year',
      markAnchorPaid: true,
    });
  });

  test('blank strings from the parser read as absent, not as content', () => {
    const prefill = buildInvoicePrefill(
      { ...invoice, currencyCode: '  ', vendorNameRaw: null, totalAmount: null },
      '2026-08-11'
    );
    expect(prefill.currencyCode).toBeNull();
    expect(prefill.vendorName).toBe('');
    expect(prefill.amount).toBe('');
  });
});

describe('defaultMarkAnchorPaid', () => {
  test.each([
    ['paid' as const, true],
    ['unpaid' as const, false],
    [null, true],
    [undefined, true],
  ])('status %p defaults the switch to %p', (status, expected) => {
    expect(defaultMarkAnchorPaid(status)).toBe(expected);
  });
});

describe('matchCurrencyToken', () => {
  const tokens = [
    { id: 'crypto-usd', symbol: 'USD', name: 'Some USD token', type: 'crypto' },
    { id: 'fiat-usd', symbol: 'USD', name: 'US Dollar', type: 'fiat' },
    { id: 'fiat-eur', symbol: 'EUR', name: 'Euro', type: 'fiat' },
  ];

  test('matches on symbol, case-insensitively', () => {
    expect(matchCurrencyToken(tokens, 'eur')?.id).toBe('fiat-eur');
  });

  // A bill priced in a crypto token that happens to share the ticker is
  // the kind of wrong that stays invisible until the totals are wrong.
  test('prefers the fiat row when several tokens share a symbol', () => {
    expect(matchCurrencyToken(tokens, 'USD')?.id).toBe('fiat-usd');
  });

  test('falls back to the only match when none is fiat', () => {
    expect(matchCurrencyToken([tokens[0]], 'USD')?.id).toBe('crypto-usd');
  });

  test('an absent or unknown code matches nothing, leaving the base currency in place', () => {
    expect(matchCurrencyToken(tokens, null)).toBeNull();
    expect(matchCurrencyToken(tokens, '   ')).toBeNull();
    expect(matchCurrencyToken(tokens, 'GBP')).toBeNull();
  });
});
