process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import {
  CostBasisService,
  type DisposalLotMatch,
  type HistoryCompleteness,
} from '../../../src/services/pricing/CostBasisService';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';

/**
 * The per-disposal ledger (SC-152).
 *
 * The load-bearing assertion in this file is `gainTotal(...) === realizedPnl`:
 * the sum of the per-row gains must equal the scalar the same walk accumulates.
 * That scalar is what every PnL chart, every `portfolio_value_daily` row and
 * both exports already show, so a ledger whose rows do not add up to it is an
 * explanation that contradicts the figure it explains — and it would do so
 * silently, on the screen the reader opened to resolve a doubt.
 *
 * The second thing these tests pin is SC-150: only a person's `left_control`
 * answer books a gain. The ledger has to record the *absence* of a realization
 * as its own outcome, because "nothing happened" and "we are waiting on you"
 * are the same arithmetic and different answers.
 */

// Stubs leak across files because typedi's Container is process-global.
afterAll(() => {
  Container.set(HoldingRepository, new HoldingRepository());
  Container.set(HoldingTransactionRepository, new HoldingTransactionRepository());
  Container.set(PriceGraphService, new PriceGraphService());
  Container.set(CostBasisService, new CostBasisService());
});

const USD = 'token-USD';
const BTC = 'token-BTC';

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

