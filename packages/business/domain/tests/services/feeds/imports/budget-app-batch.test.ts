import { describe, expect, it } from 'bun:test';
import type { BudgetAppRow } from '@scani/file-import';
import { budgetAppBatch } from '../../../../src/services/feeds/imports/budget-app-batch';

function row(over: Partial<BudgetAppRow>): BudgetAppRow {
  return {
    date: new Date('2026-08-14T00:00:00Z'),
    amount: '-84.23',
    payee: 'Grocer',
    memo: null,
    category: 'Everyday: Food',
    cleared: 'Cleared',
    flag: null,
    transferAccount: null,
    line: 2,
    ...over,
  };
}

function batchOf(rows: BudgetAppRow[]) {
  return budgetAppBatch({
    userId: 'u1',
    accountId: 'a1',
    app: 'ynab',
    currency: 'USD',
    rows,
    uploadRef: 'temp/file-import/u1/x.csv',
    fetchedAt: new Date('2026-10-09T12:00:00Z'),
  });
}

describe('budgetAppBatch', () => {
  it('books each row on the account under the app input, signed, with no checkpoint', () => {
    const batch = batchOf([
      row({}),
      row({ amount: '2500', payee: 'Employer', date: new Date('2026-08-15T00:00:00Z'), line: 3 }),
    ]);

    expect(batch.input).toEqual({
      accountId: 'a1',
      source: 'budget-ynab',
      credentialId: null,
      walletId: null,
    });
    expect(batch.checkpoints).toEqual([]);
    expect(batch.window).toEqual({
      shape: 'statement-upload',
      from: new Date('2026-08-14T00:00:00Z'),
      to: new Date('2026-08-15T00:00:00Z'),
      complete: false,
      uploadRef: 'temp/file-import/u1/x.csv',
    });
    expect(batch.entries.map((e) => [e.legacy.kind, e.amount, e.asset.identity.symbol])).toEqual([
      ['withdraw', '-84.23', 'USD'],
      ['deposit', '2500', 'USD'],
    ]);
    expect(batch.entries[0]).toMatchObject({
      counterparty: 'Grocer',
      legacy: {
        source: 'budget-ynab',
        sourceMetadata: { app: 'ynab', category: 'Everyday: Food', cleared: 'Cleared', line: 2 },
      },
    });
    expect(batch.legacy.createdWithoutCheckpoint).toBe('sum-of-entries');
  });

  it('names the other account as counterparty on a transfer, and keeps the memo as description', () => {
    const [entry] = batchOf([
      row({ payee: 'Transfer : Savings', transferAccount: 'Savings', memo: 'rainy day' }),
    ]).entries;
    expect(entry).toMatchObject({ counterparty: 'Savings', description: 'rainy day' });
    expect(entry!.legacy.sourceMetadata).toMatchObject({ transferAccount: 'Savings' });
  });

  it('gives the same row the same external id on every upload, and identical rows their order', () => {
    const rows = [row({ line: 2 }), row({ line: 3 }), row({ payee: 'Other', line: 4 })];
    const first = batchOf(rows).entries.map((e) => e.externalId);
    const again = batchOf(rows).entries.map((e) => e.externalId);

    expect(again).toEqual(first);
    expect(new Set(first).size).toBe(3);
    expect(first[0]!.endsWith(':1')).toBe(true);
    expect(first[1]!.endsWith(':2')).toBe(true);
    expect(first[2]!.endsWith(':1')).toBe(true);
  });

  it('leaves the line number out of the external id, so an overlapping file matches its rows', () => {
    const early = batchOf([row({ line: 2 })]).entries[0]!.externalId;
    const later = batchOf([row({ line: 40 })]).entries[0]!.externalId;
    expect(later).toBe(early);
  });
});
