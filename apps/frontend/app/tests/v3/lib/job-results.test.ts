import '../../i18n-preload';
import { describe, expect, test } from 'bun:test';
import {
  capList,
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

  test('a missing closing balance stays null, not zero', () => {
    expect(readFileImport(base)?.holdings[1]?.closingBalance).toBeNull();
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
