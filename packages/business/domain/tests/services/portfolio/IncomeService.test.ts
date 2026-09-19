process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import { Decimal } from '@scani/shared';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { IncomeService } from '../../../src/services/portfolio/IncomeService';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

restoreContainerAfterAll();

/**
 * `IncomeService` — SC-90's income section, per mgrin's 2026-09-11 ruling:
 * income is interest and rewards, totalled; airdrops are listed and never
 * totalled, because their treatment varies by country and their value at
 * receipt is often unknown.
 *
 * Values come from `valueTransactionInBase`, the one valuation cost basis and
 * returns already share, so an income figure and the cost basis of the lot the
 * same receipt opened cannot disagree.
 */

const USD = 'token-USD';
const ETH = 'token-ETH';

let seq = 0;
function tx(p: {
  holdingId: string;
  kind: string;
  quantity: string;
  occurredAt: string;
  priceNative?: string;
}): HoldingTransaction {
  seq += 1;
  return {
    id: `tx-${seq}`,
    userId: 'u',
    holdingId: p.holdingId,
    tokenId: ETH,
    kind: p.kind,
    quantity: p.quantity,
    priceNative: p.priceNative ?? null,
    priceNativeTokenId: p.priceNative ? USD : null,
    occurredAt: new Date(p.occurredAt),
  } as HoldingTransaction;
}

/** `(from, to]`, as the real repository answers. */
function makeService(opts: {
  holdings: Array<{ id: string; tokenId: string }>;
  txs: HoldingTransaction[];
  /** ETH→USD at any date, or null for "no route". */
  ethUsd?: string | null;
}): IncomeService {
  Container.set(HoldingRepository, {
    findIdsForUser: async () => opts.holdings.map((h) => h.id),
    findByIds: async (ids: string[]) => opts.holdings.filter((h) => ids.includes(h.id)),
  } as unknown as HoldingRepository);
  Container.set(HoldingTransactionRepository, {
    findForHoldingsInRange: async (ids: readonly string[], from: Date, to: Date) =>
      opts.txs.filter(
        (t) =>
          ids.includes(t.holdingId) &&
          t.occurredAt.getTime() > from.getTime() &&
          t.occurredAt.getTime() <= to.getTime()
      ),
  } as unknown as HoldingTransactionRepository);
  Container.set(PriceGraphService, {
    convert: async (amount: Decimal) =>
      opts.ethUsd === null || opts.ethUsd === undefined
        ? null
        : { amount: amount.mul(opts.ethUsd), stale: false },
  } as unknown as PriceGraphService);
  const service = new IncomeService();
  Container.set(IncomeService, service);
  return service;
}

const Y2024 = { from: new Date('2024-01-01T00:00:00Z'), to: new Date('2025-01-01T00:00:00Z') };

describe('IncomeService.forPeriod — interest and rewards are totalled', () => {
  test('each kind is valued at receipt and summed on its own', async () => {
    const service = makeService({
      holdings: [{ id: 'h', tokenId: ETH }],
      ethUsd: '2000',
      txs: [
        tx({ holdingId: 'h', kind: 'interest', quantity: '0.5', occurredAt: '2024-03-01' }),
        tx({ holdingId: 'h', kind: 'reward', quantity: '0.25', occurredAt: '2024-04-01' }),
        tx({
          holdingId: 'h',
          kind: 'reward',
          quantity: '1',
          occurredAt: '2024-05-01',
          priceNative: '10',
        }),
      ],
    });
    const r = await service.forPeriod('u', USD, Y2024);
    expect(r.totals.interest.toString()).toBe('1000');
    // 0.25 × 2000 from the price graph, plus 1 × 10 recorded by the importer.
    expect(r.totals.reward.toString()).toBe('510');
    expect(r.rows).toHaveLength(3);
  });

  test('buys, sells and deposits in the same window are not income', async () => {
    const service = makeService({
      holdings: [{ id: 'h', tokenId: ETH }],
      ethUsd: '2000',
      txs: [
        tx({ holdingId: 'h', kind: 'buy', quantity: '1', occurredAt: '2024-03-01' }),
        tx({ holdingId: 'h', kind: 'deposit', quantity: '1', occurredAt: '2024-03-02' }),
        tx({ holdingId: 'h', kind: 'sell', quantity: '-1', occurredAt: '2024-03-03' }),
        tx({ holdingId: 'h', kind: 'interest', quantity: '0.1', occurredAt: '2024-03-04' }),
      ],
    });
    const r = await service.forPeriod('u', USD, Y2024);
    // CONTROL: the one income row is found, so the three zeros are exclusions.
    expect(r.rows.map((row) => row.kind)).toEqual(['interest']);
  });
});

