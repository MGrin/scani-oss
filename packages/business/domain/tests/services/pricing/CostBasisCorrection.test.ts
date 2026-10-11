process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { CostBasisService } from '../../../src/services/pricing/CostBasisService';
import { PriceReader } from '../../../src/services/pricing/PriceReader';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { priceReaderStub } from '../../../test/helpers/price-series';

/**
 * A `correction` row restates a figure the owner says was wrong (SC-1563).
 * The walk skipped it, so a correction down left units in the pool the
 * balance no longer held. Now those leave at pool cost with nothing realized.
 * A correction up still opens no lot, since nothing was paid for a typo, but
 * the basis says it is incomplete instead of a later sale reading those units
 * as gain (feeds, bus #22097).
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
function tx(p: {
  kind: string;
  quantity: string;
  occurredAt: string;
  price?: string;
}): HoldingTransaction {
  txSeq += 1;
  return {
    id: `cr-tx-${txSeq}`,
    userId: 'u',
    holdingId: 'A',
    tokenId: USDT,
    kind: p.kind,
    quantity: p.quantity,
    priceNative: p.price ?? null,
    priceNativeTokenId: p.price ? USD : null,
    counterTokenId: null,
    counterQuantity: null,
    counterPriceNative: null,
    counterPriceNativeTokenId: null,
    feeQuantity: null,
    feeTokenId: null,
    settlesTransactionId: null,
    occurredAt: new Date(p.occurredAt),
    externalId: `cr-ext-${txSeq}`,
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

async function walk(rows: HoldingTransaction[]) {
  return makeService().walkLots(undefined, rows, USD, USDT, undefined, 'complete');
}

const qtyOf = (lots: ReadonlyArray<{ qty: Decimal }>) =>
  lots.reduce((sum, l) => sum.add(l.qty), new Decimal(0)).toString();

describe('CostBasisService — a correction row (SC-1563)', () => {
  test('a correction down removes its units at the pool average, nothing realized', async () => {
    // Under fifo a draw would take the oldest lot (cost 8, leaving 92). The
    // units never existed, so the cost per unit must not move: 18 at 5 = 90.
    const r = await walk([
      tx({ kind: 'buy', quantity: '10', occurredAt: '2024-01-01', price: '4' }),
      tx({ kind: 'buy', quantity: '10', occurredAt: '2024-01-02', price: '6' }),
      tx({ kind: 'correction', quantity: '-2', occurredAt: '2024-01-03' }),
    ]);
    expect(r.openQty.toString()).toBe('18');
    expect(r.costBasis.toString()).toBe('90');
    expect(r.realizedPnl.toString()).toBe('0');
    expect(r.basisQuality).toBe('known');
  });

  test('a later sale after a correction down realizes against the averaged lots', async () => {
    // 18 left at 90 (average 5); fifo sells the 9 left of the first lot at
    // 4 each (36) and 1 of the second at 6, so 10 at 7 realize 70 - 42 = 28.
    const r = await walk([
      tx({ kind: 'buy', quantity: '10', occurredAt: '2024-01-01', price: '4' }),
      tx({ kind: 'buy', quantity: '10', occurredAt: '2024-01-02', price: '6' }),
      tx({ kind: 'correction', quantity: '-2', occurredAt: '2024-01-03' }),
      tx({ kind: 'sell', quantity: '-10', occurredAt: '2024-01-04', price: '7' }),
    ]);
    expect(r.openQty.toString()).toBe('8');
    expect(r.costBasis.toString()).toBe('48');
    expect(r.realizedPnl.toString()).toBe('28');
  });

  test('a correction up opens no lot and marks the basis partial', async () => {
    const r = await walk([
      tx({ kind: 'buy', quantity: '10', occurredAt: '2024-01-01', price: '4' }),
      tx({ kind: 'correction', quantity: '3', occurredAt: '2024-01-02' }),
    ]);
    expect(r.costBasis.toString()).toBe('40');
    expect(qtyOf(r.lots)).toBe('10');
    expect(r.basisQuality).toBe('partial');
  });

  test('a correction reverted nets out: no real lot leaves, the basis is known', async () => {
    const r = await walk([
      tx({ kind: 'buy', quantity: '10', occurredAt: '2024-01-01', price: '5' }),
      tx({ kind: 'correction', quantity: '10', occurredAt: '2024-01-02' }),
      tx({ kind: 'correction', quantity: '-10', occurredAt: '2024-01-03' }),
    ]);
    expect(qtyOf(r.lots)).toBe('10');
    expect(r.costBasis.toString()).toBe('50');
    expect(r.basisQuality).toBe('known');
  });

  test('a correction down larger than the pool marks the basis partial', async () => {
    const r = await walk([
      tx({ kind: 'buy', quantity: '2', occurredAt: '2024-01-01', price: '5' }),
      tx({ kind: 'correction', quantity: '-3', occurredAt: '2024-01-02' }),
    ]);
    expect(r.costBasis.toString()).toBe('0');
    expect(r.basisQuality).toBe('partial');
  });

  test('without a correction the same ledger is known (control)', async () => {
    const r = await walk([
      tx({ kind: 'buy', quantity: '10', occurredAt: '2024-01-01', price: '4' }),
    ]);
    expect(r.basisQuality).toBe('known');
  });
});
