import { describe, expect, test } from 'bun:test';
import { accountLabel, accountLabelParts } from '../../src/lib/account-label';

/**
 * The doubled labels from SC-850's production screenshot, as assertions.
 *
 * Both cases below are real rows off `app.scani.xyz`: `Airwallex · Airwallex`,
 * where an account is named after the institution and nothing more, and
 * `Bitcoin Network · Bitcoin Network - bc1q5n…`, where the identifying half —
 * the address — is the half that then ran off the right edge of the row.
 *
 * The second is the one worth stating plainly: dropping the repeat is not
 * cosmetic there, it is what puts the distinguishing characters inside the
 * width the row actually has.
 */

describe('accountLabelParts', () => {
  test('drops an institution the name already opens with', () => {
    expect(accountLabelParts('Bitcoin Network - bc1q5n8k', 'Bitcoin Network')).toEqual({
      institution: 'Bitcoin Network',
      name: 'bc1q5n8k',
    });
  });

  test('collapses a name that IS its institution to one cell, never an empty one', () => {
    // `{ institution: 'Airwallex', name: '' }` would render as a dim prefix
    // followed by nothing, which reads as a rendering failure rather than as
    // an account whose name is its bank.
    expect(accountLabelParts('Airwallex', 'Airwallex')).toEqual({
      institution: null,
      name: 'Airwallex',
    });
  });

  test('keeps a name that does not repeat the institution', () => {
    expect(accountLabelParts('Savings', 'Revolut')).toEqual({
      institution: 'Revolut',
      name: 'Savings',
    });
  });

  test('matches case-insensitively, since an importer and a person disagree on it', () => {
    expect(accountLabelParts('KRAKEN spot', 'Kraken')).toEqual({
      institution: 'Kraken',
      name: 'spot',
    });
  });

  test('takes off whichever separator the name used', () => {
    for (const joined of ['Wise · EUR', 'Wise - EUR', 'Wise: EUR', 'Wise/EUR', 'Wise EUR']) {
      expect(accountLabelParts(joined, 'Wise').name).toBe('EUR');
    }
  });

  test('an account with no institution is just its name', () => {
    expect(accountLabelParts('Cash box', null)).toEqual({ institution: null, name: 'Cash box' });
    expect(accountLabelParts('Cash box', '   ')).toEqual({ institution: null, name: 'Cash box' });
  });

  test('a name that merely CONTAINS the institution is left alone', () => {
    // Only a leading repeat is a repeat. "Old Kraken transfers" is a name
    // somebody chose, and editing the middle of it is not this function's job.
    expect(accountLabelParts('Old Kraken transfers', 'Kraken')).toEqual({
      institution: 'Kraken',
      name: 'Old Kraken transfers',
    });
  });
});

describe('accountLabel', () => {
  test('says the institution once, in the sentences as well as the rows', () => {
    expect(accountLabel('Airwallex', 'Airwallex')).toBe('Airwallex');
    expect(accountLabel('Bitcoin Network - bc1q5n8k', 'Bitcoin Network')).toBe(
      'Bitcoin Network · bc1q5n8k'
    );
    expect(accountLabel('Savings', 'Revolut')).toBe('Revolut · Savings');
    expect(accountLabel('Cash box', null)).toBe('Cash box');
  });
});
