process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { CostBasisService } from '../../../src/services/pricing/CostBasisService';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';

// Stubs leak across files because typedi's Container is process-global.
afterAll(() => {
  Container.set(HoldingRepository, new HoldingRepository());
  Container.set(HoldingTransactionRepository, new HoldingTransactionRepository());
  Container.set(PriceGraphService, new PriceGraphService());
  Container.set(CostBasisService, new CostBasisService());
});

const USD = 'token-USD';
const BTC = 'token-BTC';

// Every priced tx in these tests carries `priceNative` in the base
// currency, so CostBasisService never needs an FX conversion. This stub
// throws — a test that accidentally relies on FX fails loudly.
function makePriceGraphStub(): PriceGraphService {
  return {
    convert: async () => {
      throw new Error('PriceGraphService.convert should not be called in these tests');
    },
  } as unknown as PriceGraphService;
}

function makeService(): CostBasisService {
  Container.set(HoldingRepository, {} as unknown as HoldingRepository);
  Container.set(HoldingTransactionRepository, {} as unknown as HoldingTransactionRepository);
  Container.set(PriceGraphService, makePriceGraphStub());
  const instance = new CostBasisService();
  Container.set(CostBasisService, instance);
  return instance;
}

let txSeq = 0;
function tx(p: {
  holdingId: string;
  kind: string;
  quantity: string;
  occurredAt: string;
  priceNative?: string;
  priceNativeTokenId?: string;
  transferGroupId?: string;
}): HoldingTransaction {
  txSeq += 1;
  return {
    id: `tx-${txSeq}`,
    userId: 'u',
    holdingId: p.holdingId,
    tokenId: BTC,
    kind: p.kind,
    quantity: p.quantity,
    priceNative: p.priceNative ?? null,
    priceNativeTokenId: p.priceNativeTokenId ?? null,
    counterTokenId: null,
    counterQuantity: null,
    counterPriceNative: null,
    counterPriceNativeTokenId: null,
    feeQuantity: null,
    feeTokenId: null,
    occurredAt: new Date(p.occurredAt),
    externalId: `ext-${txSeq}`,
    swapGroupId: null,
    transferGroupId: p.transferGroupId ?? null,
    source: 's',
    sourceMetadata: {},
    rawPayload: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as HoldingTransaction;
}

describe('CostBasisService.walkLots', () => {
  test('empty tx history reports hasTransactions=false', async () => {
    const svc = makeService();
    const r = await svc.walkLots([], USD, BTC);
    expect(r.hasTransactions).toBe(false);
    expect(r.costBasis.toString()).toBe('0');
    expect(r.openQty.toString()).toBe('0');
  });

  test('buy then partial sell realizes PnL against FIFO cost', async () => {
    const svc = makeService();
    const r = await svc.walkLots(
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '10',
          occurredAt: '2024-01-01',
          priceNative: '100',
          priceNativeTokenId: USD,
        }),
        tx({
          holdingId: 'h',
          kind: 'sell',
          quantity: '-4',
          occurredAt: '2024-02-01',
          priceNative: '150',
          priceNativeTokenId: USD,
        }),
      ],
      USD,
      BTC
    );
    // Sold 4 @ 150 proceeds 600, FIFO cost 4 × 100 = 400 → realized 200.
    expect(r.realizedPnl.toString()).toBe('200');
    expect(r.openQty.toString()).toBe('6');
    expect(r.costBasis.toString()).toBe('600');
    expect(r.hasTransactions).toBe(true);
  });

  test('swap_out without priceNative pops at ZERO realized — no phantom loss', async () => {
    const svc = makeService();
    const r = await svc.walkLots(
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '10',
          occurredAt: '2024-01-01',
          priceNative: '100',
          priceNativeTokenId: USD,
        }),
        // swap_out with no priceNative — proceeds are in the counter token.
        tx({ holdingId: 'h', kind: 'swap_out', quantity: '-10', occurredAt: '2024-02-01' }),
      ],
      USD,
      BTC
    );
    // Old behaviour: realized 0 − 1000 = −1000 (phantom loss). Fixed: 0.
    expect(r.realizedPnl.toString()).toBe('0');
    expect(r.openQty.toString()).toBe('0');
  });

  test('swap_out with priceNative still realizes PnL correctly', async () => {
    const svc = makeService();
    const r = await svc.walkLots(
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '10',
          occurredAt: '2024-01-01',
          priceNative: '100',
          priceNativeTokenId: USD,
        }),
        tx({
          holdingId: 'h',
          kind: 'swap_out',
          quantity: '-10',
          occurredAt: '2024-02-01',
          priceNative: '130',
          priceNativeTokenId: USD,
        }),
      ],
      USD,
      BTC
    );
    // Proceeds 10 × 130 = 1300, cost 1000 → realized 300.
    expect(r.realizedPnl.toString()).toBe('300');
  });
});

