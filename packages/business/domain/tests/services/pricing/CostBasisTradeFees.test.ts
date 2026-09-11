process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import { TRANSFER_REVIEW_SPLIT } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import {
  type CostBasisMethod,
  CostBasisService,
  type DisposalLotMatch,
} from '../../../src/services/pricing/CostBasisService';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import {
  BNB,
  BTC,
  byHolding,
  ETH,
  FUTURE,
  HELD_TOKENS,
  type LedgerRow,
  ledger,
  OBSCURE,
  priceGraphStub,
  row,
  USD,
  walkEverything,
} from './fixtures/zero-fee-ledger';

/**
 * A trade's fee reaches its cost basis (SC-1142).
 *
 * The treatment is the standard one and it is the same under both regimes,
 * because incidental costs are allowable under FIFO and Section 104 alike: a
 * fee paid to ACQUIRE adds to the lot's cost, and a fee paid to DISPOSE comes
 * off the proceeds.
 *
 * The first describe block is the one that matters. An assertion that a fee
 * moves a figure by exactly the fee is compatible with having moved every
 * other figure as well; what rules that out is a ledger with no fees in it
 * producing, byte for byte, what it produced before fees reached the walk.
 */

restoreContainerAfterAll();

const GOLDEN = `${import.meta.dir}/fixtures/zero-fee-golden.json`;

interface ConvertCall {
  from: string;
  at: Date;
}

function makeService(calls: ConvertCall[] = []): CostBasisService {
  Container.set(HoldingRepository, {} as unknown as HoldingRepository);
  Container.set(HoldingTransactionRepository, {} as unknown as HoldingTransactionRepository);
  Container.set(PriceGraphService, {
    convert: async (amount: Decimal | string, from: string, to: string, at: Date) => {
      calls.push({ from, at });
      return priceGraphStub.convert(amount, from, to);
    },
  } as unknown as PriceGraphService);
  const instance = new CostBasisService();
  Container.set(CostBasisService, instance);
  return instance;
}

const serialize = (walked: unknown): string => `${JSON.stringify(walked, null, 2)}\n`;

let seq = 0;
const tx = (p: LedgerRow): HoldingTransaction => {
  seq += 1;
  return row(`fee-${seq}`, p);
};

const buy = (extra: Partial<LedgerRow> = {}): HoldingTransaction =>
  tx({
    holdingId: 'A',
    kind: 'buy',
    quantity: '1',
    occurredAt: '2024-01-01T10:00:00Z',
    priceNative: '100',
    ...extra,
  });

const sell = (extra: Partial<LedgerRow> = {}): HoldingTransaction =>
  tx({
    holdingId: 'A',
    kind: 'sell',
    quantity: '-1',
    occurredAt: '2024-06-01T10:00:00Z',
    priceNative: '150',
    ...extra,
  });

async function walk(
  rows: HoldingTransaction[],
  method: CostBasisMethod = 'fifo',
  svc = makeService()
) {
  const collect: DisposalLotMatch[] = [];
  const r = await svc.walkLots(undefined, rows, USD, BTC, undefined, 'complete', collect, method);
  return { ...r, collect };
}

describe('a ledger with no trade fees is untouched (SC-1142 control)', () => {
  test('reproduces the figures main produced before fees reached the walk, byte for byte', async () => {
    const walked = await walkEverything(makeService(), ledger());
    expect(serialize(walked)).toBe(await Bun.file(GOLDEN).text());
  });

  test('a fee of zero is no fee, whatever its sign, spelling or token', async () => {
    const zeros = ['0', '-0', '0.000', '-0.00000000'];
    let i = 0;
    const walked = await walkEverything(
      makeService(),
      ledger((_id, p) => {
        i += 1;
        return { ...p, feeQuantity: zeros[i % zeros.length], feeTokenId: i % 2 ? USD : BNB };
      })
    );
    expect(serialize(walked)).toBe(await Bun.file(GOLDEN).text());
  });

  test('the comparison can fail: one fee on one buy moves the golden figures', async () => {
    const walked = await walkEverything(
      makeService(),
      ledger((id, p) => (id === 'a01' ? { ...p, feeQuantity: '-1', feeTokenId: USD } : p))
    );
    expect(serialize(walked)).not.toBe(await Bun.file(GOLDEN).text());
  });
});

