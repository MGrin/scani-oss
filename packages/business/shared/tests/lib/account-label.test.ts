import { describe, expect, test } from 'bun:test';
import { accountLabel, accountLabelParts } from '../../src/lib/account-label';

/**
 * The doubled labels from SC-850's production screenshot, as assertions — and
 * the account names this must never invent, which is the larger half.
 *
 * **The two errors do not cost the same.** A miss leaves a label reading
 * redundantly; a false hit renames a user's account in the picker they move
 * money with. So the `keeps` block below is not a list of limitations, it is
 * the specification: each of those cases is one this function COULD strip and
 * deliberately does not.
 */

describe('accountLabelParts — the three it strips', () => {
  test('an exact match collapses to one cell, never an empty one', () => {
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    expect(accountLabelParts('Airwallex', 'Airwallex')).toEqual({
      institution: null,
      name: 'Airwallex',
    });
    expect(accountLabelParts('Edge Capital', 'Edge Capital')).toEqual({
      institution: null,
      name: 'Edge Capital',
    });
  });

  test('a punctuation-joined repeat at the head', () => {
    // The reported row. Dropping the repeat is not cosmetic here — it is what
    // puts the address inside the width the row actually has.
    expect(accountLabelParts('Bitcoin Network - bc1q5n8k', 'Bitcoin Network')).toEqual({
      institution: 'Bitcoin Network',
      name: 'bc1q5n8k',
    });
  });

  test('a punctuation-joined repeat at the tail', () => {
    // Found from the demo seed rather than from the report, and it is
    // three-for-three there. `<device> — <chain>` is how a wallet is ordinarily
    // named, so this is the common shape, not the edge one.
    expect(accountLabelParts('Ledger — Ethereum', 'Ethereum')).toEqual({
      institution: 'Ethereum',
      name: 'Ledger',
    });
    expect(accountLabelParts('Phantom — Solana', 'Solana')).toEqual({
      institution: 'Solana',
      name: 'Phantom',
    });
  });

  test('whichever punctuation the writer used to join them', () => {
    for (const joined of ['Wise · EUR', 'Wise - EUR', 'Wise: EUR', 'Wise/EUR', 'Wise — EUR']) {
      expect(accountLabelParts(joined, 'Wise').name).toBe('EUR');
    }
  });

  test('case-insensitively, since an importer and a person disagree on it', () => {
    expect(accountLabelParts('KRAKEN - spot', 'Kraken')).toEqual({
      institution: 'Kraken',
      name: 'spot',
    });
  });
});

describe('accountLabelParts — what it keeps, and why each one matters', () => {
  test('a SPACE is not a join, at either end', () => {
    // `Wise EUR` and `Wise Guys` are structurally identical, so no rule
    // separates them without semantics. Not a case left unhandled — a case
    // that is not decidable here. Keeping both costs a redundant label on the
    // first and saves the second from being silently renamed to `Guys`.
    expect(accountLabelParts('Wise EUR', 'Wise')).toEqual({
      institution: 'Wise',
      name: 'Wise EUR',
    });
    expect(accountLabelParts('Wise Guys', 'Wise')).toEqual({
      institution: 'Wise',
      name: 'Wise Guys',
    });
    // The same at the tail: `Cash App Savings` must not become `App Savings`,
    // and `Bitcoin Cash` must not become `Bitcoin`.
    expect(accountLabelParts('Cash App Savings', 'Cash')).toEqual({
      institution: 'Cash',
      name: 'Cash App Savings',
    });
    expect(accountLabelParts('Bitcoin Cash', 'Cash')).toEqual({
      institution: 'Cash',
      name: 'Bitcoin Cash',
    });
  });

  test('a name that merely CONTAINS the institution', () => {
    // A repeat is at one END. "Old Kraken transfers" is a name somebody chose.
    expect(accountLabelParts('Old Kraken transfers', 'Kraken')).toEqual({
      institution: 'Kraken',
      name: 'Old Kraken transfers',
    });
  });

  test('a repeat whose removal would leave nothing', () => {
    expect(accountLabelParts('— Solana', 'Solana')).toEqual({
      institution: 'Solana',
      name: '— Solana',
    });
  });

  test('a name with no institution behind it', () => {
    expect(accountLabelParts('Cash box', null)).toEqual({ institution: null, name: 'Cash box' });
    expect(accountLabelParts('Cash box', '   ')).toEqual({ institution: null, name: 'Cash box' });
  });
});

describe('accountLabel', () => {
  test('says the institution once, in the sentences as well as the rows', () => {
    expect(accountLabel('Airwallex', 'Airwallex')).toBe('Airwallex');
    expect(accountLabel('Bitcoin Network - bc1q5n8k', 'Bitcoin Network')).toBe(
      'Bitcoin Network · bc1q5n8k'
    );
    expect(accountLabel('Ledger — Ethereum', 'Ethereum')).toBe('Ethereum · Ledger');
    expect(accountLabel('Savings', 'Revolut')).toBe('Revolut · Savings');
    expect(accountLabel('Cash box', null)).toBe('Cash box');
  });
});
