import { describe, expect, test } from 'bun:test';
import { SetLiabilityTermsDto } from '../../src/dtos/liabilities';

// SC-1640 review minors. Both reached the service and failed there: an
// impossible date as a 500, a zero payment as a loan that never ends.
describe('SetLiabilityTermsDto', () => {
  const loan = (patch: Record<string, unknown>) =>
    SetLiabilityTermsDto.safeParse({ kind: 'loan', ...patch }).success;

  test('a start date must exist on the calendar', () => {
    expect(loan({ startDate: '2026-02-28' })).toBe(true);
    expect(loan({ startDate: '2024-02-29' })).toBe(true);
    expect(loan({ startDate: '2026-02-31' })).toBe(false);
    expect(loan({ startDate: '2026-13-01' })).toBe(false);
  });

  test('principal and contracted payment must be above zero', () => {
    expect(loan({ originalPrincipal: '0' })).toBe(false);
    expect(loan({ contractedPayment: '0' })).toBe(false);
    expect(loan({ originalPrincipal: '500000', contractedPayment: '2245.22' })).toBe(true);
  });

  // The control: a card's fee and minimum may truly be zero.
  test('a zero annual fee or minimum payment is fine', () => {
    expect(
      SetLiabilityTermsDto.safeParse({ kind: 'credit_card', annualFee: '0', minimumPayment: '0' })
        .success
    ).toBe(true);
  });
});
