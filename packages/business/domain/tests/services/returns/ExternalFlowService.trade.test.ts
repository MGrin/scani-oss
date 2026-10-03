process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';
import { DriftLedgerService } from '../../../src/services/returns/DriftLedgerService';
import { ExternalFlowService } from '../../../src/services/returns/ExternalFlowService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

/**
 * A trade's flow is what actually moved (SC-1470): its execution price at its
 * own instant, with the commission it paid. That is the value the cost walk
 * books, so the money side and PnL agree to the cent.
 */

restoreContainerAfterAll();

const USD = 'token-USD';
const CAD = 'token-CAD';
const STOCK = 'token-STOCK';
const FROM = new Date('2026-01-01T00:00:00Z');
const TO = new Date('2026-12-31T00:00:00Z');
const AT = new Date('2026-06-25T09:30:00Z');

function row(
  p: Partial<HoldingTransaction> & { kind: string; quantity: string }
): HoldingTransaction {
  return {
    id: `${p.holdingId ?? 'stock'}-${p.kind}-${p.quantity}`,
    userId: 'u',
    holdingId: p.holdingId ?? 'stock',
    tokenId: p.tokenId ?? STOCK,
    priceNative: null,
    priceNativeTokenId: null,
    feeQuantity: null,
    feeTokenId: null,
    settlesTransactionId: null,
    transferReview: null,
    transferReviewSplit: null,
    occurredAt: AT,
    ...p,
  } as HoldingTransaction;
}

function makeService(rows: HoldingTransaction[]) {
  const asked: Date[] = [];
  Container.set(HoldingTransactionRepository, {
    findForHoldingsInRange: async () => rows,
  } as unknown as HoldingTransactionRepository);
  Container.set(HoldingRepository, {
    findIdsIncludedInTotal: async (ids: readonly string[]) => new Set(ids),
    findByIds: async () => [
      { id: 'stock', tokenId: STOCK, isActive: true },
      { id: 'usd', tokenId: USD, isActive: true },
    ],
  } as unknown as HoldingRepository);
  Container.set(PriceGraphService, {
    buildPriceLookup: async () => ({ covers: () => false }),
    convert: async (amount: Decimal, from: string, _to: string, at: Date) => {
      asked.push(at);
      return from === CAD ? { amount: new Decimal(amount).mul('0.75'), stale: false } : null;
    },
  } as unknown as PriceGraphService);
  Container.set(DriftLedgerService, {
    forHoldings: async () => new Map(),
  } as unknown as DriftLedgerService);
  return { svc: new ExternalFlowService(), asked };
}

const SCOPE = ['stock', 'usd'].map((holdingId) => ({ holdingId, weight: new Decimal(1) }));
const priced = { priceNative: '10', priceNativeTokenId: CAD, feeQuantity: '-1', feeTokenId: CAD };

describe('ExternalFlowService — a trade is what actually moved (SC-1470)', () => {
  test('a purchase put in its price and its commission, valued at the trade instant', async () => {
    const { svc, asked } = makeService([row({ kind: 'buy', quantity: '2', ...priced })]);
    const series = await svc.forHoldings(SCOPE, USD, FROM, TO);
    expect(series.flows[0]?.baseAmount).toBe('15.75');
    expect(asked.every((at) => at.getTime() === AT.getTime())).toBe(true);
  });

  test('a sale took out its proceeds less its commission', async () => {
    const { svc } = makeService([row({ kind: 'sell', quantity: '-2', ...priced })]);
    const series = await svc.forHoldings(SCOPE, USD, FROM, TO);
    expect(series.flows[0]?.baseAmount).toBe('-14.25');
  });

  test('the fee row that settles the trade is the cash leaving, not a cost', async () => {
    const { svc } = makeService([
      row({
        kind: 'fee',
        quantity: '-1',
        holdingId: 'usd',
        tokenId: USD,
        settlesTransactionId: 'buy-2',
      }),
    ]);
    const series = await svc.forHoldings(SCOPE, USD, FROM, TO);
    expect(series.flows.map((f) => f.baseAmount)).toEqual(['-1']);
  });

  test("a stock's commission is counted once, in its cost: the trade carries it in and its fee row pays it out", async () => {
    const buy = row({
      kind: 'buy',
      quantity: '2',
      priceNative: '500',
      priceNativeTokenId: USD,
      feeQuantity: '-1',
      feeTokenId: USD,
    });
    const { svc } = makeService([
      buy,
      row({
        kind: 'fee',
        quantity: '-1',
        holdingId: 'usd',
        tokenId: USD,
        settlesTransactionId: buy.id,
      }),
    ]);
    const series = await svc.forHoldings(SCOPE, USD, FROM, TO);
    expect(series.flows.map((f) => [f.kind, f.baseAmount])).toEqual([
      ['buy', '1001'],
      ['fee', '-1'],
    ]);
  });

  test("an FX conversion's commission is a cost, not a flow: nothing else absorbs it (SC-1464)", async () => {
    const leg = row({
      kind: 'buy',
      quantity: '1000',
      holdingId: 'usd',
      tokenId: USD,
      priceNative: '1',
      priceNativeTokenId: USD,
      feeQuantity: '-2',
      feeTokenId: USD,
    });
    const { svc } = makeService([
      leg,
      row({
        kind: 'fee',
        quantity: '-2',
        holdingId: 'usd',
        tokenId: USD,
        settlesTransactionId: leg.id,
      }),
    ]);
    const series = await svc.forHoldings(SCOPE, USD, FROM, TO);
    expect(series.flows.map((f) => [f.kind, f.baseAmount])).toEqual([['buy', '1000']]);
  });

  test('control: a deposit with no execution price is still valued at the close (SC-1254)', async () => {
    const { svc, asked } = makeService([
      row({ kind: 'deposit', quantity: '4', holdingId: 'stock', tokenId: CAD }),
    ]);
    await svc.forHoldings(SCOPE, USD, FROM, TO);
    expect(asked.at(-1)?.toISOString()).toBe('2026-06-25T23:59:59.999Z');
  });

  test('control: a fee nothing settles is still not a flow', async () => {
    const { svc } = makeService([
      row({ kind: 'fee', quantity: '-1', holdingId: 'usd', tokenId: USD }),
    ]);
    const series = await svc.forHoldings(SCOPE, USD, FROM, TO);
    expect(series.flows).toHaveLength(0);
  });
});
