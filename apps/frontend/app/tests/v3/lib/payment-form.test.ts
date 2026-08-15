import { describe, expect, test } from 'bun:test';
import {
  describeV3PaymentFormBlockers,
  type V3PaymentFormDraft,
} from '../../../src/v3/lib/payment-form';

/** Every field answered, the way the form itself arrives at it: currency
 *  defaulted to the base currency, anchor to today, count to "1". */
const complete: V3PaymentFormDraft = {
  vendorId: 'vendor-1',
  currencyTokenId: 'token-1',
  anchorDate: '2026-08-13',
  intervalCount: '1',
  intervalUnit: 'month',
  amount: '40',
  kind: 'fixed',
};

describe('describeV3PaymentFormBlockers', () => {
  test('a fully answered draft has no blockers', () => {
    expect(describeV3PaymentFormBlockers(complete)).toEqual([]);
  });

  // D-5 / M-11: every other field defaults to something valid, so the vendor
  // was the only blocker a new form ever reported — and picking one emptied
  // the list, enabled the button and wrote a bill with no figure.
  test('choosing a vendor does not clear the list while the amount is empty', () => {
    const blockers = describeV3PaymentFormBlockers({ ...complete, amount: '' });
    expect(blockers).toEqual(['enter the amount']);
  });

  test('an empty form still names the vendor as well as the amount', () => {
    const blockers = describeV3PaymentFormBlockers({ ...complete, vendorId: '', amount: '' });
    expect(blockers).toEqual(['choose a vendor', 'enter the amount']);
  });

  test.each([['0'], ['0.00'], ['   ']])('a fixed amount of %p blocks', (amount) => {
    expect(describeV3PaymentFormBlockers({ ...complete, amount })).toEqual(['enter the amount']);
  });

  // "The real figure is set when you settle each one" is what the control
  // means, so an empty estimate there is an answer rather than an omission.
  test('a variable payment may be saved with no estimate', () => {
    expect(describeV3PaymentFormBlockers({ ...complete, kind: 'variable', amount: '' })).toEqual(
      []
    );
  });

  test('a variable payment keeps an estimate it was given', () => {
    expect(describeV3PaymentFormBlockers({ ...complete, kind: 'variable', amount: '40' })).toEqual(
      []
    );
  });

  test('but a zero estimate is a claim, not a blank', () => {
    expect(describeV3PaymentFormBlockers({ ...complete, kind: 'variable', amount: '0' })).toEqual([
      'make the estimate more than zero, or clear it',
    ]);
  });

  // The base gate is v2's and stays v2's — this only proves it is still wired
  // in, not that it works, which `tests/v2/lib/paymentForm.ts` covers.
  test('the fields v2 already gated still block', () => {
    expect(
      describeV3PaymentFormBlockers({
        ...complete,
        currencyTokenId: null,
        anchorDate: '',
        intervalCount: '0',
        intervalUnit: '',
      })
    ).toHaveLength(4);
  });
});