let txSeq = 0;
function tx(p: {
  holdingId: string;
  kind: string;
  quantity: string;
  occurredAt: string;
  priceNative?: string;
  transferGroupId?: string;
  transferReview?: string;
  transferReviewSplit?: unknown;
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
    transferReviewSplit: p.transferReviewSplit ?? null,
    transferReviewedAt: p.transferReview ? new Date() : null,
    source: 's',
    sourceMetadata: {},
    rawPayload: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as HoldingTransaction;
}

/** The invariant, in one place: rows that booked nothing carry a null gain and
 *  contribute nothing, and everything else must add up to the scalar. */
function gainTotal(rows: readonly DisposalLotMatch[]): Decimal {
  return rows.reduce((sum, d) => (d.gain ? sum.add(d.gain) : sum), new Decimal(0));
}

const componentInputs = (txs: HoldingTransaction[]): Map<string, HoldingTransaction[]> => {
  const byHolding = new Map<string, HoldingTransaction[]>();
  for (const t of txs) {
    const list = byHolding.get(t.holdingId);
    if (list) list.push(t);
    else byHolding.set(t.holdingId, [t]);
  }
  return byHolding;
};

describe('walkLots disposal ledger', () => {
  test('one row per matched lot, each with its own acquisition date', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '4',
          occurredAt: '2024-01-01',
          priceNative: '100',
        }),
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '6',
          occurredAt: '2024-06-01',
          priceNative: '200',
        }),
        tx({
          holdingId: 'h',
          kind: 'sell',
          quantity: '-8',
          occurredAt: '2025-03-01',
          priceNative: '300',
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    expect(ledger).toHaveLength(2);
    const [first, second] = ledger as [DisposalLotMatch, DisposalLotMatch];

    // FIFO: the whole January lot, then 4 of the 6 bought in June.
    expect(first.quantity.toString()).toBe('4');
    expect(first.acquiredAt?.toISOString().slice(0, 10)).toBe('2024-01-01');
    expect(first.costBasis.toString()).toBe('400');
    // Proceeds split pro-rata by quantity: 2400 total × 4/8.
    expect(first.proceeds?.toString()).toBe('1200');
    expect(first.gain?.toString()).toBe('800');
    expect(first.holdingDays).toBe(425);
    expect(first.outcome).toBe('realized');
    expect(first.basisQuality).toBe('known');

    expect(second.quantity.toString()).toBe('4');
    expect(second.acquiredAt?.toISOString().slice(0, 10)).toBe('2024-06-01');
    expect(second.costBasis.toString()).toBe('800');
    expect(second.proceeds?.toString()).toBe('1200');
    expect(second.gain?.toString()).toBe('400');
    expect(second.holdingDays).toBe(273);

    // The invariant. 2400 proceeds − 1200 basis = 1200 realized.
    expect(gainTotal(ledger).toString()).toBe(r.realizedPnl.toString());
    expect(r.realizedPnl.toString()).toBe('1200');
  });

  test('a disposal with no acquisition record gets its own row, graded unknown', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      [
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
          quantity: '-10',
          occurredAt: '2024-02-01',
          priceNative: '200',
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    expect(ledger).toHaveLength(2);
    const matched = ledger[0] as DisposalLotMatch;
    const orphan = ledger[1] as DisposalLotMatch;

    expect(matched.quantity.toString()).toBe('4');
    expect(matched.acquiredAt).not.toBeNull();
    expect(matched.basisQuality).toBe('known');

    // The 6 units nothing acquired: reported with a blank basis and no date,
    // rather than folded into the matched row as free gain.
    expect(orphan.quantity.toString()).toBe('6');
    expect(orphan.acquiredAt).toBeNull();
    expect(orphan.holdingDays).toBeNull();
    expect(orphan.costBasis.toString()).toBe('0');
    expect(orphan.proceeds?.toString()).toBe('1200');
    expect(orphan.gain?.toString()).toBe('1200');
    // The grade is the point: this gain is the whole of its proceeds because
    // we have no acquisition, which is most often our own truncated import.
    expect(orphan.basisQuality).toBe('unknown');

    expect(gainTotal(ledger).toString()).toBe(r.realizedPnl.toString());
  });

  test('an unpriceable swap_out reports null proceeds, never a zero', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '10',
          occurredAt: '2024-01-01',
          priceNative: '100',
        }),
        tx({ holdingId: 'h', kind: 'swap_out', quantity: '-10', occurredAt: '2024-02-01' }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    expect(ledger).toHaveLength(1);
    const row = ledger[0] as DisposalLotMatch;
    expect(row.outcome).toBe('unpriced');
    expect(row.proceeds).toBeNull();
    expect(row.gain).toBeNull();
    // Basis is known even when proceeds are not — shown, and never netted
    // against a figure that does not exist.
    expect(row.costBasis.toString()).toBe('1000');
    expect(r.realizedPnl.toString()).toBe('0');
    expect(gainTotal(ledger).toString()).toBe(r.realizedPnl.toString());
  });

  test('an unanswered withdrawal books nothing and says so (SC-150)', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '10',
          occurredAt: '2024-01-01',
          priceNative: '100',
        }),
        tx({
          holdingId: 'h',
          kind: 'withdraw',
          quantity: '-10',
          occurredAt: '2024-02-01',
          priceNative: '150',
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    expect(ledger).toHaveLength(1);
    const row = ledger[0] as DisposalLotMatch;
    // Before SC-150 this booked a 500 gain nobody made. The row exists so the
    // reader can see the lots left and the gain did not follow, and where the
    // answer lives.
    expect(row.outcome).toBe('unreviewed');
    expect(row.gain).toBeNull();
    expect(row.proceeds).toBeNull();
    expect(row.costBasis.toString()).toBe('1000');
    expect(r.realizedPnl.toString()).toBe('0');
    expect(r.transfersUnreviewed).toBe(1);
    expect(gainTotal(ledger).toString()).toBe(r.realizedPnl.toString());
  });

  test('a left_control withdrawal realizes, tagged with its raw kind', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '10',
          occurredAt: '2024-01-01',
          priceNative: '100',
        }),
        tx({
          holdingId: 'h',
          kind: 'withdraw',
          quantity: '-10',
          occurredAt: '2024-02-01',
          priceNative: '150',
          transferReview: 'left_control',
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    expect(ledger).toHaveLength(1);
    const row = ledger[0] as DisposalLotMatch;
    expect(row.outcome).toBe('realized');
    // `withdraw`, not `sell`: an exit somebody confirmed is still not a stated
    // sale, and the ledger reports what the ledger recorded.
    expect(row.kind).toBe('withdraw');
    expect(row.gain?.toString()).toBe('500');
    expect(r.realizedPnl.toString()).toBe('500');
    expect(r.transfersUnreviewed).toBe(0);
    expect(gainTotal(ledger).toString()).toBe(r.realizedPnl.toString());
  });

  test('an untracked withdrawal is answered, not queued', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '10',
          occurredAt: '2024-01-01',
          priceNative: '100',
        }),
        tx({
          holdingId: 'h',
          kind: 'transfer_out',
          quantity: '-10',
          occurredAt: '2024-02-01',
          priceNative: '150',
          transferReview: 'untracked',
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    // The same arithmetic as `unreviewed` and a different answer: the reader
    // said this is still their money, so nothing is owed and nothing is asked.
    expect((ledger[0] as DisposalLotMatch).outcome).toBe('retained');
    expect(r.realizedPnl.toString()).toBe('0');
    expect(r.transfersUnreviewed).toBe(0);
  });

  test('a truncated history grades every row it produced as partial (SC-149)', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const history: HistoryCompleteness = 'incomplete';
    const r = await svc.walkLots(
      [
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
          occurredAt: '2024-02-01',
          priceNative: '200',
        }),
      ],
      USD,
      BTC,
      undefined,
      history,
      ledger
    );

    // The figure is unchanged and the claim about it is not. A gain derived
    // from an import that reported itself truncated must not read as settled
    // wherever the lots are shown.
    expect((ledger[0] as DisposalLotMatch).basisQuality).toBe('partial');
    expect(r.basisQuality).toBe('partial');
    expect(gainTotal(ledger).toString()).toBe(r.realizedPnl.toString());
  });

  test('an inflow nothing could value grades its disposal partial, not known', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    // No priceNative and the held token is not the base currency, so the
    // fallback would need FX — and the stub throws if it is asked. Nothing
    // values this inflow, so the lot opens at zero cost.
    const r = await svc.walkLots(
      [
        tx({ holdingId: 'h', kind: 'swap_in', quantity: '10', occurredAt: '2024-01-01' }),
        tx({
          holdingId: 'h',
          kind: 'sell',
          quantity: '-10',
          occurredAt: '2024-02-01',
          priceNative: '100',
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    const row = ledger[0] as DisposalLotMatch;
    expect(row.costBasis.toString()).toBe('0');
    expect(row.gain?.toString()).toBe('1000');
    // A zero basis we chose because we could not price the acquisition, not
    // because the acquisition was free. Same shape as the orphan row above.
    expect(row.basisQuality).toBe('partial');
    expect(gainTotal(ledger).toString()).toBe(r.realizedPnl.toString());
  });
});

describe('walkComponent disposal ledger', () => {
  test('a linked transfer is not a disposal and does not restart the holding period', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const txs = [
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
      tx({
        holdingId: 'ledger',
        kind: 'transfer_in',
        quantity: '10',
        occurredAt: '2024-06-01',
        transferGroupId: 'g1',
      }),
      tx({
        holdingId: 'ledger',
        kind: 'sell',
        quantity: '-10',
        occurredAt: '2025-01-01',
        priceNative: '300',
      }),
    ];

    const result = await svc.walkComponent(
      ['kraken', 'ledger'],
      componentInputs(txs),
      new Date('2026-01-01'),
      USD,
      new Map([
        ['kraken', BTC],
        ['ledger', BTC],
      ]),
      undefined,
      new Map<string, HistoryCompleteness>([
        ['kraken', 'complete'],
        ['ledger', 'complete'],
      ]),
      ledger
    );

    // One row only — the sale. The transfer produced none, because a move
    // between the reader's own accounts is not an event.
    expect(ledger).toHaveLength(1);
    const row = ledger[0] as DisposalLotMatch;
    expect(row.kind).toBe('sell');
    expect(row.holdingId).toBe('ledger');
    // Acquisition date survived the transfer: bought Jan 2023, not moved Jun 2024.
    expect(row.acquiredAt?.toISOString().slice(0, 10)).toBe('2023-01-01');
    expect(row.costBasis.toString()).toBe('1000');
    expect(row.proceeds?.toString()).toBe('3000');
    expect(row.holdingDays).toBe(731);

    const scalar = [...result.values()].reduce((sum, c) => sum.add(c.realizedPnl), new Decimal(0));
    expect(gainTotal(ledger).toString()).toBe(scalar.toString());
  });

  test('a transfer_out whose pair never arrives books nothing and is not queued', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const txs = [
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
        priceNative: '250',
        transferGroupId: 'orphan',
      }),
      // A second holding shares the component so walkComponent is the right walker.
      tx({
        holdingId: 'ledger',
        kind: 'buy',
        quantity: '1',
        occurredAt: '2023-01-01',
        priceNative: '100',
      }),
      tx({
        holdingId: 'ledger',
        kind: 'transfer_out',
        quantity: '-1',
        occurredAt: '2023-02-01',
        transferGroupId: 'g2',
      }),
      tx({
        holdingId: 'kraken',
        kind: 'transfer_in',
        quantity: '1',
        occurredAt: '2023-02-01',
        transferGroupId: 'g2',
      }),
    ];

    const result = await svc.walkComponent(
      ['kraken', 'ledger'],
      componentInputs(txs),
      new Date('2026-01-01'),
      USD,
      new Map([
        ['kraken', BTC],
        ['ledger', BTC],
      ]),
      undefined,
      new Map<string, HistoryCompleteness>([
        ['kraken', 'complete'],
        ['ledger', 'complete'],
      ]),
      ledger
    );

    expect(ledger).toHaveLength(1);
    const row = ledger[0] as DisposalLotMatch;
    expect(row.kind).toBe('transfer_out');
    expect(row.holdingId).toBe('kraken');
    // A group id with one leg is no more evidence of a sale than no group id
    // at all — it is evidence of an import that fetched one side. Nothing is
    // realized, and it is distinct from `unreviewed` because the review queue
    // does not hold it: there is nothing here a reader could go and answer.
    expect(row.outcome).toBe('awaiting_pair');
    expect(row.gain).toBeNull();
    expect(row.costBasis.toString()).toBe('1000');

    const scalar = [...result.values()].reduce((sum, c) => sum.add(c.realizedPnl), new Decimal(0));
    expect(scalar.toString()).toBe('0');
    expect(gainTotal(ledger).toString()).toBe(scalar.toString());
    expect(result.get('kraken')?.transfersUnreviewed).toBe(0);
  });

  test('a sale spanning lots from two accounts splits into one row per lot', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const txs = [
      tx({
        holdingId: 'a',
        kind: 'buy',
        quantity: '5',
        occurredAt: '2023-01-01',
        priceNative: '100',
      }),
      tx({
        holdingId: 'b',
        kind: 'buy',
        quantity: '5',
        occurredAt: '2023-06-01',
        priceNative: '200',
      }),
      tx({
        holdingId: 'b',
        kind: 'transfer_out',
        quantity: '-5',
        occurredAt: '2024-01-01',
        transferGroupId: 'g',
      }),
      tx({
        holdingId: 'a',
        kind: 'transfer_in',
        quantity: '5',
        occurredAt: '2024-01-01',
        transferGroupId: 'g',
      }),
      tx({
        holdingId: 'a',
        kind: 'sell',
        quantity: '-10',
        occurredAt: '2024-07-01',
        priceNative: '400',
      }),
    ];

    const result = await svc.walkComponent(
      ['a', 'b'],
      componentInputs(txs),
      new Date('2026-01-01'),
      USD,
      new Map([
        ['a', BTC],
        ['b', BTC],
      ]),
      undefined,
      new Map<string, HistoryCompleteness>([
        ['a', 'complete'],
        ['b', 'complete'],
      ]),
      ledger
    );

    expect(ledger).toHaveLength(2);
    expect(ledger.map((d) => d.acquiredAt?.toISOString().slice(0, 10))).toEqual([
      '2023-01-01',
      '2023-06-01',
    ]);
    expect(ledger.map((d) => d.costBasis.toString())).toEqual(['500', '1000']);
    expect(ledger.map((d) => d.proceeds?.toString())).toEqual(['2000', '2000']);

    const scalar = [...result.values()].reduce((sum, c) => sum.add(c.realizedPnl), new Decimal(0));
    expect(gainTotal(ledger).toString()).toBe(scalar.toString());
    expect(scalar.toString()).toBe('2500');
  });

  test('an unanswered exit out of a component is graded against its own holding', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const txs = [
      // `kraken` is the truncated one. `ledger` is complete, and its own sale
      // must not inherit kraken's doubt just because a transfer connects them.
      tx({
        holdingId: 'kraken',
        kind: 'buy',
        quantity: '10',
        occurredAt: '2023-01-01',
        priceNative: '100',
      }),
      tx({ holdingId: 'kraken', kind: 'withdraw', quantity: '-4', occurredAt: '2024-03-01' }),
      tx({
        holdingId: 'kraken',
        kind: 'transfer_out',
        quantity: '-6',
        occurredAt: '2024-06-01',
        transferGroupId: 'g1',
      }),
      tx({
        holdingId: 'ledger',
        kind: 'transfer_in',
        quantity: '6',
        occurredAt: '2024-06-01',
        transferGroupId: 'g1',
      }),
      tx({
        holdingId: 'ledger',
        kind: 'sell',
        quantity: '-6',
        occurredAt: '2025-01-01',
        priceNative: '300',
      }),
    ];

    const result = await svc.walkComponent(
      ['kraken', 'ledger'],
      componentInputs(txs),
      new Date('2026-01-01'),
      USD,
      new Map([
        ['kraken', BTC],
        ['ledger', BTC],
      ]),
      undefined,
      new Map<string, HistoryCompleteness>([
        ['kraken', 'incomplete'],
        ['ledger', 'complete'],
      ]),
      ledger
    );

    const unanswered = ledger.find((d) => d.holdingId === 'kraken') as DisposalLotMatch;
    const sale = ledger.find((d) => d.holdingId === 'ledger') as DisposalLotMatch;

    expect(unanswered.outcome).toBe('unreviewed');
    expect(unanswered.basisQuality).toBe('partial');
    // The sale happened out of a holding whose own history is complete, and
    // the lot carried its cost across intact. Grading it against kraken's
    // truncation would put a caveat on a figure that does not rest on it.
    expect(sale.outcome).toBe('realized');
    expect(sale.basisQuality).toBe('known');
    expect(result.get('kraken')?.transfersUnreviewed).toBe(1);

    const scalar = [...result.values()].reduce((sum, c) => sum.add(c.realizedPnl), new Decimal(0));
    expect(gainTotal(ledger).toString()).toBe(scalar.toString());
  });
});