describe('IncomeService.forPeriod — airdrops are listed, never totalled', () => {
  test('an airdrop is a row with its value, and there is no airdrop total', async () => {
    const service = makeService({
      holdings: [{ id: 'h', tokenId: ETH }],
      ethUsd: '2000',
      txs: [tx({ holdingId: 'h', kind: 'airdrop', quantity: '3', occurredAt: '2024-06-01' })],
    });
    const r = await service.forPeriod('u', USD, Y2024);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.value?.toString()).toBe('6000');
    expect(Object.keys(r.totals).sort()).toEqual(['interest', 'reward']);
  });
});

describe('IncomeService.forPeriod — what could not be valued is counted, not zeroed', () => {
  test('no price route leaves the row unvalued and out of the total', async () => {
    const service = makeService({
      holdings: [{ id: 'h', tokenId: ETH }],
      ethUsd: null,
      txs: [
        tx({ holdingId: 'h', kind: 'interest', quantity: '0.5', occurredAt: '2024-03-01' }),
        tx({
          holdingId: 'h',
          kind: 'interest',
          quantity: '1',
          occurredAt: '2024-03-02',
          priceNative: '7',
        }),
      ],
    });
    const r = await service.forPeriod('u', USD, Y2024);
    expect(r.rows[0]?.value).toBeNull();
    expect(r.totals.interest.toString()).toBe('7');
    expect(r.unvalued).toEqual({ interest: 1, reward: 0, airdrop: 0 });
  });
});

describe('IncomeService.forPeriod — the window is [from, to)', () => {
  test('a receipt at `from` is in, one at `to` is out', async () => {
    const service = makeService({
      holdings: [{ id: 'h', tokenId: ETH }],
      ethUsd: '1',
      txs: [
        tx({ holdingId: 'h', kind: 'interest', quantity: '1', occurredAt: '2024-01-01T00:00:00Z' }),
        tx({ holdingId: 'h', kind: 'interest', quantity: '2', occurredAt: '2025-01-01T00:00:00Z' }),
      ],
    });
    const r = await service.forPeriod('u', USD, Y2024);
    // The repository answers (from, to]; the service must shift that to the
    // tax window's [from, to), or both boundary rows land in the wrong year.
    expect(r.rows.map((row) => row.quantity.toString())).toEqual(['1']);
  });
});

describe('IncomeService.forPeriod — a user with no holdings', () => {
  test('reports zeroes without querying transactions', async () => {
    const service = makeService({ holdings: [], txs: [] });
    Container.set(HoldingTransactionRepository, {
      findForHoldingsInRange: async () => {
        throw new Error('should not be called with no holdings');
      },
    } as unknown as HoldingTransactionRepository);
    const fresh = new IncomeService();
    const r = await fresh.forPeriod('u', USD, Y2024);
    expect(r.rows).toEqual([]);
    expect(r.totals.interest.toString()).toBe('0');
    expect(service).toBeDefined();
  });
});

describe('IncomeService.forPeriod — the value is the shared one', () => {
  test('a receipt in the base currency is its quantity', async () => {
    const service = makeService({
      holdings: [{ id: 'usd', tokenId: USD }],
      txs: [tx({ holdingId: 'usd', kind: 'interest', quantity: '12.5', occurredAt: '2024-02-01' })],
    });
    const r = await service.forPeriod('u', USD, Y2024);
    expect(r.totals.interest.equals(new Decimal('12.5'))).toBe(true);
  });
});
