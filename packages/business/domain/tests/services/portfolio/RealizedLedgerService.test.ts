process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, describe, expect, test } from 'bun:test';
import type { HoldingCoverage, HoldingTransaction } from '@scani/db/schema';
import { Container } from 'typedi';
import { HoldingCoverageRepository } from '../../../src/repositories/HoldingCoverageRepository';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { RealizedLedgerService } from '../../../src/services/portfolio/RealizedLedgerService';
import { CostBasisService } from '../../../src/services/pricing/CostBasisService';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';

/**
 * `RealizedLedgerService` — the read side of SC-152.
 *
 * The walk's arithmetic is pinned in `CostBasisDisposals.test.ts` and the
 * transfer-component SQL in `HoldingTransactionRepository.transferLinks.test.ts`.
 * What is left, and what this file is for, is the service's own three
 * decisions: which walker to use, which rows belong to the holding that was
 * asked about, and what order they come back in.
 *
 * Each matters for a different reason. The walker choice is the difference
 * between a lot that moved across a transfer keeping its cost and losing it.
 * The filter is what stops a question about one holding answering with another
 * one's disposals. And the order is not the walk's: `walkComponent` emits
 * half-linked outflows in an end-of-walk pass, so its natural sequence is
 * chronological with a tail bolted on.
 */

const USD = 'token-USD';
const BTC = 'token-BTC';

afterAll(() => {
  Container.set(HoldingRepository, new HoldingRepository());
  Container.set(HoldingTransactionRepository, new HoldingTransactionRepository());
  Container.set(HoldingCoverageRepository, new HoldingCoverageRepository());
  Container.set(PriceGraphService, new PriceGraphService());
  Container.set(CostBasisService, new CostBasisService());
  Container.set(RealizedLedgerService, new RealizedLedgerService());
});