describe.each([
  'fifo',
  'uk_section_104',
] as const)('%s — the fee is the only thing that moves', (method) => {
  test('an acquisition fee raises the lot cost by exactly the fee', async () => {
    const without = await walk([buy()], method);
    const withFee = await walk([buy({ feeQuantity: '-1', feeTokenId: USD })], method);
    expect(without.costBasis.toString()).toBe('100');
    expect(withFee.costBasis.toString()).toBe('101');
    expect(withFee.openQty.toString()).toBe('1');
  });

  test('a disposal fee lowers realized gain by exactly the fee', async () => {
    const without = await walk([buy(), sell()], method);
    const withFee = await walk([buy(), sell({ feeQuantity: '-1', feeTokenId: USD })], method);
    expect(without.realizedPnl.toString()).toBe('50');
    expect(withFee.realizedPnl.toString()).toBe('49');
    expect(withFee.costBasis.toString()).toBe('0');
  });

  test('both fees on one round trip cost exactly both fees', async () => {
    const r = await walk(
      [buy({ feeQuantity: '-1', feeTokenId: USD }), sell({ feeQuantity: '-2', feeTokenId: USD })],
      method
    );
    // 150 - 2 proceeds against 100 + 1 of cost.
    expect(r.realizedPnl.toString()).toBe('47');
  });

  test('the per-row ledger still sums to the scalar, fee included', async () => {
    const r = await walk(
      [
        // Quantities that halve the pool exactly. A draw of a third leaves the
        // rows 1e-25 apart from the scalar with or without any fee, which is
        // `drawPooled`'s rounding and not what this asserts.
        buy({ quantity: '2', feeQuantity: '-3', feeTokenId: USD }),
        buy({
          quantity: '2',
          occurredAt: '2024-02-01T10:00:00Z',
          priceNative: '120',
          feeQuantity: '-1',
          feeTokenId: USD,
        }),
        sell({ quantity: '-2', feeQuantity: '-4', feeTokenId: USD }),
      ],
      method
    );
    const summed = r.collect.reduce((s, m) => (m.gain ? s.add(m.gain) : s), new Decimal(0));
    expect(summed.toString()).toBe(r.realizedPnl.toString());
  });

  test('the transfer-linked walk applies the same fees as the singleton walk', async () => {
    const svc = makeService();
    const component = await svc.walkComponent(
      undefined,
      ['A', 'B'],
      byHolding([
        buy({ feeQuantity: '-1', feeTokenId: USD }),
        tx({
          holdingId: 'A',
          kind: 'transfer_out',
          quantity: '-1',
          occurredAt: '2024-03-01T10:00:00Z',
          transferGroupId: 'g',
        }),
        tx({
          holdingId: 'B',
          kind: 'transfer_in',
          quantity: '1',
          occurredAt: '2024-03-01T10:00:00Z',
          transferGroupId: 'g',
        }),
        sell({ holdingId: 'B', feeQuantity: '-2', feeTokenId: USD }),
      ]),
      FUTURE,
      USD,
      HELD_TOKENS,
      undefined,
      new Map(),
      undefined,
      method
    );
    const single = await walk(
      [buy({ feeQuantity: '-1', feeTokenId: USD }), sell({ feeQuantity: '-2', feeTokenId: USD })],
      method
    );
    // The lot carried its fee-inclusive cost across the move, and the sale on
    // the far side paid its own fee.
    expect(component.get('B')?.realizedPnl.toString()).toBe('47');
    expect(component.get('B')?.realizedPnl.toString()).toBe(single.realizedPnl.toString());
    expect(component.get('A')?.realizedPnl.toString()).toBe('0');
  });
});

