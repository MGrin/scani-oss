process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import { Container } from 'typedi';
import { compareLedgerEvents } from '../../../src/lib/ledger-order';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { CostBasisService } from '../../../src/services/pricing/CostBasisService';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * Realized PnL must be a function of the ledger, not of how Postgres stored
 * it (SC-342).
 *
 * The walk is a fold over a sequence, so it is only deterministic if the
 * sequence is. It was not: the repository ordered on `occurred_at` alone and
 * the component walk sorted on `(occurredAt, outflowRank)`, and
 * `Array.prototype.sort` is stable — so events tied on both keys were
 * consumed in physical row order, which a VACUUM or a dump/restore changes.
 * One production SOL holding read 63.05 / 51.39 / 38.96 across three
 * database states over a byte-identical ledger.
 *
 * Every test here works the same way: build a ledger that is *deliberately*
 * full of ties, walk every permutation of it, and require one answer. The
 * fixture's tie count is asserted first, so the suite cannot pass by
 * accidentally having nothing to disagree about.
 */

const USD = 'token-USD';
const SOL = 'token-SOL';

function makeService(): CostBasisService {
  Container.set(HoldingRepository, {} as unknown as HoldingRepository);
  Container.set(HoldingTransactionRepository, {} as unknown as HoldingTransactionRepository);
  Container.set(PriceGraphService, {
    convert: async () => {
      throw new Error('PriceGraphService.convert should not be called in these tests');
    },
  } as unknown as PriceGraphService);
  const instance = new CostBasisService();
  Container.set(CostBasisService, instance);
  return instance;
}

function tx(p: {
  id: string;
  holdingId: string;
  kind: string;
  quantity: string;
  occurredAt: string;
  externalId: string;
  source?: string;
  priceNative?: string;
  transferGroupId?: string;
  transferReview?: string;
}): HoldingTransaction {
  return {
    id: p.id,
    userId: 'u',
    holdingId: p.holdingId,
    tokenId: SOL,
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
    externalId: p.externalId,
    swapGroupId: null,
    transferGroupId: p.transferGroupId ?? null,
    transferReview: p.transferReview ?? null,
    transferReviewedAt: p.transferReview ? new Date('2026-01-01') : null,
    transferReviewSplit: null,
    source: p.source ?? 'solana',
    sourceMetadata: {},
    rawPayload: null,
    counterparty: null,
    description: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  } as HoldingTransaction;
}

/**
 * Every arrangement a storage layer could hand us. Exhaustive rather than
 * sampled: the fixtures are small enough, and "we shuffled it 50 times and it
 * held" is a weaker claim than the one this file is here to make.
 */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    const head = items[i];
    if (head === undefined) continue;
    for (const tail of permutations(rest)) out.push([head, ...tail]);
  }
  return out;
}

