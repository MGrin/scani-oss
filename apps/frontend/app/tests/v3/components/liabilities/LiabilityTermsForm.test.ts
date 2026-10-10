import '../../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { termsToSave } from '../../../../src/v3/components/liabilities/LiabilityTermsForm';

// Review minor: switching a form from loan to card kept the loan's term and
// start date in state, hidden, and sent them with the card's terms.
describe('termsToSave', () => {
  const typed = {
    annualRatePct: '21.9',
    termMonths: '360',
    startDate: '2026-01-15',
    originalPrincipal: '500000',
    contractedPayment: '2245.22',
    creditLimit: '5000',
    minimumPayment: '35',
    annualFee: '95',
  };

  test('a card sends only what the card form shows', () => {
    expect(termsToSave('credit_card', typed)).toEqual({
      kind: 'credit_card',
      annualRatePct: '21.9',
      creditLimit: '5000',
      minimumPayment: '35',
      annualFee: '95',
    });
  });

  test('a loan sends only what the loan form shows', () => {
    expect(termsToSave('loan', typed)).toEqual({
      kind: 'loan',
      annualRatePct: '21.9',
      termMonths: 360,
      startDate: '2026-01-15',
      originalPrincipal: '500000',
      contractedPayment: '2245.22',
    });
  });

  test('"other" sends the kind alone, and blanks are left out', () => {
    expect(termsToSave('other', typed)).toEqual({ kind: 'other' });
    expect(termsToSave('loan', { annualRatePct: '  ' })).toEqual({ kind: 'loan' });
  });
});
