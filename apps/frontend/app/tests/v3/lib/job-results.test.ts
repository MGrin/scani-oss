import '../../i18n-preload';
import { describe, expect, test } from 'bun:test';
import {
  capList,
  readBudgetAppImport,
  readBudgetAppUndo,
  readExchangeImport,
  readFileImport,
  readGenericJobResult,
  readManualHoldings,
} from '../../../src/v3/lib/job-results';

describe('a capped list', () => {
  test('counts what it cut', () => {
    expect(capList(['a', 'b', 'c'], 2)).toEqual({ shown: ['a', 'b'], remaining: 1 });
  });

  test('reports nothing remaining when everything fits', () => {
    expect(capList(['a'], 5)).toEqual({ shown: ['a'], remaining: 0 });
  });
});

describe('exchange-import', () => {
  test('separates connected-and-empty from failed', () => {
    expect(
      readExchangeImport({ accountsCreated: 2, tokensImported: 0, errors: [] }).connectedButEmpty
    ).toBe(true);
    expect(
      readExchangeImport({ accountsCreated: 2, tokensImported: 0, errors: ['boom'] })
        .connectedButEmpty
    ).toBe(false);
    expect(
      readExchangeImport({ accountsCreated: 0, tokensImported: 0, errors: [] }).connectedButEmpty
    ).toBe(false);
  });

  test('carries the account type into the error line', () => {
    expect(
      readExchangeImport({ errors: [{ accountType: 'margin', error: 'signature invalid' }] }).errors
    ).toEqual(['margin: signature invalid']);
  });
});

describe('file-import', () => {
  const base = {
    format: 'csv',
    accountId: 'acc-1',
    transactionCount: 4,
    observationCount: 1,
    holdingsCreated: ['h1'],
    holdingsTouched: [
      {
        holdingId: 'h1',
        symbol: 'BTC',
        name: 'Bitcoin',
        transactionCount: 3,
        closingBalance: '0.00007715',
      },
      {
        holdingId: 'h2',
        symbol: 'USD',
        name: 'US Dollar',
        transactionCount: 1,
        closingBalance: null,
      },
    ],
    warnings: ['row 4 skipped'],
  };

  test('refuses a payload it cannot read rather than rendering zeroes', () => {
    expect(readFileImport({ accountId: 'a' })).toBeNull();
    expect(readFileImport(null)).toBeNull();
  });

  test('marks the created holdings apart from the touched ones', () => {
    const view = readFileImport(base);
    expect(view?.holdings.map((h) => h.isNew)).toEqual([true, false]);
    expect(view?.newHoldingCount).toBe(1);
  });

  test('keeps a sub-cent closing balance canonical rather than rounding it', () => {
    // v2 hands this to `formatCurrency(balance, symbol)` at two decimals, so
    // 0.00007715 BTC renders as `BTC 0.00` — a claim the position is empty.
    expect(readFileImport(base)?.holdings[0]?.closingBalance).toBe('0.00007715');
  });

  test('an AI column mapping is a fact about the parse, not a warning (SC-1527)', () => {
    // The worker appends this line whenever it asked the model for the
    // columns, which on a plain `date,description,amount,currency` CSV is every
    // time — and the job page listed it under "1 warning".
    const view = readFileImport({
      ...base,
      warnings: ['Column mapping detected by AI', 'row 4 skipped'],
    });
    expect(view?.warnings).toEqual(['row 4 skipped']);
    expect(view?.columnsMatchedAutomatically).toBe(true);
    expect(readFileImport(base)?.columnsMatchedAutomatically).toBe(false);
  });

  test('a missing closing balance stays null, not zero', () => {
    expect(readFileImport(base)?.holdings[1]?.closingBalance).toBeNull();
  });

  test('a created holding with no close carries the balance its rows gave it (SC-1324)', () => {
    const view = readFileImport({
      ...base,
      holdingsCreated: ['h2'],
      holdingsTouched: [
        { ...base.holdingsTouched[1], balanceFrom: 'imported-rows', rowsBalance: '2012.3' },
      ],
    });
    expect(view?.holdings[0]).toMatchObject({
      balanceFrom: 'imported-rows',
      rowsBalance: '2012.3',
    });
  });

  test('a spending-only file reads as unknown, with no figure', () => {
    const view = readFileImport({
      ...base,
      holdingsTouched: [{ ...base.holdingsTouched[1], balanceFrom: 'unknown', rowsBalance: null }],
    });
    expect(view?.holdings[0]).toMatchObject({ balanceFrom: 'unknown', rowsBalance: null });
  });

  test('a result written before SC-1324 reads as unchanged, and an unknown word does too', () => {
    expect(readFileImport(base)?.holdings[1]?.balanceFrom).toBe('unchanged');
    const odd = readFileImport({
      ...base,
      holdingsTouched: [{ ...base.holdingsTouched[1], balanceFrom: 'guessed' }],
    });
    expect(odd?.holdings[0]?.balanceFrom).toBe('unchanged');
  });

  test('reads the currency prompt when the parse stopped for one', () => {
    const view = readFileImport({
      ...base,
      needsCurrency: {
        r2Key: 'u/1/file.csv',
        fileType: 'csv',
        transactionCount: 12,
        transactionPreview: [{ date: '2026-01-02T00:00:00Z', description: 'Coffee', amount: -3.4 }],
      },
    });
    expect(view?.needsCurrency?.r2Key).toBe('u/1/file.csv');
    expect(view?.needsCurrency?.preview).toEqual([
      { date: '2026-01-02T00:00:00Z', description: 'Coffee', amount: -3.4 },
    ]);
  });

  test('carries a date order already chosen into the currency prompt (SC-1291)', () => {
    const view = readFileImport({
      ...base,
      needsCurrency: { r2Key: 'k', fileType: 'csv', transactionCount: 1, dateOrder: 'day-first' },
    });
    expect(view?.needsCurrency?.dateOrder).toBe('day-first');
  });

  test('reads the date-order prompt when the parse stopped for one (SC-1291)', () => {
    const view = readFileImport({
      ...base,
      needsDateOrder: {
        r2Key: 'u/1/file.csv',
        fileType: 'csv',
        rowCount: 3,
        samples: ['03/04/2026', '05/06/2026'],
        defaultCurrency: 'EUR',
      },
    });
    expect(view?.needsDateOrder).toEqual({
      r2Key: 'u/1/file.csv',
      fileType: 'csv',
      rowCount: 3,
      samples: ['03/04/2026', '05/06/2026'],
      defaultCurrency: 'EUR',
    });
    expect(readFileImport(base)?.needsDateOrder).toBeNull();
  });
});

