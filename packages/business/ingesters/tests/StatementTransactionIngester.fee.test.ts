import { describe, expect, it } from 'bun:test';
import type { ParsedTransaction, ParseResult } from '@scani/file-import';
import Decimal from 'decimal.js';
import {
  type StatementResolveTokenFn,
  StatementTransactionIngester,
} from '../src/StatementTransactionIngester';

/**
 * SC-136 — the Revolut ATM row: `Amount -120.00, Fee 1.50`, and the statement's
 * own Balance column has moved by 121.50.
 *
 * The fee has to reach `quantity` on a row of its own, not `fee_quantity` on
 * the withdrawal. Nothing sums `fee_quantity`: the opening-balance reconciler
 * and balance-at-time both add up `quantity` alone, so a fee parked in the
 * sidecar column is visible in an export and still absent from every figure
 * derived from the ledger.
 */

const resolver: StatementResolveTokenFn = {
  resolveFiatTokenBySymbol: async (symbol) =>
    symbol === 'GBP' ? { holdingId: 'h-gbp', tokenId: 't-gbp' } : null,
};

const makeParseResult = (transactions: ParsedTransaction[]): ParseResult => ({
  transactions,
  holdings: [],
  format: 'csv',
  bankTemplate: 'revolut',
  warnings: [],
});

const ingest = (transactions: ParsedTransaction[]) =>
  new StatementTransactionIngester().ingest({
    userId: 'u1',
    accountId: 'a1',
    parseResult: makeParseResult(transactions),
    resolveToken: resolver,
  });

const atm: ParsedTransaction = {
  date: new Date('2026-07-15T10:00:00Z'),
  description: 'Cash at Barclays ATM',
  amount: -120,
  fee: 1.5,
  currency: 'GBP',
};

describe('StatementTransactionIngester — statement fees', () => {
  it('writes the fee as its own ledger row, not as a sidecar on the movement', async () => {
    const { transactions } = await ingest([atm]);
    expect(transactions).toHaveLength(2);

    const [movement, fee] = transactions;
    expect(movement?.kind).toBe('withdraw');
    expect(movement?.quantity).toBe('-120');
    // The sidecar stays empty: writing it here would look like a fix and
    // change no derived figure.
    expect(movement?.feeQuantity ?? null).toBeNull();

    expect(fee?.kind).toBe('fee');
    expect(fee?.quantity).toBe('-1.5');
    expect(fee?.holdingId).toBe('h-gbp');
    expect(fee?.tokenId).toBe('t-gbp');
  });

  // The whole point: `sum(quantity)` is what the opening-balance reconciler
  // subtracts from the anchored closing balance.
  it('the summed ledger now accounts for the full movement of the balance', async () => {
    const { transactions } = await ingest([atm]);
    const total = transactions.reduce((acc, t) => acc.add(new Decimal(t.quantity)), new Decimal(0));
    expect(total.toString()).toBe('-121.5');
  });

  it('anchors the fee at the same instant as the movement that incurred it', async () => {
    const { transactions } = await ingest([atm]);
    expect(transactions[1]?.occurredAt).toEqual(transactions[0]?.occurredAt as Date);
  });

  // `bulkUpsert` keys on (holding_id, source, external_id), so a re-upload has
  // to land on the same two rows rather than doubling the fee.
  it('gives the fee a stable id derived from its parent', async () => {
    const first = await ingest([atm]);
    const second = await ingest([atm]);
    expect(first.transactions[1]?.externalId).toBe(`${first.transactions[0]?.externalId}:fee`);
    expect(second.transactions.map((t) => t.externalId)).toEqual(
      first.transactions.map((t) => t.externalId)
    );
  });

  it('names the fee after the row it came from', async () => {
    const { transactions } = await ingest([atm]);
    const metadata = transactions[1]?.sourceMetadata as Record<string, unknown>;
    expect(metadata.description).toBe('Fee — Cash at Barclays ATM');
    expect(metadata.feeForExternalId).toBe(transactions[0]?.externalId);
  });

  // Every row of a Revolut export carries `Fee` — almost all of them 0.00.
  it.each([[undefined], [0]])('a fee of %p adds no row', async (fee) => {
    const { transactions } = await ingest([{ ...atm, fee: fee as number | undefined }]);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.kind).toBe('withdraw');
  });

  // A currency the resolver cannot place skips the movement; the fee must not
  // survive its own parent.
  it('drops the fee when the row it belongs to is skipped', async () => {
    const { transactions } = await ingest([{ ...atm, currency: 'XYZ' }]);
    expect(transactions).toEqual([]);
  });
});
