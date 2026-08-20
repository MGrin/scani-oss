import '../../i18n-preload';

import { describe, expect, it } from 'bun:test';
import i18n from 'i18next';
import {
  type AccountExport,
  accountExportSheets,
  formatInterval,
  withheldAccount,
} from '../../../src/v3/lib/account-export';

/**
 * The whole-account export, and specifically that SC-93's hide-amounts option
 * reaches **both** downloads offered in that dialog.
 *
 * The workbook and the JSON sit under one toggle. A control that redacts the
 * spreadsheet and hands over an unredacted JSON beside it is not a privacy
 * control, it is a trap, and it is the sort of gap that is only visible if
 * something asserts on the bytes.
 *
 * The English assertions below are unchanged after SC-201 moved every header
 * into `en.json`, and that is the point of leaving them as literals: they now
 * assert that the extraction changed no behaviour, resolved through the real
 * `t` against the file the app ships.
 */

/** The app's own `t`, from the initialised instance the preload above sets
 *  up — not a stub. A stub would make these tests agree with themselves
 *  rather than with `en.json`. */
const t = i18n.t.bind(i18n);

const DATA = {
  profile: { email: 'a@b.c', name: 'A', baseCurrency: 'eur-id', createdAt: new Date(0) },
  accounts: [
    {
      id: 'a1',
      name: 'Girokonto',
      institutionId: 'i1',
      institutionName: 'JPMorgan Chase',
      type: 'Bank',
      description: null,
      isHidden: false,
      isActive: true,
      createdAt: new Date(0),
    },
  ],
  holdings: [
    {
      id: 'h1',
      accountId: 'a1',
      accountName: 'Girokonto',
      institutionName: 'JPMorgan Chase',
      tokenId: 't1',
      symbol: 'BTC',
      tokenName: 'Bitcoin',
      balance: '0.62',
      source: 'manual',
      isHidden: false,
      isActive: true,
      lastUpdated: new Date(0),
      createdAt: new Date(0),
    },
  ],
  transactions: [
    {
      id: 'x1',
      occurredAt: new Date(0),
      holdingId: 'h1',
      accountName: 'Girokonto',
      symbol: 'BTC',
      kind: 'buy',
      quantity: '0.62',
      priceNative: '54740',
      counterQuantity: null,
      feeQuantity: null,
      source: 'manual',
      externalId: null,
      counterparty: null,
      description: null,
    },
  ],
  vendors: [],
  payments: [],
  paymentOccurrences: [],
  groups: [],
  groupMembers: [],
  vaults: [
    {
      id: 'v1',
      name: 'House',
      description: null,
      targetAmount: '50000',
      currentAmount: '12000',
      currency: 'EUR',
      isActive: true,
      createdAt: new Date(0),
    },
  ],
  vaultHoldings: [],
  documents: [],
  netWorthDaily: [
    {
      date: '2026-08-14',
      totalValue: '387594.00',
      coverageQuality: 'full',
      holdingsWithKnownValue: 19,
      holdingsTotal: 21,
      holdingsUnpriceable: 2,
    },
  ],
} as unknown as AccountExport;

const AT = new Date('2026-08-14T10:00:00.000Z');

