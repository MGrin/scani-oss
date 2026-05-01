import { describe, expect, it } from 'bun:test';
import type { ParsedTransaction, ParseResult } from '@scani/file-import';
import {
  type StatementResolveTokenFn,
  StatementTransactionIngester,
} from '../src/StatementTransactionIngester';

const makeResolver = (
  table: Record<string, { holdingId: string; tokenId: string }>
): { resolver: StatementResolveTokenFn; lookups: string[] } => {
  const lookups: string[] = [];
  return {
    lookups,
    resolver: {
      resolveFiatTokenBySymbol: async (symbol) => {
        lookups.push(symbol);
        return table[symbol] ?? null;
      },
    },
  };
};

const makeParseResult = (
  transactions: ParsedTransaction[],
  overrides: Partial<ParseResult> = {}
): ParseResult => ({
  transactions,
  holdings: [],
  format: 'csv',
  warnings: [],
  ...overrides,
});

describe('StatementTransactionIngester', () => {
  it('returns empty result when ParseResult has no transactions', async () => {
    const ingester = new StatementTransactionIngester();
    const { resolver } = makeResolver({});
    const result = await ingester.ingest({
      userId: 'u1',
      accountId: 'a1',
      parseResult: makeParseResult([]),
      resolveToken: resolver,
    });
    expect(result.transactions).toEqual([]);
    expect(result.observations).toEqual([]);
    expect(result.firstEventAt).toBeNull();
    expect(result.lastEventAt).toBeNull();
  });

  it('resolves currencies, caches lookups, and tags source by format', async () => {
    const ingester = new StatementTransactionIngester();
    const { resolver, lookups } = makeResolver({
      USD: { holdingId: 'h-usd', tokenId: 't-usd' },
    });
    const txs: ParsedTransaction[] = [
      { date: new Date('2024-03-15'), description: 'Coffee', amount: -5, currency: 'USD' },
      { date: new Date('2024-03-16'), description: 'Salary', amount: 1000, currency: 'USD' },
    ];
    const result = await ingester.ingest({
      userId: 'u1',
      accountId: 'a1',
      parseResult: makeParseResult(txs, { format: 'csv', bankTemplate: 'wise' }),
      resolveToken: resolver,
    });
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]?.source).toBe('statement-csv');
    expect(result.transactions[0]?.holdingId).toBe('h-usd');
    expect(result.transactions[0]?.tokenId).toBe('t-usd');
    // Cached: only one lookup despite two USD rows.
    expect(lookups).toEqual(['USD']);
  });

  it('maps positive amounts to deposit and negative to withdraw', async () => {
    const ingester = new StatementTransactionIngester();
    const { resolver } = makeResolver({ EUR: { holdingId: 'h', tokenId: 't' } });
    const txs: ParsedTransaction[] = [
      { date: new Date('2024-03-15'), description: 'pos', amount: 50, currency: 'EUR' },
      { date: new Date('2024-03-15'), description: 'neg', amount: -25, currency: 'EUR' },
    ];
    const result = await ingester.ingest({
      userId: 'u1',
      accountId: 'a1',
      parseResult: makeParseResult(txs),
      resolveToken: resolver,
    });
    expect(result.transactions[0]?.kind).toBe('deposit');
    expect(result.transactions[1]?.kind).toBe('withdraw');
  });

  it('warns and skips rows when currency is unresolvable', async () => {
    const ingester = new StatementTransactionIngester();
    const { resolver } = makeResolver({ EUR: { holdingId: 'h', tokenId: 't' } });
    const txs: ParsedTransaction[] = [
      { date: new Date('2024-03-15'), description: 'kept', amount: 10, currency: 'EUR' },
      { date: new Date('2024-03-15'), description: 'unknown', amount: 5, currency: 'XYZ' },
    ];
    const result = await ingester.ingest({
      userId: 'u1',
      accountId: 'a1',
      parseResult: makeParseResult(txs),
      resolveToken: resolver,
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]?.tokenId).toBe('t');
    expect(result.warnings.some((w) => w.includes("'XYZ'"))).toBe(true);
  });

  it('falls back to defaultCurrency / detectedCurrency when row has no currency', async () => {
    const ingester = new StatementTransactionIngester();
    const { resolver } = makeResolver({ GBP: { holdingId: 'h', tokenId: 't' } });
    const txs: ParsedTransaction[] = [
      { date: new Date('2024-03-15'), description: 'no-currency', amount: 10, currency: '' },
    ];
    const result = await ingester.ingest({
      userId: 'u1',
      accountId: 'a1',
      parseResult: makeParseResult(txs, { detectedCurrency: 'GBP' }),
      resolveToken: resolver,
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]?.tokenId).toBe('t');
  });

  it('warns and skips when no currency can be derived', async () => {
    const ingester = new StatementTransactionIngester();
    const { resolver } = makeResolver({});
    const txs: ParsedTransaction[] = [
      { date: new Date('2024-03-15'), description: 'orphan', amount: 10, currency: '' },
    ];
    const result = await ingester.ingest({
      userId: 'u1',
      accountId: 'a1',
      parseResult: makeParseResult(txs),
      resolveToken: resolver,
    });
    expect(result.transactions).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('without currency'))).toBe(true);
  });

  it('emits a closing-balance observation when the last row has a balance', async () => {
    const ingester = new StatementTransactionIngester();
    const { resolver } = makeResolver({ USD: { holdingId: 'h-usd', tokenId: 't-usd' } });
    const txs: ParsedTransaction[] = [
      { date: new Date('2024-03-15'), description: 'a', amount: 100, currency: 'USD' },
      {
        date: new Date('2024-03-16'),
        description: 'b',
        amount: -25,
        currency: 'USD',
        balance: 75,
      },
    ];
    const result = await ingester.ingest({
      userId: 'u1',
      accountId: 'a1',
      parseResult: makeParseResult(txs),
      resolveToken: resolver,
    });
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.balance).toBe('75');
    expect(result.observations[0]?.holdingId).toBe('h-usd');
    expect(result.observations[0]?.source).toBe('statement-close');
  });

  it('does not emit a closing-balance observation when the last row lacks a balance', async () => {
    const ingester = new StatementTransactionIngester();
    const { resolver } = makeResolver({ USD: { holdingId: 'h', tokenId: 't' } });
    const txs: ParsedTransaction[] = [
      { date: new Date('2024-03-15'), description: 'a', amount: 100, currency: 'USD' },
    ];
    const result = await ingester.ingest({
      userId: 'u1',
      accountId: 'a1',
      parseResult: makeParseResult(txs),
      resolveToken: resolver,
    });
    expect(result.observations).toHaveLength(0);
  });

  it('uses natural external-id when raw payload exposes one', async () => {
    const ingester = new StatementTransactionIngester();
    const { resolver } = makeResolver({ USD: { holdingId: 'h', tokenId: 't' } });
    const txs: ParsedTransaction[] = [
      {
        date: new Date('2024-03-15'),
        description: 'tagged',
        amount: 10,
        currency: 'USD',
        raw: { fitid: 'OFX-12345' },
      },
    ];
    const result = await ingester.ingest({
      userId: 'u1',
      accountId: 'a1',
      parseResult: makeParseResult(txs, { format: 'ofx' }),
      resolveToken: resolver,
    });
    expect(result.transactions[0]?.externalId).toBe('natural:OFX-12345');
  });

  it('synthesizes external-id from (date, amount, description, ordinal) otherwise', async () => {
    const ingester = new StatementTransactionIngester();
    const { resolver } = makeResolver({ USD: { holdingId: 'h', tokenId: 't' } });
    const txs: ParsedTransaction[] = [
      { date: new Date('2024-03-15T10:00:00Z'), description: 'first', amount: 1, currency: 'USD' },
      { date: new Date('2024-03-15T10:00:00Z'), description: 'second', amount: 2, currency: 'USD' },
    ];
    const result = await ingester.ingest({
      userId: 'u1',
      accountId: 'a1',
      parseResult: makeParseResult(txs),
      resolveToken: resolver,
    });
    expect(result.transactions[0]?.externalId).toMatch(/^synthetic:.*:1:first:1$/);
    expect(result.transactions[1]?.externalId).toMatch(/^synthetic:.*:2:second:2$/);
    // Distinct external_ids guarantee re-uploads dedup row-by-row.
    expect(result.transactions[0]?.externalId).not.toBe(result.transactions[1]?.externalId);
  });

  it('reports earliest and latest event timestamps', async () => {
    const ingester = new StatementTransactionIngester();
    const { resolver } = makeResolver({ USD: { holdingId: 'h', tokenId: 't' } });
    const txs: ParsedTransaction[] = [
      { date: new Date('2024-03-16'), description: 'b', amount: 1, currency: 'USD' },
      { date: new Date('2024-03-15'), description: 'a', amount: 1, currency: 'USD' },
      { date: new Date('2024-03-17'), description: 'c', amount: 1, currency: 'USD' },
    ];
    const result = await ingester.ingest({
      userId: 'u1',
      accountId: 'a1',
      parseResult: makeParseResult(txs),
      resolveToken: resolver,
    });
    expect(result.firstEventAt?.toISOString()).toBe('2024-03-15T00:00:00.000Z');
    expect(result.lastEventAt?.toISOString()).toBe('2024-03-17T00:00:00.000Z');
  });
});