/**
 * An answer that applies to PART of an outflow (SC-181).
 *
 * The reported case: a 4,000 withdrawal of which 3,500 moved to an untracked
 * account and 500 genuinely left. Before this, `left_control` realized all
 * 4,000 (overstating by 3,500) and `untracked` realized nothing (understating
 * by 500) — the same one-directional-error family as SC-149/150/151/166,
 * arriving through the answer model rather than the data.
 *
 * The load-bearing assertions are the same two as everywhere in this file: the
 * lots popped for one transaction still sum to its quantity, and the per-row
 * gains still sum to the scalar the walk accumulates.
 */
describe('a divided answer', () => {
  // A `paired` part carries its deposit's id — `transferReviewSplitSchema`
  // refuses one without it, and a split the walk cannot parse is treated as
  // unanswered rather than as settled. So a fixture that omits it is not
  // testing a paired share; it is testing the fallback.
  const MATCH_ID = '11111111-2222-4333-8444-555555555555';

  const SPLIT_3500_500 = [
    { decision: 'untracked', quantity: '3500' },
    { decision: 'left_control', quantity: '500' },
  ];

  test('realizes only the disposed share, against the lots that share consumed', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      [
        tx({
          holdingId: 'h',
          kind: 'deposit',
          quantity: '4000',
          occurredAt: '2024-01-01',
          priceNative: '1',
        }),
        tx({
          holdingId: 'h',
          kind: 'withdraw',
          quantity: '-4000',
          occurredAt: '2025-01-01',
          priceNative: '2',
          transferReview: 'split',
          transferReviewSplit: SPLIT_3500_500,
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    // 500 realized at 2 = 1000 proceeds, against 500 of basis at 1.
    expect(r.realizedPnl.toString()).toBe('500');
    expect(gainTotal(ledger).toString()).toBe(r.realizedPnl.toString());

    expect(ledger).toHaveLength(2);
    const [untracked, disposed] = ledger as [DisposalLotMatch, DisposalLotMatch];
    expect(untracked.quantity.toString()).toBe('3500');
    expect(untracked.outcome).toBe('retained');
    expect(untracked.gain).toBeNull();
    expect(untracked.portionIndex).toBe(0);
    expect(untracked.portionCount).toBe(2);

    expect(disposed.quantity.toString()).toBe('500');
    expect(disposed.outcome).toBe('realized');
    expect(disposed.proceeds?.toString()).toBe('1000');
    expect(disposed.costBasis.toString()).toBe('500');
    expect(disposed.gain?.toString()).toBe('500');
    expect(disposed.portionIndex).toBe(1);
    expect(disposed.portionCount).toBe(2);

    // The whole 4,000 left the holding either way — the shares divide what
    // happened to it, not whether it went.
    expect(r.openQty.toString()).toBe('0');
  });

  test('is bounded by the two whole answers it sits between', async () => {
    const history = (review: string, split?: unknown) => [
      tx({
        holdingId: 'h',
        kind: 'deposit',
        quantity: '4000',
        occurredAt: '2024-01-01',
        priceNative: '1',
      }),
      tx({
        holdingId: 'h',
        kind: 'withdraw',
        quantity: '-4000',
        occurredAt: '2025-01-01',
        priceNative: '2',
        transferReview: review,
        ...(split ? { transferReviewSplit: split } : {}),
      }),
    ];

    const whole = await makeService().walkLots(history('left_control'), USD, BTC);
    const none = await makeService().walkLots(history('untracked'), USD, BTC);
    const split = await makeService().walkLots(history('split', SPLIT_3500_500), USD, BTC);

    expect(whole.realizedPnl.toString()).toBe('4000');
    expect(none.realizedPnl.toString()).toBe('0');
    // Strictly between the two wrong answers, which is the whole point.
    expect(split.realizedPnl.toString()).toBe('500');
  });

  test('walks three shares, and each pops the lots FIFO in the order written', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '600',
          occurredAt: '2024-01-01',
          priceNative: '1',
        }),
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '400',
          occurredAt: '2024-06-01',
          priceNative: '3',
        }),
        tx({
          holdingId: 'h',
          kind: 'withdraw',
          quantity: '-1000',
          occurredAt: '2025-01-01',
          priceNative: '5',
          transferReview: 'split',
          transferReviewSplit: [
            { decision: 'untracked', quantity: '500' },
            { decision: 'left_control', quantity: '300' },
            { decision: 'paired', quantity: '200', matchTransactionId: MATCH_ID },
          ],
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    // The untracked 500 takes the January lot's first 500 at cost 1. The
    // disposed 300 then takes January's remaining 100 (cost 100) and 200 of
    // June (cost 600) — 700 of basis against 1500 of proceeds.
    expect(r.realizedPnl.toString()).toBe('800');
    expect(gainTotal(ledger).toString()).toBe(r.realizedPnl.toString());

    const byPortion: Record<number, DisposalLotMatch[]> = {};
    for (const row of ledger) {
      const bucket = byPortion[row.portionIndex] ?? [];
      bucket.push(row);
      byPortion[row.portionIndex] = bucket;
    }
    expect(Object.keys(byPortion)).toEqual(['0', '1', '2']);
    expect(byPortion[0]?.every((row) => row.outcome === 'retained')).toBe(true);
    expect(byPortion[1]?.every((row) => row.outcome === 'realized')).toBe(true);
    expect(ledger.every((row) => row.portionCount === 3)).toBe(true);

    // Every share's lots sum back to the share, and the shares to the row.
    const walked = ledger.reduce((sum, row) => sum.add(row.quantity), new Decimal(0));
    expect(walked.toString()).toBe('1000');
  });

  test('a paired share carries its lots across and the rest is answered here', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const group = 'grp-split';
    const txs = [
      tx({
        holdingId: 'src',
        kind: 'buy',
        quantity: '4000',
        occurredAt: '2024-01-01',
        priceNative: '1',
      }),
      tx({
        holdingId: 'src',
        kind: 'withdraw',
        quantity: '-4000',
        occurredAt: '2025-01-01',
        priceNative: '2',
        transferGroupId: group,
        transferReview: 'split',
        transferReviewSplit: [
          { decision: 'paired', quantity: '3500', matchTransactionId: MATCH_ID },
          { decision: 'left_control', quantity: '500' },
        ],
      }),
      tx({
        holdingId: 'dst',
        kind: 'transfer_in',
        quantity: '3500',
        occurredAt: '2025-01-01',
        transferGroupId: group,
      }),
    ];

    const out = await svc.walkComponent(
      ['src', 'dst'],
      componentInputs(txs),
      new Date('2025-06-01'),
      USD,
      new Map([
        ['src', BTC],
        ['dst', BTC],
      ]),
      undefined,
      new Map(),
      ledger
    );

    // The destination inherits the 3,500 at its ORIGINAL cost of 1 — not
    // re-opened at the market value of 2, which is what an unsplit answer of
    // `left_control` would have implied for all 4,000.
    const dst = out.get('dst');
    expect(dst?.openQty.toString()).toBe('3500');
    expect(dst?.costBasis.toString()).toBe('3500');

    // Only the 500 that left books a gain: 1000 proceeds − 500 basis.
    const src = out.get('src');
    expect(src?.realizedPnl.toString()).toBe('500');
    expect(gainTotal(ledger).toString()).toBe('500');

    // The carried share is deliberately absent from the ledger — it is not a
    // disposal and never was one.
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.quantity.toString()).toBe('500');
    expect(ledger[0]?.outcome).toBe('realized');
    expect(ledger[0]?.portionCount).toBe(2);
  });

  test('a paired share whose partner never arrives books nothing and says why', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const txs = [
      tx({
        holdingId: 'src',
        kind: 'buy',
        quantity: '4000',
        occurredAt: '2024-01-01',
        priceNative: '1',
      }),
      tx({
        holdingId: 'src',
        kind: 'withdraw',
        quantity: '-4000',
        occurredAt: '2025-01-01',
        priceNative: '2',
        transferGroupId: 'grp-orphan',
        transferReview: 'split',
        transferReviewSplit: [
          { decision: 'paired', quantity: '3500', matchTransactionId: MATCH_ID },
          { decision: 'untracked', quantity: '500' },
        ],
      }),
    ];

    const out = await svc.walkComponent(
      ['src'],
      componentInputs(txs),
      new Date('2025-06-01'),
      USD,
      new Map([['src', BTC]]),
      undefined,
      new Map(),
      ledger
    );

    expect(out.get('src')?.realizedPnl.toString()).toBe('0');
    expect(ledger.map((row) => row.outcome).sort()).toEqual(['awaiting_pair', 'retained']);
    expect(gainTotal(ledger).toString()).toBe('0');
  });

  test('parts that no longer cover the row leave the remainder unanswered', async () => {
    // A re-import can correct a quantity after the answer was written; the
    // transaction stays the authority on how much left. The walk must never
    // pop more or less than the row, and drift shows as an open question
    // rather than being repaired into a number nobody chose.
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '5000',
          occurredAt: '2024-01-01',
          priceNative: '1',
        }),
        tx({
          holdingId: 'h',
          kind: 'withdraw',
          quantity: '-5000',
          occurredAt: '2025-01-01',
          priceNative: '2',
          transferReview: 'split',
          transferReviewSplit: SPLIT_3500_500,
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    const walked = ledger.reduce((sum, row) => sum.add(row.quantity), new Decimal(0));
    expect(walked.toString()).toBe('5000');
    expect(r.openQty.toString()).toBe('0');
    expect(ledger.at(-1)?.quantity.toString()).toBe('1000');
    expect(ledger.at(-1)?.outcome).toBe('unreviewed');
    expect(ledger.every((row) => row.portionCount === 3)).toBe(true);
  });

  test('a division that will not parse is an open question, not a settled one', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '100',
          occurredAt: '2024-01-01',
          priceNative: '1',
        }),
        tx({
          holdingId: 'h',
          kind: 'withdraw',
          quantity: '-100',
          occurredAt: '2025-01-01',
          priceNative: '2',
          transferReview: 'split',
          transferReviewSplit: { nonsense: true },
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    expect(r.realizedPnl.toString()).toBe('0');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.outcome).toBe('unreviewed');
  });

  test('an undivided outflow is unchanged — one share, one row, index 0 of 1', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '10',
          occurredAt: '2024-01-01',
          priceNative: '100',
        }),
        tx({
          holdingId: 'h',
          kind: 'withdraw',
          quantity: '-10',
          occurredAt: '2025-01-01',
          priceNative: '150',
          transferReview: 'left_control',
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    expect(r.realizedPnl.toString()).toBe('500');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.portionIndex).toBe(0);
    expect(ledger[0]?.portionCount).toBe(1);
  });
});
