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

  test('unlinked withdraw realizes PnL at FMV against FIFO cost', async () => {
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
        // Bought 10 @ $100 (cost $1000), withdraw 4 @ FMV $150 →
        // proceeds $600, popped cost $400 → realized $200.
        tx({
          holdingId: 'h',
          kind: 'withdraw',
          quantity: '-4',
          occurredAt: '2024-02-01',
          priceNative: '150',
          priceNativeTokenId: USD,
        }),
      ],
      USD,
      BTC
    );
    expect(r.realizedPnl.toString()).toBe('200');
    expect(r.openQty.toString()).toBe('6');
    expect(r.costBasis.toString()).toBe('600');
  });

  test('unlinked transfer_out realizes PnL the same way as withdraw', async () => {
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
          kind: 'transfer_out',
          quantity: '-10',
          occurredAt: '2024-02-01',
          priceNative: '150',
          priceNativeTokenId: USD,
        }),
      ],
      USD,
      BTC
    );
    // Singleton path = unlinked by definition; full exit at $150
    // realizes $500 against $1000 cost.
    expect(r.realizedPnl.toString()).toBe('500');
    expect(r.openQty.toString()).toBe('0');
  });

  test('stablecoin withdraw (price = 1) realizes ~0 — sanity check', async () => {
    const svc = makeService();
    const r = await svc.walkLots(
      [
        // 5000 USDT in @ $1 (cost $5000).
        tx({
          holdingId: 'h',
          kind: 'deposit',
          quantity: '5000',
          occurredAt: '2024-01-01',
          priceNative: '1',
          priceNativeTokenId: USD,
        }),
        // 3000 USDT out @ $1 — value drop $3000, popped cost $3000.
        tx({
          holdingId: 'h',
          kind: 'withdraw',
          quantity: '-3000',
          occurredAt: '2024-02-01',
          priceNative: '1',
          priceNativeTokenId: USD,
        }),
      ],
      USD,
      BTC
    );
    expect(r.realizedPnl.toString()).toBe('0');
    expect(r.openQty.toString()).toBe('2000');
    expect(r.costBasis.toString()).toBe('2000');
  });

  test('unpriceable withdraw (no priceNative, no held-token route) pops at zero realized', async () => {
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
        // No priceNative + heldTokenId=null disables the FX fallback →
        // txValueInBase returns null → walker pops at zero realized
        // rather than fabricating a phantom loss.
        tx({ holdingId: 'h', kind: 'withdraw', quantity: '-10', occurredAt: '2024-02-01' }),
      ],
      USD,
      null
    );
    expect(r.realizedPnl.toString()).toBe('0');
    expect(r.openQty.toString()).toBe('0');
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

  test('an UNLINKED transfer realizes PnL on the source and resets cost on the destination', async () => {
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
          // Unlinked transfer_out at FMV $150/unit → A realizes the
          // $500 gain at the moment of exit (proceeds $1500 − cost $1000).
          tx({
            holdingId: 'A',
            kind: 'transfer_out',
            quantity: '-10',
            occurredAt: '2024-02-01',
            priceNative: '150',
            priceNativeTokenId: USD,
          }),
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
    // A's outflow realizes the $500 gain accumulated against its cost
    // basis. B reopens at FMV and sells at the same FMV → no additional
    // PnL. Total realized across the pair is $500 — same as the linked
    // case, attributed at the point of exit instead of the eventual
    // sale.
    expect(r.get('A')?.realizedPnl.toString()).toBe('500');
    expect(r.get('B')?.realizedPnl.toString()).toBe('0');
  });

  test('an UNLINKED transfer with no priceable route pops at zero realized — no phantom loss', async () => {
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
          // No priceNative + the test stub refuses FX → unpriceable.
          // With heldTokenId set to null we bypass the held-token
          // fallback entirely, so txValueInBase returns null and the
          // outflow pops at zero realized.
          tx({ holdingId: 'A', kind: 'transfer_out', quantity: '-10', occurredAt: '2024-02-01' }),
        ],
      ],
    ]);
    // Empty heldTokens map → heldTokenId resolves to null inside the
    // walker, disabling the held-token fallback in txValueInBase.
    const r = await svc.walkComponent(['A'], txsByHolding, FUTURE, USD, new Map());
    expect(r.get('A')?.realizedPnl.toString()).toBe('0');
    expect(r.get('A')?.openQty.toString()).toBe('0');
  });

  test('a linked transfer_out whose pair never arrives realizes at FMV on the source', async () => {
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
          // Linked outflow, but no matching transfer_in shows up on B
          // (or anywhere) before `at`. End-of-walk realizes at FMV on A.
          tx({
            holdingId: 'A',
            kind: 'transfer_out',
            quantity: '-10',
            occurredAt: '2024-02-01',
            priceNative: '150',
            priceNativeTokenId: USD,
            transferGroupId: 'orphan',
          }),
        ],
      ],
      ['B', []],
    ]);
    const r = await svc.walkComponent(['A', 'B'], txsByHolding, FUTURE, USD, heldTokens);
    expect(r.get('A')?.realizedPnl.toString()).toBe('500');
    expect(r.get('A')?.openQty.toString()).toBe('0');
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
