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
    expect(buildInvoicePrefill({ ...invoice, dueDate: '2026-08-05' })).toEqual({
      vendorName: '1Password',
      amount: '95.88',
      currencyCode: 'USD',
      anchorDate: '2026-08-05',
      anchorDateSource: 'due-date',
      intervalUnit: 'year',
      markAnchorPaid: true,
    });
  });

  // Production's Aug-13 invoice due Aug-23: anchoring on the issue date
  // scheduled it ten days early, every month, and nothing said so.
  test('the due date wins the anchor whenever the invoice states one', () => {
    const prefill = buildInvoicePrefill({
      ...invoice,
      issueDate: '2026-08-13',
      dueDate: '2026-08-23',
    });
    expect(prefill.anchorDate).toBe('2026-08-23');
    expect(prefill.anchorDateSource).toBe('due-date');
  });

  // A stand-in, and flagged as one — the form shows the caveat off
  // `anchorDateSource`, not off the date.
  test('with no due date the issue date stands in, and says so', () => {
    const prefill = buildInvoicePrefill(invoice);
    expect(prefill.anchorDate).toBe('2026-07-26');
    expect(prefill.anchorDateSource).toBe('issue-date');
  });

  // Today is a real, plausible-looking date the user cannot tell apart
  // from one the document carried. Empty blocks submission instead.
  test('neither date present leaves the anchor empty rather than defaulting to today', () => {
    const prefill = buildInvoicePrefill({ ...invoice, issueDate: null, dueDate: null });
    expect(prefill.anchorDate).toBe('');
    expect(prefill.anchorDateSource).toBe('none');
  });

  // SC-147: this used to default to yearly. The extractor reports a period
  // only when the invoice states one in words, so the default fired on the
  // common case and recorded a £146/month bill as £12.17/month.
  test('an unstated billing period is left unanswered rather than guessed', () => {
    expect(buildInvoicePrefill({ ...invoice, billingPeriod: null }).intervalUnit).toBeNull();
    expect(buildInvoicePrefill({ ...invoice, billingPeriod: undefined }).intervalUnit).toBeNull();
  });

  // `billing_period` is plain text with no CHECK constraint, and the QA
  // fixture carried `'2026-07'` — a period *label*, not a cadence.
  test('a value outside the four cadences is unanswered, not a nearest guess', () => {
    expect(buildInvoicePrefill({ ...invoice, billingPeriod: '2026-07' }).intervalUnit).toBeNull();
  });

  test('each billing period carries through unchanged', () => {
    for (const period of ['week', 'month', 'quarter', 'year'] as const) {
      expect(buildInvoicePrefill({ ...invoice, billingPeriod: period }).intervalUnit).toBe(period);
    }
  });

  // Extractions parsed before `paymentStatus` / `billingPeriod` / `dueDate`
  // existed carry none of those keys at all — not even as null.
  test('an extraction missing the newer fields still prefills', () => {
    const legacy = {
      vendorNameRaw: 'Hetzner',
      totalAmount: '12.00',
      currencyCode: 'EUR',
      issueDate: '2026-01-05',
    };
    expect(buildInvoicePrefill(legacy)).toEqual({
      vendorName: 'Hetzner',
      amount: '12.00',
      currencyCode: 'EUR',
      anchorDate: '2026-01-05',
      anchorDateSource: 'issue-date',
      intervalUnit: null,
      markAnchorPaid: true,
    });
  });

  test('blank strings from the parser read as absent, not as content', () => {
    const prefill = buildInvoicePrefill({
      ...invoice,
      currencyCode: '  ',
      vendorNameRaw: null,
      totalAmount: null,
      issueDate: '   ',
      dueDate: '   ',
    });
    expect(prefill.currencyCode).toBeNull();
    expect(prefill.vendorName).toBe('');
    expect(prefill.amount).toBe('');
    expect(prefill.anchorDate).toBe('');
    expect(prefill.anchorDateSource).toBe('none');
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
