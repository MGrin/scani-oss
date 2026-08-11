import { describe, expect, test } from 'bun:test';
import { describePaymentFormBlockers } from '../../../src/v2/lib/paymentForm';

const complete = {
  vendorId: 'vendor-1',
  currencyTokenId: 'token-1',
  anchorDate: '2026-08-11',
  intervalCount: '1',
};

describe('describePaymentFormBlockers', () => {
  test('a fully populated draft has no blockers', () => {
    expect(describePaymentFormBlockers(complete)).toEqual([]);
  });

  // The regression: the currency field is search-and-pick, so text in the
  // box does not imply a selected token. The form used to disable submit
  // for exactly this reason and say nothing about it.
  test('a currency typed but never picked blocks, and says so', () => {
    const blockers = describePaymentFormBlockers({ ...complete, currencyTokenId: null });
    expect(blockers).toEqual(['pick a currency from the list']);
  });

  test('a missing vendor blocks', () => {
    expect(describePaymentFormBlockers({ ...complete, vendorId: '' })).toEqual(['choose a vendor']);
  });

  test('a missing anchor date blocks', () => {
    expect(describePaymentFormBlockers({ ...complete, anchorDate: '' })).toEqual([
      'set an anchor date',
    ]);
  });

  test.each([
    ['0'],
    ['-1'],
    [''],
    ['abc'],
    ['1.5.2'],
  ])('interval count %p blocks', (intervalCount) => {
    expect(describePaymentFormBlockers({ ...complete, intervalCount })).toEqual([
      'set a valid repeat count',
    ]);
  });

  test('"2" is a valid repeat count — fortnightly is week x 2', () => {
    expect(describePaymentFormBlockers({ ...complete, intervalCount: '2' })).toEqual([]);
  });

  test('every blocker is reported at once, not just the first', () => {
    expect(
      describePaymentFormBlockers({
        vendorId: '',
        currencyTokenId: null,
        anchorDate: '',
        intervalCount: '0',
      })
    ).toHaveLength(4);
  });
});
