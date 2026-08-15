import { describe, expect, it } from 'bun:test';
import {
  type AccountExport,
  accountExportSheets,
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
 */

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
    const { sheets } = accountExportSheets(DATA, AT);
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
    const { sheets } = accountExportSheets(DATA, AT);
    const holdings = sheets.find((s) => s.name === 'Holdings');
    expect(holdings?.headers).toContain('Balance');
  });

  it('drops every value column and says so when amounts are withheld', () => {
    const { sheets, provenance } = accountExportSheets(DATA, AT, { hideAmounts: true });
    expect(provenance.amountsWithheld).toBe(true);

    expect(sheets.find((s) => s.name === 'Holdings')?.headers).not.toContain('Balance');
    expect(sheets.find((s) => s.name === 'Transactions')?.headers).not.toContain('Quantity');
    expect(sheets.find((s) => s.name === 'Vaults')?.headers).not.toContain('Saved (EUR)');
    expect(sheets.find((s) => s.name === 'Net worth history')?.headers).not.toContain('Net worth');
  });

  it('keeps the counts that are tallies rather than money', () => {
    const { sheets } = accountExportSheets(DATA, AT, { hideAmounts: true });
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
    const { sheets } = accountExportSheets(DATA, AT, { hideAmounts: true });
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