describe('what a fee is worth', () => {
  test('a fee in the held token is valued at the trade’s own execution rate', async () => {
    const calls: ConvertCall[] = [];
    const r = await walk(
      [buy({ feeQuantity: '-0.01', feeTokenId: BTC })],
      'fifo',
      makeService(calls)
    );
    // 0.01 BTC at the 100 USD the trade executed at — not the stub's 110 spot.
    expect(r.costBasis.toString()).toBe('101');
    expect(calls).toHaveLength(0);
  });

  test('a fee in the counter asset converts through the price graph', async () => {
    const r = await walk(
      [
        buy(),
        sell({ priceNative: '75', priceNativeTokenId: ETH, feeQuantity: '-5', feeTokenId: ETH }),
      ],
      'fifo'
    );
    // Proceeds 75 ETH x 2 = 150, less 5 ETH x 2 = 10, against 100 of cost.
    expect(r.realizedPnl.toString()).toBe('40');
  });

  test('a third-token fee is valued at the trade’s instant from the price graph', async () => {
    const calls: ConvertCall[] = [];
    const r = await walk(
      [buy({ feeQuantity: '-0.01', feeTokenId: BNB })],
      'fifo',
      makeService(calls)
    );
    expect(r.costBasis.toString()).toBe('103');
    expect(calls).toEqual([{ from: BNB, at: new Date('2024-01-01T10:00:00Z') }]);
  });

  test('paying a fee in a third token is NOT treated as a disposal of that token', async () => {
    // Whether it should be is mgrin's to rule on (SC-1142). Until then the
    // fee is valued and the BNB holding's lots are left exactly where they are.
    const svc = makeService();
    const bnbBuy = tx({
      holdingId: 'C',
      kind: 'buy',
      quantity: '1',
      occurredAt: '2023-12-01T10:00:00Z',
      priceNative: '250',
    });
    const out = await svc.walkComponent(
      undefined,
      ['A', 'C'],
      byHolding([bnbBuy, buy({ feeQuantity: '-0.01', feeTokenId: BNB })]),
      FUTURE,
      USD,
      HELD_TOKENS
    );
    expect(out.get('C')?.openQty.toString()).toBe('1');
    expect(out.get('C')?.costBasis.toString()).toBe('250');
    expect(out.get('C')?.realizedPnl.toString()).toBe('0');
    expect(out.get('A')?.costBasis.toString()).toBe('103');
  });

  test('the sign of the stored fee does not matter', async () => {
    const negative = await walk([buy({ feeQuantity: '-1', feeTokenId: USD })]);
    const positive = await walk([buy({ feeQuantity: '1', feeTokenId: USD })]);
    expect(negative.costBasis.toString()).toBe('101');
    expect(positive.costBasis.toString()).toBe(negative.costBasis.toString());
  });

  test('a fee nothing can value books nothing and grades the basis partial', async () => {
    const r = await walk([buy({ feeQuantity: '-1', feeTokenId: OBSCURE })]);
    expect(r.costBasis.toString()).toBe('100');
    expect(r.basisQuality).toBe('partial');
  });

  test('a fee stored as unreadable text does not stop the walk, and says so', async () => {
    const r = await walk([buy({ feeQuantity: 'about a dollar', feeTokenId: USD })]);
    expect(r.costBasis.toString()).toBe('100');
    expect(r.basisQuality).toBe('partial');
  });

  test('a fee whose token was deleted is a fee nothing can value', async () => {
    const r = await walk([buy({ feeQuantity: '-1' })]);
    expect(r.costBasis.toString()).toBe('100');
    expect(r.basisQuality).toBe('partial');
  });
});

describe('which outflows a fee reaches', () => {
  test('a split withdrawal deducts the fee from its realized share only, pro rata', async () => {
    const r = await walk([
      buy({ quantity: '4' }),
      tx({
        holdingId: 'A',
        kind: 'withdraw',
        quantity: '-4',
        occurredAt: '2024-06-01T10:00:00Z',
        priceNative: '150',
        feeQuantity: '-4',
        feeTokenId: USD,
        transferReview: TRANSFER_REVIEW_SPLIT,
        transferReviewSplit: [
          { decision: 'left_control', quantity: '3' },
          { decision: 'untracked', quantity: '1' },
        ],
      }),
    ]);
    // 3 x 150 = 450 proceeds, less 3/4 of the 4 fee, against 300 of cost.
    expect(r.realizedPnl.toString()).toBe('147');
  });

  test('an outflow that realizes nothing is not moved by its fee', async () => {
    const unanswered = (feeQuantity?: string) =>
      walk([
        buy({ quantity: '2' }),
        tx({
          holdingId: 'A',
          kind: 'withdraw',
          quantity: '-1',
          occurredAt: '2024-06-01T10:00:00Z',
          ...(feeQuantity ? { feeQuantity, feeTokenId: USD } : {}),
        }),
      ]);
    const without = await unanswered();
    const withFee = await unanswered('-5');
    expect(withFee.realizedPnl.toString()).toBe(without.realizedPnl.toString());
    expect(withFee.costBasis.toString()).toBe(without.costBasis.toString());
    expect(withFee.basisQuality).toBe(without.basisQuality);
  });

  test('Section 104 same-day matching carries the acquisition fee into the matched cost', async () => {
    const r = await walk(
      [
        buy({ quantity: '10', feeQuantity: '-10', feeTokenId: USD }),
        buy({
          quantity: '10',
          occurredAt: '2024-06-01T09:00:00Z',
          priceNative: '120',
          feeQuantity: '-20',
          feeTokenId: USD,
        }),
        sell({ quantity: '-5' }),
      ],
      'uk_section_104'
    );
    // Same day: 5 of the 10 bought that morning, at 120 each plus half of
    // its 20 fee — 610 of cost against 750 of proceeds.
    expect(r.realizedPnl.toString()).toBe('140');
  });
});
