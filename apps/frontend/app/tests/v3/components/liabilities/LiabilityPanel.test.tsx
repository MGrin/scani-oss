import '../../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import type { LiabilityProjectionDto } from '@scani/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { LiabilityPanelView } from '../../../../src/v3/components/liabilities/LiabilityPanel';

// SC-1640: the panel above a liability account's holdings. It shows what is
// owed and, from the terms, when it is paid off; with no terms it asks for them.

const loan: LiabilityProjectionDto = {
  kind: 'loan',
  hasTerms: true,
  owed: '480000',
  currency: 'USD',
  schedule: [
    {
      n: 1,
      date: '2026-02-15',
      payment: '2245.22',
      interest: '1458.33',
      principal: '786.89',
      remaining: '499213.11',
    },
  ],
  projection: {
    status: 'ahead',
    payoffDate: '2054-06-15',
    remainingInterest: '301234.56',
    monthsVsSchedule: -19,
    converged: true,
  },
  card: null,
};

const render = (props: Parameters<typeof LiabilityPanelView>[0]) =>
  renderToStaticMarkup(<LiabilityPanelView {...props} />);

describe('LiabilityPanelView', () => {
  test('a loan shows what is owed, the payoff date, the interest left and how far ahead', () => {
    const html = render({ kind: 'loan', hasTerms: true, data: loan, onEditTerms: () => {} });
    expect(html).toInclude('Amount owed');
    expect(html).toInclude('$480,000.00');
    expect(html).toInclude('2054');
    expect(html).toInclude('$301,234.56');
    expect(html).toInclude('19 months ahead');
    expect(html).toInclude('$2,245.22');
  });

  test('a card shows how much of the limit is used and the credit left', () => {
    const html = render({
      kind: 'credit_card',
      hasTerms: true,
      data: {
        ...loan,
        owed: '1500',
        schedule: null,
        projection: null,
        card: { utilization: '0.3', available: '3500' },
      },
      onEditTerms: () => {},
    });
    expect(html).toInclude('30%');
    expect(html).toInclude('$3,500.00');
    expect(html).toInclude('role="progressbar"');
  });

  test('with no terms it asks for them instead of showing an empty payoff', () => {
    const html = render({
      kind: 'loan',
      hasTerms: false,
      data: { ...loan, schedule: null, projection: null },
      onEditTerms: () => {},
    });
    expect(html).toInclude('Add loan terms');
    expect(html).not.toInclude('Paid off by');
  });

  test('a loan that cannot be paid off at this payment says so rather than giving a date', () => {
    const html = render({
      kind: 'loan',
      hasTerms: true,
      data: {
        ...loan,
        projection: {
          status: 'behind',
          payoffDate: null,
          remainingInterest: '0',
          monthsVsSchedule: 0,
          converged: false,
        },
      },
      onEditTerms: () => {},
    });
    expect(html).toInclude('does not cover the interest');
  });
});

// Review minor: an account with no holding yet has no currency of its own, and
// the panel printed dollars to a reader whose base currency is pounds.
describe('LiabilityPanelView currency', () => {
  test('with no currency of its own it falls back to the base currency', () => {
    const html = render({
      kind: 'loan',
      hasTerms: false,
      data: { ...loan, currency: null, owed: '0', schedule: null, projection: null },
      fallbackCurrency: 'GBP',
      onEditTerms: () => {},
    });
    expect(html).toInclude('£0.00');
    expect(html).not.toInclude('$');
  });

  describe('SC-1672', () => {
    test('a failed terms read shows a readable error with a retry, not a silent button', () => {
      const html = render({
        kind: 'loan',
        hasTerms: true,
        data: loan,
        onEditTerms: () => {},
        termsError: new Error('Internal server error'),
        onRetryTerms: () => {},
      });
      expect(html).toInclude('role="alert"');
      expect(html).toInclude('loan terms');
      expect(html).toInclude('Try again');
    });

    test('no terms error, no alert', () => {
      const html = render({ kind: 'loan', hasTerms: true, data: loan, onEditTerms: () => {} });
      expect(html).not.toInclude('role="alert"');
    });

    test('a loan with a schedule offers to show it, closed by default', () => {
      const html = render({ kind: 'loan', hasTerms: true, data: loan, onEditTerms: () => {} });
      expect(html).toInclude('Show schedule');
      expect(html).not.toInclude('<table');
    });

    test('open, the schedule lists each payment with its interest, principal and what is left', () => {
      const html = render({
        kind: 'loan',
        hasTerms: true,
        data: loan,
        onEditTerms: () => {},
        scheduleOpen: true,
        onToggleSchedule: () => {},
      });
      expect(html).toInclude('<table');
      expect(html).toInclude('Hide schedule');
      expect(html).toInclude('$1,458.33');
      expect(html).toInclude('$786.89');
      expect(html).toInclude('$499,213.11');
    });

    test('no schedule (a card, or terms missing the rate), no schedule button', () => {
      const html = render({
        kind: 'loan',
        hasTerms: true,
        data: { ...loan, schedule: null, projection: null },
        onEditTerms: () => {},
      });
      expect(html).not.toInclude('Show schedule');
    });
  });
});
