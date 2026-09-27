import { describe, expect, it } from 'bun:test';
import type { ParsedTransaction } from '@scani/file-import';
import {
  type StatementResolveTokenFn,
  StatementTransactionIngester,
} from '../src/StatementTransactionIngester';

/**
 * SC-1325 — statement rows used to leave `counterparty` NULL, so no
 * per-counterparty review rule could ever match a bank payment, and every
 * debit waited in Review on its own.
 */

const resolver: StatementResolveTokenFn = {
  resolveFiatTokenBySymbol: async (symbol) =>
    symbol === 'EUR' ? { holdingId: 'h-eur', tokenId: 't-eur' } : null,
};

const ingest = (transactions: ParsedTransaction[]) =>
  new StatementTransactionIngester().ingest({
    userId: 'u1',
    accountId: 'a1',
    parseResult: { transactions, holdings: [], format: 'csv', warnings: [] },
    resolveToken: resolver,
  });

const row = (description: string, amount: number, fee?: number): ParsedTransaction => ({
  date: new Date('2026-09-02T00:00:00Z'),
  description,
  amount,
  currency: 'EUR',
  ...(fee === undefined ? {} : { fee }),
});

describe('StatementTransactionIngester — payee as counterparty', () => {
  it('a debit and a credit carry the payee their description names', async () => {
    const { transactions } = await ingest([
      row('RENT SEP 2026 #4411', -1100),
      row('SALARY ACME LTD', 3200),
    ]);
    expect(transactions.map((t) => t.counterparty)).toEqual(['RENT', 'SALARY ACME LTD']);
  });

  it('marks where the value came from, so a reader can tell it from an address', async () => {
    const { transactions } = await ingest([row('RENT OCT', -1100)]);
    expect(transactions[0]?.sourceMetadata).toMatchObject({ counterpartyFrom: 'description' });
  });

  it('bank wording alone leaves it empty and unmarked', async () => {
    const { transactions } = await ingest([row('CARD PAYMENT 02/09', -20)]);
    expect(transactions[0]?.counterparty ?? null).toBeNull();
    expect(transactions[0]?.sourceMetadata).not.toHaveProperty('counterpartyFrom');
  });

  it('a fee row names no payee: the bank charged it, not the shop', async () => {
    const { transactions } = await ingest([row('TESCO STORES 2231', -84.2, 0.5)]);
    const [movement, fee] = transactions;
    expect(movement?.counterparty).toBe('TESCO STORES');
    expect(fee?.kind).toBe('fee');
    expect(fee?.counterparty ?? null).toBeNull();
  });
});
