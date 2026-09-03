import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import {
  describeRepeatInterval,
  describeV3PaymentFormBlockers,
  type PaymentAccountChoice,
  paymentAccountOptions,
  paymentAccountSelectedLabel,
  type V3PaymentFormDraft,
} from '../../../src/v3/lib/payment-form';

const t = i18n.t.bind(i18n);

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
    expect(describeV3PaymentFormBlockers(t, complete)).toEqual([]);
  });

  // D-5 / M-11: every other field defaults to something valid, so the vendor
  // was the only blocker a new form ever reported — and picking one emptied
  // the list, enabled the button and wrote a bill with no figure.
  test('choosing a vendor does not clear the list while the amount is empty', () => {
    const blockers = describeV3PaymentFormBlockers(t, { ...complete, amount: '' });
    expect(blockers).toEqual(['enter the amount']);
  });

  test('an empty form still names the vendor as well as the amount', () => {
    const blockers = describeV3PaymentFormBlockers(t, { ...complete, vendorId: '', amount: '' });
    expect(blockers).toEqual(['choose a vendor', 'enter the amount']);
  });

  test.each([['0'], ['0.00'], ['   ']])('a fixed amount of %p blocks', (amount) => {
    expect(describeV3PaymentFormBlockers(t, { ...complete, amount })).toEqual(['enter the amount']);
  });

  // "The real figure is set when you settle each one" is what the control
  // means, so an empty estimate there is an answer rather than an omission.
  test('a variable payment may be saved with no estimate', () => {
    expect(describeV3PaymentFormBlockers(t, { ...complete, kind: 'variable', amount: '' })).toEqual(
      []
    );
  });

  test('a variable payment keeps an estimate it was given', () => {
    expect(
      describeV3PaymentFormBlockers(t, { ...complete, kind: 'variable', amount: '40' })
    ).toEqual([]);
  });

  test('but a zero estimate is a claim, not a blank', () => {
    expect(
      describeV3PaymentFormBlockers(t, { ...complete, kind: 'variable', amount: '0' })
    ).toEqual(['make the estimate more than zero, or clear it']);
  });

  /**
   * The four checks that came over from v2 with the module (SC-320), asserted
   * as sentences rather than as a length.
   *
   * Until this move they returned hardcoded English while the amount beside
   * them was keyed, so the "To continue:" list rendered MIXED — half
   * translated, half not, on one line of one screen. No scan of `src/v3` could
   * see it, because the literals lived in a v2 file. A count assertion would
   * still pass with every one of them echoing its own key.
   */
  test('the fields v2 already gated still block, and read as English', () => {
    expect(
      describeV3PaymentFormBlockers(t, {
        ...complete,
        vendorId: '',
        currencyTokenId: null,
        anchorDate: '',
        intervalCount: '0',
        intervalUnit: '',
      })
    ).toEqual([
      'choose a vendor',
      'pick a currency from the list',
      'set an anchor date',
      'choose how often this repeats',
      'set a valid repeat count',
    ]);
  });

  // A vendor carried over from an invoice has no `vendors` row yet;
  // `payments.createFromExtraction` find-or-creates it by name.
  test('a pending vendor name satisfies the vendor requirement', () => {
    expect(
      describeV3PaymentFormBlockers(t, { ...complete, vendorId: '', pendingVendorName: 'Hetzner' })
    ).toEqual([]);
  });

  // `parseInt` happily reads "1.5.2" as 1 and would submit a repeat count the
  // user never typed.
  test.each([['1.5.2'], ['abc'], ['-1'], [' ']])('a repeat count of %p blocks', (intervalCount) => {
    expect(describeV3PaymentFormBlockers(t, { ...complete, intervalCount })).toEqual([
      'set a valid repeat count',
    ]);
  });
});

/**
 * The English these produce is the English the hardcoded template produced —
 * that is the whole claim of SC-202, and it is checkable here because the
 * assertions were written against the template and are unchanged by the
 * extraction.
 *
 * `i18n.t` rather than a stub: a stub would only prove the function calls
 * itself consistently, while the real one proves it agrees with `en.json`.
 */
