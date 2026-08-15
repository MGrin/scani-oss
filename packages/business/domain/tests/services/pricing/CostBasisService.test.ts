process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { MAX_DAILY_PRICE_AGE_MS } from '../../../src/lib/constants';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import {
  CostBasisService,
  type HistoryCompleteness,
} from '../../../src/services/pricing/CostBasisService';
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
    transferReview: p.transferReview ?? null,
    transferReviewedAt: p.transferReview ? new Date() : null,
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

  /**
   * SC-150. These four used to assert the opposite — that an unlinked
   * withdraw realizes at fair market value — and that assertion WAS the
   * defect: a move between the user's own accounts that the nightly
   * ±1%/±30min matcher failed to pair became a sale, and a gain.
   *
   * The rule now is that only a person's answer realizes. Each case is
   * tested from both sides, because a change that stopped realizing
   * *everything* would pass a one-sided test and quietly delete the real
   * disposals along with the invented ones.
   */
  test('an UNANSWERED withdraw pops its lots and books no gain', async () => {
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
        // Bought 10 @ $100 (cost $1000), withdraw 4. Nobody has said
        // whether this left the portfolio, so nothing is realized — but
        // the 4 are gone, so the lots pop and the remaining basis is $600.
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
    expect(r.realizedPnl.toString()).toBe('0');
    expect(r.openQty.toString()).toBe('6');
    expect(r.costBasis.toString()).toBe('600');
  });

  test('a withdraw CONFIRMED as leaving the portfolio realizes at FMV', async () => {
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
        // Same numbers, answered: proceeds $600 against $400 popped cost.
        tx({
          holdingId: 'h',
          kind: 'withdraw',
          quantity: '-4',
          occurredAt: '2024-02-01',
          priceNative: '150',
          priceNativeTokenId: USD,
          transferReview: 'left_control',
        }),
      ],
      USD,
      BTC
    );
    expect(r.realizedPnl.toString()).toBe('200');
    expect(r.openQty.toString()).toBe('6');
    expect(r.costBasis.toString()).toBe('600');
  });

  /** "Still mine, somewhere you cannot see" is an answer, and it is not a
   *  sale. It must behave like the unanswered case numerically and unlike
   *  the confirmed one — otherwise the middle option is decorative. */
  test('a withdraw answered as moved-but-untracked realizes nothing', async () => {
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
          kind: 'withdraw',
          quantity: '-4',
          occurredAt: '2024-02-01',
          priceNative: '150',
          priceNativeTokenId: USD,
          transferReview: 'untracked',
        }),
      ],
      USD,
      BTC
    );
    expect(r.realizedPnl.toString()).toBe('0');
    expect(r.openQty.toString()).toBe('6');
  });

  test('transfer_out follows the same rule as withdraw, both ways', async () => {
    const svc = makeService();
    const unanswered = await svc.walkLots(
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
    expect(unanswered.realizedPnl.toString()).toBe('0');
    expect(unanswered.openQty.toString()).toBe('0');

    const answered = await svc.walkLots(
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
          transferReview: 'left_control',
        }),
      ],
      USD,
      BTC
    );
    // Full exit at $150 against $1000 cost.
    expect(answered.realizedPnl.toString()).toBe('500');
    expect(answered.openQty.toString()).toBe('0');
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

  /**
   * SC-150 rewrote this one's expectation. It used to assert that A booked
   * the $500 gain at the moment of exit — which is precisely the invented
   * disposal, because A and B here are two of the same user's own accounts
   * and the only reason the legs are unlinked is that the matcher missed
   * them. Nothing is realized on A now; B still opens at FMV, so the gain
   * is not lost, it is deferred to B's real sale.
   */
  test('an UNANSWERED transfer books nothing on the source', async () => {
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
          // Unlinked, unanswered transfer_out. A's lots leave; no gain.
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
    // Neither leg books a gain: A's exit is an open question, and B
    // reopened at FMV and sold at the same FMV. The $500 the old
    // behaviour reported was an artefact of pricing A's exit as a sale.
    expect(r.get('A')?.realizedPnl.toString()).toBe('0');
    expect(r.get('B')?.realizedPnl.toString()).toBe('0');
  });

  test('the same transfer, CONFIRMED as leaving, still realizes on the source', async () => {
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
            priceNative: '150',
            priceNativeTokenId: USD,
            transferReview: 'left_control',
          }),
        ],
      ],
      ['B', []],
    ]);
    const r = await svc.walkComponent(['A', 'B'], txsByHolding, FUTURE, USD, heldTokens);
    expect(r.get('A')?.realizedPnl.toString()).toBe('500');
    expect(r.get('A')?.openQty.toString()).toBe('0');
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

  test('a linked transfer_out whose pair never arrives books nothing until answered', async () => {
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
    // SC-150: a group id with only one leg is no more evidence of a sale
    // than no group id at all — usually it is an import that fetched one
    // side. The lots still leave A; nothing is booked.
    expect(r.get('A')?.realizedPnl.toString()).toBe('0');
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

/**
 * SC-149 / SC-151 — the walk grades its own output.
 *
 * The fixtures below are deliberately paired: for each defect there is a
 * holding that has it and one that does not, with **identical arithmetic**.
 * That pairing is the point. Every one of these grades to `partial` while
 * producing exactly the same cost basis as its `known` twin, so a test that
 * only asserted the numbers would pass against the broken behaviour — which is
 * precisely how a truncated Kraken import went un-noticed: the figure was never
 * wrong-looking, it was wrong-*meaning*.
 */
describe('CostBasisService — basis quality', () => {
  // A conversion stub whose price is `ageDays` old relative to the tx, so the
  // 45-day daily cap decides `stale`. 96 days is the age measured on the
  // SC-90 fixture: an airdrop on 2025-11-05 valued from a price dated
  // 2025-08-01 and reported as market value on the day.
  function makeAgingPriceGraphStub(ageDays: number): PriceGraphService {
    return {
      convert: async (amount: unknown, _from: string, _to: string, at: Date) => ({
        amount: new Decimal(amount as string | number),
        rate: new Decimal(1),
        effectiveAt: new Date(at.getTime() - ageDays * 24 * 60 * 60 * 1000),
        path: 'direct',
        stale: ageDays * 24 * 60 * 60 * 1000 > MAX_DAILY_PRICE_AGE_MS,
      }),
    } as unknown as PriceGraphService;
  }

  function serviceWithPrices(ageDays: number): CostBasisService {
    Container.set(HoldingRepository, {} as unknown as HoldingRepository);
    Container.set(HoldingTransactionRepository, {} as unknown as HoldingTransactionRepository);
    Container.set(PriceGraphService, makeAgingPriceGraphStub(ageDays));
    const instance = new CostBasisService();
    Container.set(CostBasisService, instance);
    return instance;
  }

  const boughtOnce = [
    tx({
      holdingId: 'A',
      kind: 'buy',
      quantity: '10',
      occurredAt: '2024-01-01',
      priceNative: '100',
      priceNativeTokenId: USD,
    }),
  ];

  test('complete history, priced legs → known', async () => {
    const svc = makeService();
    const r = await svc.walkLots(boughtOnce, USD, BTC, undefined, 'complete');
    expect(r.basisQuality).toBe('known');
    expect(r.costBasis.toString()).toBe('1000');
  });

  test('no coverage row recorded is not treated as incomplete', async () => {
    const svc = makeService();
    // ~22% of production holdings have no coverage row at all. Grading those
    // `partial` would flag more holdings than the deliberate `false` does and
    // bury the signal this ticket is about.
    const r = await svc.walkLots(boughtOnce, USD, BTC, undefined, 'unrecorded');
    expect(r.basisQuality).toBe('known');
  });

  test('a provider that reported truncated history → partial, same number', async () => {
    const svc = makeService();
    const truncated = await svc.walkLots(boughtOnce, USD, BTC, undefined, 'incomplete');
    const complete = await svc.walkLots(boughtOnce, USD, BTC, undefined, 'complete');
    expect(truncated.basisQuality).toBe('partial');
    // Identical arithmetic — only the grade separates them. This is what
    // Kraken's 20,000-row ledger cap looks like from here.
    expect(truncated.costBasis.toString()).toBe(complete.costBasis.toString());
  });

  test('empty history → unknown, not a confident zero', async () => {
    const svc = makeService();
    const r = await svc.walkLots([], USD, BTC, undefined, 'complete');
    expect(r.basisQuality).toBe('unknown');
    expect(r.costBasis.toString()).toBe('0');
  });

  test('an airdrop valued from a 96-day-old price → partial', async () => {
    const airdrop = [
      tx({ holdingId: 'A', kind: 'airdrop', quantity: '5', occurredAt: '2025-11-05' }),
    ];
    const stale = await serviceWithPrices(96).walkLots(airdrop, USD, BTC, undefined, 'complete');
    const fresh = await serviceWithPrices(1).walkLots(airdrop, USD, BTC, undefined, 'complete');
    expect(stale.basisQuality).toBe('partial');
    expect(fresh.basisQuality).toBe('known');
    // Same figure, and before this the reader had no way to tell them apart.
    expect(stale.costBasis.toString()).toBe(fresh.costBasis.toString());
  });

  test('a price just inside the daily window is not flagged', async () => {
    const airdrop = [
      tx({ holdingId: 'A', kind: 'airdrop', quantity: '5', occurredAt: '2025-11-05' }),
    ];
    const r = await serviceWithPrices(44).walkLots(airdrop, USD, BTC, undefined, 'complete');
    expect(r.basisQuality).toBe('known');
  });

  test('an inflow nothing could value books a zero-cost lot → partial', async () => {
    const svc = makeService();
    // `heldTokenId: null` disables the FMV fallback, and the tx has no
    // priceNative — so the lot is booked at zero cost. That zero is the whole
    // of a later disposal's gain, and it must not read as a known basis.
    const r = await svc.walkLots(
      [tx({ holdingId: 'A', kind: 'airdrop', quantity: '5', occurredAt: '2024-01-01' })],
      USD,
      null,
      undefined,
      'complete'
    );
    expect(r.basisQuality).toBe('partial');
    expect(r.costBasis.toString()).toBe('0');
  });

  test('walkComponent grades each holding on its own history', async () => {
    const svc = makeService();
    const FUTURE = new Date('2030-01-01T00:00:00Z');
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
            transferGroupId: 'g9',
          }),
        ],
      ],
      [
        'B',
        [
          tx({
            holdingId: 'B',
            kind: 'buy',
            quantity: '2',
            occurredAt: '2024-01-02',
            priceNative: '100',
            priceNativeTokenId: USD,
            transferGroupId: 'g9',
          }),
        ],
      ],
    ]);
    // A truncated exchange account that sent coins to a wallet whose own
    // history is complete. The lots move; the doubt does not — B's basis is
    // the cost A paid, and A is the holding we could not read in full.
    const r = await svc.walkComponent(
      ['A', 'B'],
      txsByHolding,
      FUTURE,
      USD,
      new Map([
        ['A', BTC],
        ['B', BTC],
      ]),
      undefined,
      new Map<string, HistoryCompleteness>([
        ['A', 'incomplete'],
        ['B', 'complete'],
      ])
    );
    expect(r.get('A')?.basisQuality).toBe('partial');
    expect(r.get('B')?.basisQuality).toBe('known');
  });
});

