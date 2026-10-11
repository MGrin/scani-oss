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
 * A `fee` row that settles no trade is an outflow at zero proceeds (SC-1561).
 *
 * The walk skipped it as an unknown kind, so its units left the balance and
 * never left the lot pool: a holding that holds nothing was stored as costing
 * something and losing all of it. Its cost is a realized loss now, and the
 * falsifier is that TOTAL PnL does not move: cost basis falls by exactly what
 * realized falls by.
 */

restoreContainerAfterAll();

const USD = 'token-USD';
const ETH = 'token-ETH';

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
  priceNative?: string;
  settlesTransactionId?: string;
}): HoldingTransaction {
  txSeq += 1;
  return {
    id: `sf-tx-${txSeq}`,
    userId: 'u',
    holdingId: 'A',
    tokenId: ETH,
    kind: p.kind,
    quantity: p.quantity,
    priceNative: p.priceNative ?? null,
    priceNativeTokenId: p.priceNative ? USD : null,
    counterTokenId: null,
    counterQuantity: null,
    counterPriceNative: null,
    counterPriceNativeTokenId: null,
    feeQuantity: null,
    feeTokenId: null,
    settlesTransactionId: p.settlesTransactionId ?? null,
    occurredAt: new Date(p.occurredAt),
    externalId: `sf-ext-${txSeq}`,
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

/** 10 bought at 100, 1 more at 200, a 0.5 fee, then all 10.5 left sold at 300. */
function ledger(): HoldingTransaction[] {
  return [
    tx({ kind: 'buy', quantity: '10', occurredAt: '2024-01-01', priceNative: '100' }),
    tx({ kind: 'buy', quantity: '1', occurredAt: '2024-02-01', priceNative: '200' }),
    tx({ kind: 'fee', quantity: '-0.5', occurredAt: '2024-02-01' }),
    tx({ kind: 'sell', quantity: '-10.5', occurredAt: '2024-03-01', priceNative: '300' }),
  ];
}

async function walk(rows: HoldingTransaction[], collect?: DisposalLotMatch[]) {
  return makeService().walkLots(undefined, rows, USD, ETH, undefined, 'complete', collect);
}

describe('CostBasisService — a standalone fee row (SC-1561)', () => {
  test('leaves no lot behind once the balance is zero', async () => {
    const r = await walk(ledger());
    expect(r.openQty.toString()).toBe('0');
    expect(r.costBasis.toString()).toBe('0');
    expect(r.lots).toHaveLength(0);
  });

  test('books the fee units at cost as a realized loss, priced at nothing', async () => {
    const collect: DisposalLotMatch[] = [];
    const r = await walk(ledger(), collect);
    // FIFO: the fee takes 0.5 of the first lot (cost 50); the sale takes the
    // other 9.5 at 100 and the 1 at 200 = 1,150 against 3,150 of proceeds.
    expect(r.realizedPnl.toString()).toBe(new Decimal(3150).minus(1150).minus(50).toString());
    const feeRows = collect.filter((row) => row.outcome === 'fee');
    expect(feeRows).toHaveLength(1);
    expect(r.feesRealized?.size).toBe(1);
    expect(r.feesRealized?.has(feeRows[0]?.transactionId ?? '')).toBe(true);
    expect(feeRows[0]?.quantity.toString()).toBe('0.5');
    expect(feeRows[0]?.proceeds).toBeNull();
    expect(feeRows[0]?.gain).toBeNull();
  });

  test('leaves total PnL where it was: cost basis falls by what realized falls by', async () => {
    // Before the fix the walk skipped the fee row, which is exactly a walk of
    // the same ledger without it.
    const before = await walk(ledger().filter((t) => t.kind !== 'fee'));
    const after = await walk(ledger());
    const totalBefore = before.realizedPnl.minus(before.costBasis);
    const totalAfter = after.realizedPnl.minus(after.costBasis);
    expect(totalAfter.toString()).toBe(totalBefore.toString());
    expect(before.costBasis.gt(0)).toBe(true);
  });

  test('with a balance left, cost basis is that of the units still held', async () => {
    const rows = ledger().slice(0, 3);
    const r = await walk(rows);
    expect(r.openQty.toString()).toBe('10.5');
    // 9.5 at 100 + 1 at 200; the 0.5 that left is no longer in the pool.
    expect(r.costBasis.toString()).toBe('1150');
    expect(r.realizedPnl.toString()).toBe('-50');
  });

  test('a commission paid from the trade’s own holding cuts the quantity and keeps its cost', async () => {
    // SC-1464 keeps that commission a cost of what is left, and SC-1486 keeps
    // it off the trade: its units leave, their cost stays, nothing realized.
    const rows = [
      tx({ kind: 'buy', quantity: '10', occurredAt: '2024-01-01', priceNative: '100' }),
      tx({
        kind: 'fee',
        quantity: '-0.5',
        occurredAt: '2024-01-01',
        settlesTransactionId: 'sf-tx-same',
      }),
    ];
    rows[0] = { ...rows[0], id: 'sf-tx-same' } as HoldingTransaction;
    const r = await walk(rows);
    expect(r.openQty.toString()).toBe('9.5');
    expect(r.costBasis.toString()).toBe('1000');
    expect(r.realizedPnl.toString()).toBe('0');
    expect(r.feesRealized?.size).toBe(0);
  });

  test('a commission paid from base-currency cash is realized, the cash stays at par', async () => {
    // Base cash carries its value as cost basis (SC-1467), so a commission's
    // cost kept on the lots left would surface as a loss on the next spend and
    // again through baseCashFees. It is realized once, here.
    const rows = [
      { ...tx({ kind: 'deposit', quantity: '100', occurredAt: '2024-01-01' }), tokenId: USD },
      {
        ...tx({
          kind: 'fee',
          quantity: '-1',
          occurredAt: '2024-01-02',
          settlesTransactionId: 'sf-cash',
        }),
        tokenId: USD,
      },
    ] as HoldingTransaction[];
    rows[0] = { ...rows[0], id: 'sf-cash' } as HoldingTransaction;
    const r = await makeService().walkLots(undefined, rows, USD, USD, undefined, 'complete');
    expect(r.openQty.toString()).toBe('99');
    expect(r.costBasis.toString()).toBe('99');
    expect(r.realizedPnl.toString()).toBe('-1');
    expect(r.feesRealized?.has(rows[1]?.id ?? '')).toBe(true);
  });

  test('a base-cash fee past the lots realizes its whole amount, the shortfall at par', async () => {
    // feesRealized tells baseCashFees to skip the WHOLE fee, so the part the
    // pool could not pay must be realized here or it is counted nowhere.
    const rows = [
      { ...tx({ kind: 'deposit', quantity: '3', occurredAt: '2024-01-01' }), tokenId: USD },
      { ...tx({ kind: 'fee', quantity: '-5', occurredAt: '2024-01-02' }), tokenId: USD },
    ] as HoldingTransaction[];
    const r = await makeService().walkLots(undefined, rows, USD, USD, undefined, 'complete');
    expect(r.realizedPnl.toString()).toBe('-5');
    expect(r.feesRealized?.has(rows[1]?.id ?? '')).toBe(true);
  });
});