/** Groups of rows a walk cannot tell apart without the SC-342 tiebreak. */
function tieGroupCount(txs: readonly HoldingTransaction[]): number {
  const groups = new Map<string, number>();
  for (const t of txs) {
    const outflow = ['sell', 'swap_out', 'withdraw', 'transfer_out'].includes(t.kind);
    const key = `${t.holdingId}|${t.occurredAt.getTime()}|${outflow ? 0 : 1}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups.values()].filter((n) => n > 1).length;
}

describe('ledger order is total', () => {
  test('no two rows compare equal once source, external_id and id are in play', () => {
    // Same instant, same kind rank, same source — the case that was left to
    // physical order. Also the cross-holding case: both legs of a transfer
    // carry one chain hash, so external_id alone is not unique in a
    // component walk (23 such keys in production).
    const rows = [
      tx({
        id: 'b',
        holdingId: 'h1',
        kind: 'swap_out',
        quantity: '-1',
        occurredAt: '2026-02-22T04:57:58Z',
        externalId: 'sig-2',
      }),
      tx({
        id: 'a',
        holdingId: 'h1',
        kind: 'swap_out',
        quantity: '-1',
        occurredAt: '2026-02-22T04:57:58Z',
        externalId: 'sig-1',
      }),
      tx({
        id: 'd',
        holdingId: 'h2',
        kind: 'transfer_out',
        quantity: '-1',
        occurredAt: '2026-02-22T04:57:58Z',
        externalId: 'sig-1',
      }),
      tx({
        id: 'c',
        holdingId: 'h1',
        kind: 'transfer_out',
        quantity: '-1',
        occurredAt: '2026-02-22T04:57:58Z',
        externalId: 'sig-1',
        source: 'etherscan',
      }),
    ];
    for (const a of rows) {
      for (const b of rows) {
        if (a.id === b.id) expect(compareLedgerEvents(a, b)).toBe(0);
        else expect(compareLedgerEvents(a, b)).not.toBe(0);
      }
    }
  });

  test('an outflow still sorts before a same-instant inflow', () => {
    // The one ordering rule that carries meaning rather than just breaking a
    // tie: a transfer_out has to buffer its lots before the paired
    // transfer_in reaches for them. The tiebreak must not outrank it —
    // note the inflow's external_id sorts first alphabetically.
    const inflow = tx({
      id: 'i',
      holdingId: 'h',
      kind: 'transfer_in',
      quantity: '1',
      occurredAt: '2026-02-22T04:57:58Z',
      externalId: 'aaa',
    });
    const outflow = tx({
      id: 'o',
      holdingId: 'h',
      kind: 'transfer_out',
      quantity: '-1',
      occurredAt: '2026-02-22T04:57:58Z',
      externalId: 'zzz',
    });
    expect(compareLedgerEvents(outflow, inflow)).toBeLessThan(0);
  });
});

describe('walkLots is order-independent', () => {
  // Three same-second sells against three same-second buys at different
  // prices — the shape that makes FIFO matching visible. Which buy each sell
  // pops used to depend on the order the rows came back in.
  const ledger = [
    tx({
      id: 'buy-1',
      holdingId: 'h',
      kind: 'buy',
      quantity: '10',
      occurredAt: '2026-02-22T04:00:00Z',
      externalId: 'e-01',
      priceNative: '100',
    }),
    tx({
      id: 'buy-2',
      holdingId: 'h',
      kind: 'buy',
      quantity: '10',
      occurredAt: '2026-02-22T04:00:00Z',
      externalId: 'e-02',
      priceNative: '200',
    }),
    tx({
      id: 'buy-3',
      holdingId: 'h',
      kind: 'buy',
      quantity: '10',
      occurredAt: '2026-02-22T04:00:00Z',
      externalId: 'e-03',
      priceNative: '300',
    }),
    tx({
      id: 'sell-1',
      holdingId: 'h',
      kind: 'sell',
      quantity: '-12',
      occurredAt: '2026-02-22T05:00:00Z',
      externalId: 'e-04',
      priceNative: '250',
    }),
    tx({
      id: 'sell-2',
      holdingId: 'h',
      kind: 'sell',
      quantity: '-6',
      occurredAt: '2026-02-22T05:00:00Z',
      externalId: 'e-05',
      priceNative: '250',
    }),
  ];

  test('the fixture actually contains ties', () => {
    expect(tieGroupCount(ledger)).toBe(2);
  });

  test('every permutation of the same rows realizes the same figure', async () => {
    const svc = makeService();
    const results = new Set<string>();
    for (const order of permutations(ledger)) {
      const r = await svc.walkLots(order, USD, SOL);
      results.add(`${r.realizedPnl.toFixed(2)}|${r.costBasis.toFixed(2)}|${r.openQty.toFixed(8)}`);
    }
    // The buys enter oldest-first by external_id (100, 200, 300), so the
    // -12 pops the whole 100-lot plus 2 of the 200-lot (cost 1400 against
    // 3000 of proceeds) and the -6 pops 6 more of the 200-lot (1200 against
    // 1500). 1600 + 300 realized; 2 units at 200 and 10 at 300 left open.
    expect([...results]).toEqual(['1900.00|3400.00|12.00000000']);
  });
});

describe('walkComponent is order-independent', () => {
  // A transfer out of h1 into h2 at the same instant as an unrelated sell on
  // h1, plus two same-second buys on h1 at different prices. The transfer
  // carries its lots across, so which lot it carries decides both holdings'
  // basis — and it was decided by row order.
  const group = 'grp-1';
  const byHolding = new Map<string, HoldingTransaction[]>([
    [
      'h1',
      [
        tx({
          id: 'b1',
          holdingId: 'h1',
          kind: 'buy',
          quantity: '5',
          occurredAt: '2026-02-22T04:00:00Z',
          externalId: 'e-01',
          priceNative: '100',
        }),
        tx({
          id: 'b2',
          holdingId: 'h1',
          kind: 'buy',
          quantity: '5',
          occurredAt: '2026-02-22T04:00:00Z',
          externalId: 'e-02',
          priceNative: '400',
        }),
        tx({
          id: 'o1',
          holdingId: 'h1',
          kind: 'transfer_out',
          quantity: '-5',
          occurredAt: '2026-02-22T05:00:00Z',
          externalId: 'e-03',
          transferGroupId: group,
        }),
        tx({
          id: 'o2',
          holdingId: 'h1',
          kind: 'sell',
          quantity: '-2',
          occurredAt: '2026-02-22T05:00:00Z',
          externalId: 'e-04',
          priceNative: '500',
        }),
      ],
    ],
    [
      'h2',
      [
        tx({
          id: 'i1',
          holdingId: 'h2',
          kind: 'transfer_in',
          quantity: '5',
          occurredAt: '2026-02-22T05:00:00Z',
          externalId: 'e-03',
          transferGroupId: group,
        }),
      ],
    ],
  ]);

  test('the fixture actually contains ties', () => {
    expect(tieGroupCount([...byHolding.values()].flat())).toBe(2);
  });

  test('every permutation of the same rows produces the same per-holding figures', async () => {
    const svc = makeService();
    const at = new Date('2026-03-01T00:00:00Z');
    const held = new Map([
      ['h1', SOL],
      ['h2', SOL],
    ]);
    const results = new Set<string>();
    for (const h1 of permutations(byHolding.get('h1') ?? [])) {
      const shuffled = new Map<string, HoldingTransaction[]>([
        ['h1', h1],
        ['h2', byHolding.get('h2') ?? []],
      ]);
      const r = await svc.walkComponent(['h1', 'h2'], shuffled, at, USD, held);
      const h1r = r.get('h1');
      const h2r = r.get('h2');
      results.add(
        `h1 realized=${h1r?.realizedPnl.toFixed(2)} basis=${h1r?.costBasis.toFixed(2)} | h2 realized=${h2r?.realizedPnl.toFixed(2)} basis=${h2r?.costBasis.toFixed(2)}`
      );
    }
    expect([...results]).toEqual([
      // Both 05:00 rows are outflows, so the tiebreak decides: e-03
      // (transfer_out) before e-04 (sell). The transfer carries the whole
      // 100-lot to h2 — basis 500, no gain, it was never a disposal. The
      // sell then pops 2 of the 400-lot, cost 800 against 1000 of proceeds,
      // leaving 3 units at 400 on h1.
      'h1 realized=200.00 basis=1200.00 | h2 realized=0.00 basis=500.00',
    ]);
  });
});