describe('describeRepeatInterval', () => {
  test('no unit chosen asks the question instead of describing nothing', () => {
    expect(describeRepeatInterval(t, '1', '')).toBe(
      'One invoice never proves a cadence — say how often this bill arrives.'
    );
  });

  test('one occurrence states the period as a bare noun, with no number', () => {
    expect(describeRepeatInterval(t, '1', 'month')).toBe(
      "Repeats every month, anchored on the day it's due."
    );
  });

  test('more than one prints the count and the plural noun', () => {
    expect(describeRepeatInterval(t, '2', 'week')).toBe(
      "Repeats every 2 weeks, anchored on the day it's due."
    );
    expect(describeRepeatInterval(t, '3', 'quarter')).toBe(
      "Repeats every 3 quarters, anchored on the day it's due."
    );
  });

  test.each([
    ['year'],
    ['quarter'],
    ['month'],
    ['week'],
  ] as const)('%s has both forms in en.json', (unit) => {
    expect(describeRepeatInterval(t, '1', unit)).not.toBe(describeRepeatInterval(t, '4', unit));
  });

  // The count comes straight off a text input, so it is a string that may be
  // empty, zero or not a number at all while the reader is still typing.
  test.each([[''], ['0'], ['abc'], ['-2']])('a count of %p reads as one occurrence', (count) => {
    expect(describeRepeatInterval(t, count, 'year')).toBe(
      "Repeats every year, anchored on the day it's due."
    );
  });
});

/**
 * The linked-account picker's rows (SC-862).
 *
 * It was a `<Select>` over `{account.name}` alone — no search, and two accounts
 * called `Savings` were one string twice.
 */
describe('paymentAccountOptions', () => {
  const ACCOUNTS: PaymentAccountChoice[] = [
    { id: 'a', name: 'Savings', institution: 'Wise' },
    { id: 'b', name: 'Savings', institution: 'Kraken' },
    { id: 'c', name: 'Airwallex', institution: 'Airwallex' },
    { id: 'd', name: 'Bitcoin Network - bc1q5n', institution: 'Bitcoin Network' },
    { id: 'e', name: 'Cash', institution: null },
  ];

  test('two accounts of one name are told apart by their institution, in a hint of their own', () => {
    expect(paymentAccountOptions(ACCOUNTS, '').slice(0, 2)).toEqual([
      { id: 'a', label: 'Savings', hint: 'Wise' },
      { id: 'b', label: 'Savings', hint: 'Kraken' },
    ]);
  });

  test('an account named after its institution says it once', () => {
    expect(paymentAccountOptions(ACCOUNTS, '')[2]).toEqual({
      id: 'c',
      label: 'Airwallex',
      hint: undefined,
    });
  });

  test('a punctuation-joined repeat keeps the half that identifies it', () => {
    expect(paymentAccountOptions(ACCOUNTS, '')[3]).toEqual({
      id: 'd',
      label: 'bc1q5n',
      hint: 'Bitcoin Network',
    });
  });

  test('an account with no institution is one line, and the hint is absent rather than empty', () => {
    expect(paymentAccountOptions(ACCOUNTS, '')[4]).toEqual({
      id: 'e',
      label: 'Cash',
      hint: undefined,
    });
  });

  /**
   * The non-obvious half. Collapsing the repeat above is only safe while the
   * search still reads the RAW institution — otherwise fixing a cosmetic
   * duplicate would have made a name untypeable.
   */
  test('the institution is searchable on the row that no longer shows it', () => {
    expect(paymentAccountOptions(ACCOUNTS, 'airwallex').map((row) => row.id)).toEqual(['c']);
    expect(paymentAccountOptions(ACCOUNTS, 'bitcoin').map((row) => row.id)).toEqual(['d']);
  });

  test('and the institution narrows across accounts that share a name', () => {
    expect(paymentAccountOptions(ACCOUNTS, 'kraken').map((row) => row.id)).toEqual(['b']);
    expect(paymentAccountOptions(ACCOUNTS, 'savings').map((row) => row.id)).toEqual(['a', 'b']);
  });

  /** The control: a query naming nothing returns nothing, so the filter above
   *  cannot be passing by returning everything. */
  test('a query naming nothing returns nothing', () => {
    expect(paymentAccountOptions(ACCOUNTS, 'zzzz')).toEqual([]);
  });

  /** Uncapped here — `RecordPicker` caps, and it is the only party that can
   *  then say how many rows it withheld. */
  test('nothing is capped at this level', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      id: `id-${index}`,
      name: `Savings ${index}`,
      institution: 'Wise',
    }));
    expect(paymentAccountOptions(many, '')).toHaveLength(40);
  });
});

describe('paymentAccountSelectedLabel', () => {
  test('the chosen account carries the institution its row put in a hint', () => {
    expect(paymentAccountSelectedLabel({ id: 'a', name: 'Savings', institution: 'Wise' })).toBe(
      'Wise · Savings'
    );
  });

  test('and says it once when the name already did', () => {
    expect(
      paymentAccountSelectedLabel({ id: 'c', name: 'Airwallex', institution: 'Airwallex' })
    ).toBe('Airwallex');
  });

  /** The institution query can resolve after the accounts one; a name alone is
   *  the honest answer rather than a dangling separator. */
  test('an institution that has not arrived yet leaves the name alone', () => {
    expect(paymentAccountSelectedLabel({ id: 'e', name: 'Cash', institution: undefined })).toBe(
      'Cash'
    );
  });
});