describe('accountExportSheets', () => {
  it('names one sheet per set', () => {
    const { sheets } = accountExportSheets(DATA, AT, t);
    expect(sheets.map((s) => s.name)).toEqual([
      'Accounts',
      'Holdings',
      'Transactions',
      'Vendors',
      'Payments',
      'Payment occurrences',
      'Groups',
      'Group members',
      'Vaults',
      'Vault holdings',
      'Documents',
      'Net worth history',
    ]);
  });

  it('carries the figures when nothing is withheld', () => {
    const { sheets } = accountExportSheets(DATA, AT, t);
    const holdings = sheets.find((s) => s.name === 'Holdings');
    expect(holdings?.headers).toContain('Balance');
  });

  it('drops every value column and says so when amounts are withheld', () => {
    const { sheets, provenance } = accountExportSheets(DATA, AT, t, { hideAmounts: true });
    expect(provenance.amountsWithheld).toBe(true);

    expect(sheets.find((s) => s.name === 'Holdings')?.headers).not.toContain('Balance');
    expect(sheets.find((s) => s.name === 'Transactions')?.headers).not.toContain('Quantity');
    expect(sheets.find((s) => s.name === 'Vaults')?.headers).not.toContain('Saved (EUR)');
    expect(sheets.find((s) => s.name === 'Net worth history')?.headers).not.toContain('Net worth');
  });

  it('keeps the counts that are tallies rather than money', () => {
    const { sheets } = accountExportSheets(DATA, AT, t, { hideAmounts: true });
    const history = sheets.find((s) => s.name === 'Net worth history');
    expect(history?.headers).toEqual([
      'Date',
      'Coverage',
      'Holdings priced',
      'Holdings total',
      // 19 priced out of 21 is not a 90%-covered portfolio when 2 of the
      // 21 are airdrop tokens nobody quotes, and the file has to be able
      // to say so on its own (SC-146).
      'Holdings unpriceable',
    ]);
  });

  it('leaves the identity of every record intact, so the file is still useful', () => {
    const { sheets } = accountExportSheets(DATA, AT, t, { hideAmounts: true });
    expect(sheets.find((s) => s.name === 'Holdings')?.headers).toContain('Symbol');
    expect(sheets.find((s) => s.name === 'Accounts')?.headers).toContain('Institution');
  });
});

describe('withheldAccount', () => {
  it('strips the same figures from the machine copy', () => {
    const redacted = withheldAccount(DATA);
    const json = JSON.stringify(redacted);

    expect(json).not.toContain('0.62');
    expect(json).not.toContain('54740');
    expect(json).not.toContain('387594.00');
    expect(json).not.toContain('12000');
  });

  it('keeps identity, dates and tallies', () => {
    const redacted = withheldAccount(DATA);
    expect(redacted.holdings[0]?.symbol).toBe('BTC');
    expect(redacted.netWorthDaily[0]?.coverageQuality).toBe('full');
    expect(redacted.netWorthDaily[0]?.holdingsTotal).toBe(21);
    expect(redacted.netWorthDaily[0]?.holdingsUnpriceable).toBe(2);
    expect(redacted.accounts[0]?.name).toBe('Girokonto');
  });

  it('does not mutate what it was given', () => {
    // The caller still holds the real payload — the workbook path may be built
    // from it in the same session.
    withheldAccount(DATA);
    expect(DATA.holdings[0]?.balance).toBe('0.62');
  });
});

/**
 * SC-235. The Every column used to be one key — `{{count}} {{unit}}` — with
 * `unit` interpolated straight off the wire, so every account export ever
 * downloaded reads "2 month" in the only language we ship. That is a live
 * English bug, not a translation-readiness one, and it was flagged rather than
 * fixed when the strings were extracted because fixing it changes the English.
 *
 * A frame like that is also untranslatable in principle: the noun arrives as
 * untranslated data, and no language can make it agree with a number it never
 * sees. English needs two forms; Russian needs three. One pluralised key per
 * unit is the shape that works, because pluralisation is a property of the
 * noun and i18next selects on `count`.
 */
describe('SC-235 — the Every column agrees with its number', () => {
  const t = i18n.t.bind(i18n) as Parameters<typeof formatInterval>[0];

  it.each([
    ['month', 1, '1 month'],
    ['month', 2, '2 months'],
    ['week', 1, '1 week'],
    ['week', 3, '3 weeks'],
    ['quarter', 1, '1 quarter'],
    ['quarter', 4, '4 quarters'],
    ['year', 1, '1 year'],
    ['year', 5, '5 years'],
  ])('%s x%d renders "%s"', (unit, count, expected) => {
    expect(formatInterval(t, unit as string, count as number)).toBe(expected as string);
  });

  it('the plural form is real, not an appended s', () => {
    // The v2 helper this replaces did `${unit}s`. That happens to work for
    // these four nouns and is why the bug survived review: the shape is wrong
    // even where the output looks right.
    expect(formatInterval(t, 'month', 2)).toBe('2 months');
    expect(formatInterval(t, 'month', 0)).toBe('0 months');
  });

  it('an unrecognised unit prints data, not invented grammar', () => {
    // interval_unit is a `text` column, not an enum, so this is reachable.
    // "2 × fortnight" says we did not understand the value; "2 fortnights"
    // would be a guess at a noun we have never seen.
    expect(formatInterval(t, 'fortnight', 2)).toBe('2 × fortnight');
  });
});