describe('manual-holdings-create', () => {
  test('a row with no resolvable price has no value, rather than a value of zero', () => {
    const view = readManualHoldings({
      accountId: 'acc-1',
      holdings: [
        { id: 'a', symbol: 'BTC', balance: '2', priceUsd: '50000', priceSource: 'coingecko' },
        { id: 'b', symbol: 'XYZ', balance: '3', error: 'no price source' },
        { id: 'c', symbol: 'ABC', balance: '1' },
      ],
    });
    expect(view?.rows.map((r) => r.value)).toEqual([100000, null, null]);
    expect(view?.pricedCount).toBe(1);
    expect(view?.unpricedCount).toBe(2);
  });

  test('a zero price is a price', () => {
    const view = readManualHoldings({
      accountId: 'acc-1',
      holdings: [{ id: 'a', symbol: 'DEAD', balance: '10', priceUsd: '0' }],
    });
    expect(view?.rows[0]?.value).toBe(0);
    expect(view?.pricedCount).toBe(1);
  });

  test('refuses a payload it cannot read', () => {
    expect(readManualHoldings({ holdings: [] })).toBeNull();
  });

  test('an update the feed kept as a check says so (A5 D-20)', () => {
    const view = readManualHoldings({
      accountId: 'acc-1',
      holdings: [
        { id: 'a', symbol: 'BTC', balance: '120', typedBalance: '150', isUpdate: true },
        { id: 'b', symbol: 'ETH', balance: '2.50', typedBalance: '2.5', isUpdate: true },
        { id: 'c', symbol: 'SOL', balance: '9', isUpdate: false },
        { id: 'd', symbol: 'ABC', balance: '4', isUpdate: true },
      ],
    });
    expect(view?.rows.map((r) => r.savedAsCheck)).toEqual([true, false, false, false]);
  });

  test('an unreadable figure claims nothing rather than throwing', () => {
    const view = readManualHoldings({
      accountId: 'acc-1',
      holdings: [{ id: 'a', symbol: 'BTC', balance: '120', typedBalance: 'x', isUpdate: true }],
    });
    expect(view?.rows[0]?.savedAsCheck).toBe(false);
  });
});

describe('the fallback', () => {
  test('a null result is not a result', () => {
    expect(readGenericJobResult(null)).toBeNull();
    expect(readGenericJobResult(undefined)).toBeNull();
  });

  test('keeps the payload field names rather than manufacturing English', () => {
    const view = readGenericJobResult({ accountsCreated: 2, note: 'x', ratio: 0.5 });
    expect(view?.stats).toEqual([
      { key: 'accountsCreated', value: 2 },
      { key: 'ratio', value: 0.5 },
    ]);
  });

  test('knows when it has nothing to say', () => {
    expect(readGenericJobResult({})?.isEmpty).toBe(true);
    expect(readGenericJobResult({ message: 'done' })?.isEmpty).toBe(false);
  });
});

describe('a budget app import result (SC-1649)', () => {
  test('counts the rows each account took, and leaves out the accounts skipped', () => {
    const view = readBudgetAppImport({
      importId: 'i1',
      summary: {
        accounts: [
          { name: 'Checking', accountId: 'a1', created: true, rowsInserted: 3, rowsUpdated: 0 },
          { name: 'Savings', accountId: 'a2', created: false, rowsInserted: 1, rowsUpdated: 2 },
          { name: 'Old card', accountId: null, created: false, rowsInserted: 0, rowsUpdated: 0 },
        ],
        transfersPaired: 1,
        transfersUnpaired: 2,
        skippedRows: [
          { line: 4, reason: 'zero-amount' },
          { line: 7, reason: 'split-parent' },
        ],
      },
    });
    expect(view).toMatchObject({
      importId: 'i1',
      rowsInserted: 4,
      transfersPaired: 1,
      transfersUnpaired: 2,
      skippedRows: 1,
    });
    expect(view?.accounts.map((a) => a.name)).toEqual(['Checking', 'Savings']);
  });

  test('a result with no import id is not read as one', () => {
    expect(readBudgetAppImport({ summary: { accounts: [] } })).toBeNull();
  });

  test('an undo reads what it removed and what it kept', () => {
    expect(readBudgetAppUndo({ rowsRemoved: 4, accountsRemoved: 1, accountsKept: 1 })).toEqual({
      rowsRemoved: 4,
      accountsRemoved: 1,
      accountsKept: 1,
    });
    expect(readBudgetAppUndo({})).toBeNull();
  });
});