describe('CostBasisService.getCostBasis', () => {
  test('hasTransactions=false when every tx is after `at`', async () => {
    const svc = makeService();
    const r = await svc.getCostBasis('h', new Date('2024-01-01T00:00:00Z'), USD, {
      heldTokenId: BTC,
      txs: [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '5',
          occurredAt: '2025-01-01',
          priceNative: '100',
          priceNativeTokenId: USD,
        }),
      ],
    });
    expect(r.hasTransactions).toBe(false);
  });
});

describe('CostBasisService.walkComponent', () => {
  const FUTURE = new Date('2030-01-01T00:00:00Z');
  const heldTokens = new Map([
    ['A', BTC],
    ['B', BTC],
  ]);

  test('a linked transfer carries the original cost basis across holdings', async () => {
    const svc = makeService();
    const txsByHolding = new Map<string, HoldingTransaction[]>([
      [
        'A',
        [
          tx({
            holdingId: 'A',
            kind: 'buy',
            quantity: '10',
            occurredAt: '2024-01-01',
            priceNative: '100',
            priceNativeTokenId: USD,
          }),
          tx({
            holdingId: 'A',
            kind: 'transfer_out',
            quantity: '-10',
            occurredAt: '2024-02-01',
            transferGroupId: 'g1',
          }),
        ],
      ],
      [
        'B',
        [
          tx({
            holdingId: 'B',
            kind: 'transfer_in',
            quantity: '10',
            occurredAt: '2024-02-01',
            transferGroupId: 'g1',
          }),
          tx({
            holdingId: 'B',
            kind: 'sell',
            quantity: '-10',
            occurredAt: '2024-03-01',
            priceNative: '150',
            priceNativeTokenId: USD,
          }),
        ],
      ],
    ]);
    const r = await svc.walkComponent(['A', 'B'], txsByHolding, FUTURE, USD, heldTokens);
    // Sold 10 @ 150 on B against the ORIGINAL $1000 cost from A's buy →
    // realized 500. A realizes nothing on the transfer_out.
    expect(r.get('B')?.realizedPnl.toString()).toBe('500');
    expect(r.get('A')?.realizedPnl.toString()).toBe('0');
    expect(r.get('A')?.costBasis.toString()).toBe('0');
    expect(r.get('B')?.costBasis.toString()).toBe('0');
  });

  test('an UNLINKED transfer resets cost basis to market value at receipt', async () => {
    const svc = makeService();
    const txsByHolding = new Map<string, HoldingTransaction[]>([
      [
        'A',
        [
          tx({
            holdingId: 'A',
            kind: 'buy',
            quantity: '10',
            occurredAt: '2024-01-01',
            priceNative: '100',
            priceNativeTokenId: USD,
          }),
          tx({ holdingId: 'A', kind: 'transfer_out', quantity: '-10', occurredAt: '2024-02-01' }),
        ],
      ],
      [
        'B',
        [
          // No transferGroupId → opens an FMV lot at the receipt price.
          tx({
            holdingId: 'B',
            kind: 'transfer_in',
            quantity: '10',
            occurredAt: '2024-02-01',
            priceNative: '150',
            priceNativeTokenId: USD,
          }),
          tx({
            holdingId: 'B',
            kind: 'sell',
            quantity: '-10',
            occurredAt: '2024-03-01',
            priceNative: '150',
            priceNativeTokenId: USD,
          }),
        ],
      ],
    ]);
    const r = await svc.walkComponent(['A', 'B'], txsByHolding, FUTURE, USD, heldTokens);
    // Cost reset to $1500 at receipt → selling at $1500 realizes 0,
    // erasing the genuine $500 gain. Contrast with the linked case.
    expect(r.get('B')?.realizedPnl.toString()).toBe('0');
  });

  test('a partial linked transfer splits the lot across holdings', async () => {
    const svc = makeService();
    const txsByHolding = new Map<string, HoldingTransaction[]>([
      [
        'A',
        [
          tx({
            holdingId: 'A',
            kind: 'buy',
            quantity: '10',
            occurredAt: '2024-01-01',
            priceNative: '100',
            priceNativeTokenId: USD,
          }),
          tx({
            holdingId: 'A',
            kind: 'transfer_out',
            quantity: '-4',
            occurredAt: '2024-02-01',
            transferGroupId: 'g2',
          }),
        ],
      ],
      [
        'B',
        [
          tx({
            holdingId: 'B',
            kind: 'transfer_in',
            quantity: '4',
            occurredAt: '2024-02-01',
            transferGroupId: 'g2',
          }),
        ],
      ],
    ]);
    const r = await svc.walkComponent(['A', 'B'], txsByHolding, FUTURE, USD, heldTokens);
    // 6 units stay on A (cost 600), 4 moved to B at original cost (400).
    expect(r.get('A')?.costBasis.toString()).toBe('600');
    expect(r.get('A')?.openQty.toString()).toBe('6');
    expect(r.get('B')?.costBasis.toString()).toBe('400');
    expect(r.get('B')?.openQty.toString()).toBe('4');
  });
});
