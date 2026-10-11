process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import {
  CostBasisService,
  type DisposalLotMatch,
} from '../../../src/services/pricing/CostBasisService';
import { PriceReader } from '../../../src/services/pricing/PriceReader';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { priceReaderStub } from '../../../test/helpers/price-series';

/**
 * A `realized_pnl` row is a derivatives result settled in the margin coin
 * (SC-1563). The walk skipped it as an unknown kind, so a gain's units were in
 * the balance with no lot and a loss's units stayed in the pool after they had
 * gone. A gain now opens a lot at its worth that day, as income, like
 * `interest`; a loss leaves at zero proceeds and its cost is realized, like a
 * standalone `fee` (operator, bus #22095).
 */

restoreContainerAfterAll();

const USD = 'token-USD';
const USDT = 'token-USDT';

function makeService(): CostBasisService {
  Container.set(HoldingRepository, {} as unknown as HoldingRepository);
  Container.set(HoldingTransactionRepository, {} as unknown as HoldingTransactionRepository);
  Container.set(
    PriceReader,
    priceReaderStub((amount: Decimal) => ({ amount: new Decimal(amount), stale: false }))
  );
  const instance = new CostBasisService();
  Container.set(CostBasisService, instance);
  return instance;
}

let txSeq = 0;
function tx(p: { kind: string; quantity: string; occurredAt: string }): HoldingTransaction {
  txSeq += 1;
  return {
    id: `rp-tx-${txSeq}`,
    userId: 'u',
    holdingId: 'A',
    tokenId: USDT,
    kind: p.kind,
    quantity: p.quantity,
    priceNative: '1',
    priceNativeTokenId: USD,
    counterTokenId: null,
    counterQuantity: null,
    counterPriceNative: null,
    counterPriceNativeTokenId: null,
    feeQuantity: null,
    feeTokenId: null,
    settlesTransactionId: null,
    occurredAt: new Date(p.occurredAt),
    externalId: `rp-ext-${txSeq}`,
    swapGroupId: null,
    transferGroupId: null,
    transferReview: null,
    transferReviewSplit: null,
    transferReviewedAt: null,
    transferReviewSource: null,
    transferReviewRuleId: null,
    source: 's',
    sourceMetadata: {},
    rawPayload: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as HoldingTransaction;
}

async function walk(rows: HoldingTransaction[], collect?: DisposalLotMatch[]) {
  return makeService().walkLots(undefined, rows, USD, USDT, undefined, 'complete', collect);
}

describe('CostBasisService — a realized_pnl row (SC-1563)', () => {
  test('a gain opens a lot at its worth that day, booked as income', async () => {
    const r = await walk([
      tx({ kind: 'deposit', quantity: '100', occurredAt: '2024-01-01' }),
      tx({ kind: 'realized_pnl', quantity: '20', occurredAt: '2024-01-02' }),
    ]);
    expect(r.openQty.toString()).toBe('120');
    expect(r.costBasis.toString()).toBe('120');
    expect(r.income?.toString()).toBe('20');
    expect(r.realizedPnl.toString()).toBe('0');
  });

  test('a gain is walked exactly as the same row written as interest', async () => {
    const asPnl = await walk([
      tx({ kind: 'deposit', quantity: '100', occurredAt: '2024-01-01' }),
      tx({ kind: 'realized_pnl', quantity: '20', occurredAt: '2024-01-02' }),
    ]);
    const asInterest = await walk([
      tx({ kind: 'deposit', quantity: '100', occurredAt: '2024-01-01' }),
      tx({ kind: 'interest', quantity: '20', occurredAt: '2024-01-02' }),
    ]);
    expect(asPnl.costBasis.toString()).toBe(asInterest.costBasis.toString());
    expect(asPnl.income?.toString()).toBe(asInterest.income?.toString());
  });

  test('a loss leaves the pool at cost, realized as a loss', async () => {
    const r = await walk([
      tx({ kind: 'deposit', quantity: '100', occurredAt: '2024-01-01' }),
      tx({ kind: 'realized_pnl', quantity: '-30', occurredAt: '2024-01-02' }),
    ]);
    expect(r.openQty.toString()).toBe('70');
    expect(r.costBasis.toString()).toBe('70');
    expect(r.realizedPnl.toString()).toBe('-30');
  });

  test('a loss is walked exactly as the same row written as a standalone fee', async () => {
    const asPnl = await walk([
      tx({ kind: 'deposit', quantity: '100', occurredAt: '2024-01-01' }),
      tx({ kind: 'realized_pnl', quantity: '-30', occurredAt: '2024-01-02' }),
    ]);
    const asFee = await walk([
      tx({ kind: 'deposit', quantity: '100', occurredAt: '2024-01-01' }),
      tx({ kind: 'fee', quantity: '-30', occurredAt: '2024-01-02' }),
    ]);
    expect(asPnl.costBasis.toString()).toBe(asFee.costBasis.toString());
    expect(asPnl.realizedPnl.toString()).toBe(asFee.realizedPnl.toString());
  });

  test('a holding that settled to nothing keeps no lot', async () => {
    const r = await walk([
      tx({ kind: 'deposit', quantity: '100', occurredAt: '2024-01-01' }),
      tx({ kind: 'realized_pnl', quantity: '15', occurredAt: '2024-01-02' }),
      tx({ kind: 'realized_pnl', quantity: '-115', occurredAt: '2024-01-03' }),
    ]);
    expect(r.openQty.toString()).toBe('0');
    expect(r.costBasis.toString()).toBe('0');
    expect(r.lots).toHaveLength(0);
  });

  test('a loss is its own outcome on the ledger, not a fee', async () => {
    const collect: DisposalLotMatch[] = [];
    const r = await walk(
      [
        tx({ kind: 'deposit', quantity: '100', occurredAt: '2024-01-01' }),
        tx({ kind: 'realized_pnl', quantity: '-30', occurredAt: '2024-01-02' }),
      ],
      collect
    );
    expect(collect.map((row) => row.outcome)).toEqual(['derivative_loss']);
    expect(r.feesRealized?.size).toBe(0);
  });
});