/**
 * SC-160 — the walk counts what it declined to realize.
 *
 * SC-150's tests above assert the *behaviour*: an unanswered exit books
 * nothing. This one asserts the **admission**, and the two are not the same
 * deliverable. Booking nothing is right; booking nothing silently is the
 * defect SC-149 closed on the cost side, pointed the other way — realized PnL
 * is now short by whatever the genuine off-platform sales among these rows
 * were worth, and no reader can see that from the figure.
 *
 * The count is deliberately the review queue's own predicate — an outflow with
 * no `transfer_group_id` and no `transfer_review` — and every case below
 * exists to pin one boundary of it. A count that ran wider would send a reader
 * to a page holding fewer rows than the number that sent them, with no way to
 * reach zero.
 */
describe('CostBasisService — unreviewed transfers (SC-160)', () => {
  const FUTURE = new Date('2030-01-01T00:00:00Z');
  const heldTokens = new Map([
    ['A', BTC],
    ['B', BTC],
  ]);

  function buy(holdingId: string, occurredAt = '2024-01-01') {
    return tx({
      holdingId,
      kind: 'buy',
      quantity: '10',
      occurredAt,
      priceNative: '100',
      priceNativeTokenId: USD,
    });
  }

  test('an unanswered withdraw is counted, and the gain is still zero', async () => {
    const svc = makeService();
    const r = await svc.walkLots(
      [
        buy('h'),
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
    expect(r.realizedPnl.toString()).toBe('0');
    expect(r.transfersUnreviewed).toBe(1);
  });

  /**
   * Both answers take the row out of the queue, and both must take it out of
   * the count — for opposite reasons. `left_control` realized the gain, so
   * there is nothing missing from the figure. `untracked` says it was never a
   * sale, so there is nothing missing either. A caveat that survived an answer
   * would be a number the reader cannot drive to zero.
   */
  test('either answer clears the count', async () => {
    const svc = makeService();
    for (const answer of ['left_control', 'untracked']) {
      const r = await svc.walkLots(
        [
          buy('h'),
          tx({
            holdingId: 'h',
            kind: 'withdraw',
            quantity: '-4',
            occurredAt: '2024-02-01',
            priceNative: '150',
            priceNativeTokenId: USD,
            transferReview: answer,
          }),
        ],
        USD,
        BTC
      );
      expect(r.transfersUnreviewed).toBe(0);
    }
  });

  test('each unanswered outflow counts once, not each holding', async () => {
    const svc = makeService();
    const r = await svc.walkLots(
      [
        buy('h'),
        tx({ holdingId: 'h', kind: 'withdraw', quantity: '-2', occurredAt: '2024-02-01' }),
        tx({ holdingId: 'h', kind: 'transfer_out', quantity: '-3', occurredAt: '2024-03-01' }),
      ],
      USD,
      BTC
    );
    expect(r.transfersUnreviewed).toBe(2);
  });

  test('a sell is not a transfer and is never counted', async () => {
    const svc = makeService();
    const r = await svc.walkLots(
      [
        buy('h'),
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
    expect(r.realizedPnl.toString()).toBe('200');
    expect(r.transfersUnreviewed).toBe(0);
  });

  /**
   * The count is as-of `at`, like every other figure the walk produces. A
   * withdrawal that has not happened yet cannot be shortening the PnL of a day
   * before it — a caveat stamped on the whole series would put today's queue
   * on a chart point from last year.
   */
  test('an outflow after `at` is not yet counted', async () => {
    const svc = makeService();
    const txs = [
      buy('h'),
      tx({ holdingId: 'h', kind: 'withdraw', quantity: '-4', occurredAt: '2024-06-01' }),
    ];
    const before = await svc.getCostBasis('h', new Date('2024-03-01'), USD, {
      heldTokenId: BTC,
      txs,
    });
    const after = await svc.getCostBasis('h', new Date('2024-07-01'), USD, {
      heldTokenId: BTC,
      txs,
    });
    expect(before.transfersUnreviewed).toBe(0);
    expect(after.transfersUnreviewed).toBe(1);
  });

  test('an unanswered exit inside a transfer component counts against its own holding', async () => {
    const svc = makeService();
    const txsByHolding = new Map<string, HoldingTransaction[]>([
      [
        'A',
        [
          buy('A'),
          // Linked and paired — a hop between the user's own accounts. Never a
          // question, so never a caveat.
          tx({
            holdingId: 'A',
            kind: 'transfer_out',
            quantity: '-4',
            occurredAt: '2024-02-01',
            transferGroupId: 'g1',
          }),
          // Unlinked and unanswered — the queue holds this one.
          tx({
            holdingId: 'A',
            kind: 'withdraw',
            quantity: '-3',
            occurredAt: '2024-03-01',
            priceNative: '150',
            priceNativeTokenId: USD,
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
            transferGroupId: 'g1',
          }),
        ],
      ],
    ]);
    const r = await svc.walkComponent(['A', 'B'], txsByHolding, FUTURE, USD, heldTokens);
    // Attributed to the holding it left, so the per-holding rollup rows the
    // home chart sums add up to the user-wide count.
    expect(r.get('A')?.transfersUnreviewed).toBe(1);
    expect(r.get('B')?.transfersUnreviewed).toBe(0);
  });

  /**
   * A `transfer_group_id` with only one leg in the walk books nothing either
   * — but it is NOT in the review queue (`pendingPredicate` requires a null
   * group id), so there is no row for a reader to answer. Counting it would
   * put a number on the chart that the page it links to cannot explain.
   *
   * It is also usually not an unanswered question at all: at a snapshot date
   * before the paired inflow occurred, not realizing is the correct answer and
   * it resolves itself the day the pair completes.
   */
  test('a half-linked outflow books nothing and is NOT counted', async () => {
    const svc = makeService();
    const txsByHolding = new Map<string, HoldingTransaction[]>([
      [
        'A',
        [
          buy('A'),
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
    expect(r.get('A')?.realizedPnl.toString()).toBe('0');
    expect(r.get('A')?.transfersUnreviewed).toBe(0);
  });
});