let txSeq = 0;
function tx(p: {
  holdingId: string;
  kind: string;
  quantity: string;
  occurredAt: string;
  priceNative?: string;
  transferGroupId?: string;
  transferReview?: string;
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
    priceNativeTokenId: p.priceNative ? USD : null,
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
    transferReview: p.transferReview ?? null,
    transferReviewedAt: p.transferReview ? new Date() : null,
    source: 's',
    sourceMetadata: {},
    rawPayload: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as HoldingTransaction;
}

function makeService(opts: {
  component: string[];
  txsByHolding: Map<string, HoldingTransaction[]>;
  coverage?: Map<string, HoldingCoverage>;
}): RealizedLedgerService {
  Container.set(HoldingTransactionRepository, {
    findTransferLinkedHoldingIds: async () => opts.component,
    findForHoldingsAll: async () => opts.txsByHolding,
    // `getCostBasis` prefers the handed-in `txs`, so this must never fire.
    findForHoldingUpTo: async () => {
      throw new Error('findForHoldingUpTo should not be called — txs are pre-loaded');
    },
  } as unknown as HoldingTransactionRepository);
  Container.set(HoldingRepository, {
    findByIds: async (ids: string[]) => ids.map((id) => ({ id, tokenId: BTC })),
    findById: async () => {
      throw new Error('findById should not be called — heldTokenId is pre-resolved');
    },
  } as unknown as HoldingRepository);
  Container.set(HoldingCoverageRepository, {
    findManyByHoldingIds: async () => opts.coverage ?? new Map(),
  } as unknown as HoldingCoverageRepository);
  Container.set(PriceGraphService, {
    convert: async () => {
      throw new Error('PriceGraphService.convert should not be called in these tests');
    },
  } as unknown as PriceGraphService);
  Container.set(CostBasisService, new CostBasisService());
  const instance = new RealizedLedgerService();
  Container.set(RealizedLedgerService, instance);
  return instance;
}

describe('RealizedLedgerService.forHolding', () => {
  test('walks a singleton holding on its own history', async () => {
    const txs = [
      tx({
        holdingId: 'h',
        kind: 'buy',
        quantity: '4',
        occurredAt: '2024-01-01',
        priceNative: '100',
      }),
      tx({
        holdingId: 'h',
        kind: 'sell',
        quantity: '-4',
        occurredAt: '2024-06-01',
        priceNative: '200',
      }),
    ];
    const svc = makeService({ component: ['h'], txsByHolding: new Map([['h', txs]]) });

    const rows = await svc.forHolding('u', 'h', USD, new Date('2025-01-01'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.gain?.toString()).toBe('400');
    expect(rows[0]?.outcome).toBe('realized');
  });

  test('walks the whole component so a transferred lot keeps its cost', async () => {
    const kraken = [
      tx({
        holdingId: 'kraken',
        kind: 'buy',
        quantity: '10',
        occurredAt: '2023-01-01',
        priceNative: '100',
      }),
      tx({
        holdingId: 'kraken',
        kind: 'transfer_out',
        quantity: '-10',
        occurredAt: '2024-06-01',
        transferGroupId: 'g1',
      }),
    ];
    const wallet = [
      tx({
        holdingId: 'wallet',
        kind: 'transfer_in',
        quantity: '10',
        occurredAt: '2024-06-01',
        transferGroupId: 'g1',
      }),
      tx({
        holdingId: 'wallet',
        kind: 'sell',
        quantity: '-10',
        occurredAt: '2025-01-01',
        priceNative: '300',
      }),
    ];
    const svc = makeService({
      component: ['kraken', 'wallet'],
      txsByHolding: new Map([
        ['kraken', kraken],
        ['wallet', wallet],
      ]),
    });

    const rows = await svc.forHolding('u', 'wallet', USD, new Date('2026-01-01'));
    expect(rows).toHaveLength(1);
    // 3000 proceeds against the cost paid on Kraken in 2023, not a fresh
    // market-value lot opened on arrival. Walking 'wallet' alone would report
    // a zero basis and the whole 3000 as gain.
    expect(rows[0]?.costBasis.toString()).toBe('1000');
    expect(rows[0]?.gain?.toString()).toBe('2000');
    expect(rows[0]?.acquiredAt?.toISOString().slice(0, 10)).toBe('2023-01-01');
  });

  test('returns only the asked-about holding, newest disposal first', async () => {
    const kraken = [
      tx({
        holdingId: 'kraken',
        kind: 'buy',
        quantity: '10',
        occurredAt: '2023-01-01',
        priceNative: '100',
      }),
      // Two disposals out of kraken, deliberately out of order relative to the
      // end-of-walk pass: the half-linked one occurred FIRST but is emitted
      // last by `walkComponent`.
      tx({
        holdingId: 'kraken',
        kind: 'transfer_out',
        quantity: '-2',
        occurredAt: '2024-02-01',
        transferGroupId: 'orphan',
      }),
      tx({
        holdingId: 'kraken',
        kind: 'sell',
        quantity: '-3',
        occurredAt: '2024-09-01',
        priceNative: '200',
      }),
      tx({
        holdingId: 'kraken',
        kind: 'transfer_out',
        quantity: '-5',
        occurredAt: '2024-03-01',
        transferGroupId: 'g1',
      }),
    ];
    const wallet = [
      tx({
        holdingId: 'wallet',
        kind: 'transfer_in',
        quantity: '5',
        occurredAt: '2024-03-01',
        transferGroupId: 'g1',
      }),
      tx({
        holdingId: 'wallet',
        kind: 'sell',
        quantity: '-5',
        occurredAt: '2024-12-01',
        priceNative: '400',
      }),
    ];
    const svc = makeService({
      component: ['kraken', 'wallet'],
      txsByHolding: new Map([
        ['kraken', kraken],
        ['wallet', wallet],
      ]),
    });

    const rows = await svc.forHolding('u', 'kraken', USD, new Date('2026-01-01'));
    // The wallet's own sale is not kraken's answer, even though one walk
    // produced both.
    expect(rows.every((r) => r.holdingId === 'kraken')).toBe(true);
    expect(rows.map((r) => r.disposedAt.toISOString().slice(0, 10))).toEqual([
      '2024-09-01',
      '2024-02-01',
    ]);
    expect(rows.map((r) => r.outcome)).toEqual(['realized', 'awaiting_pair']);
  });

  test('a holding that never disposed of anything answers with nothing', async () => {
    const txs = [
      tx({
        holdingId: 'h',
        kind: 'buy',
        quantity: '4',
        occurredAt: '2024-01-01',
        priceNative: '100',
      }),
    ];
    const svc = makeService({ component: ['h'], txsByHolding: new Map([['h', txs]]) });
    expect(await svc.forHolding('u', 'h', USD, new Date('2025-01-01'))).toEqual([]);
  });

  test('carries the holding coverage flag into the rows it grades', async () => {
    const txs = [
      tx({
        holdingId: 'h',
        kind: 'buy',
        quantity: '4',
        occurredAt: '2024-01-01',
        priceNative: '100',
      }),
      tx({
        holdingId: 'h',
        kind: 'sell',
        quantity: '-4',
        occurredAt: '2024-06-01',
        priceNative: '200',
      }),
    ];
    const svc = makeService({
      component: ['h'],
      txsByHolding: new Map([['h', txs]]),
      // The flag every provider writes honestly and nothing read before SC-149.
      coverage: new Map([
        ['h', { holdingId: 'h', hasCompleteTxHistory: false } as HoldingCoverage],
      ]),
    });

    const rows = await svc.forHolding('u', 'h', USD, new Date('2025-01-01'));
    // Same gain, different claim about it. A row that reached the screen
    // ungraded would explain the figure more confidently than the figure
    // deserves.
    expect(rows[0]?.gain?.toString()).toBe('400');
    expect(rows[0]?.basisQuality).toBe('partial');
  });
});
