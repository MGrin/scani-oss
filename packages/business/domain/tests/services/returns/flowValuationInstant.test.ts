process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import {
  flowValuationInstant,
  valuationInstantsOf,
  valueRowInBase,
  valueTradeFeeInBase,
} from '../../../src/lib/tx-valuation';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { PriceReader, type PriceSeries } from '../../../src/services/pricing/PriceReader';
import { DriftLedgerService } from '../../../src/services/returns/DriftLedgerService';
import { ExternalFlowService } from '../../../src/services/returns/ExternalFlowService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

/**
 * SC-1254. A flow is valued at the instant the rollup values its day's
 * balance, so the two read the same prices and their difference is not
 * booked as a return.
 */

restoreContainerAfterAll();

describe('flowValuationInstant', () => {
  const NOW = new Date('2026-09-19T12:00:00Z');

  test('a past flow is valued at the end of its UTC day, as the rollup values that day', () => {
    expect(flowValuationInstant(new Date('2025-04-28T10:28:00Z'), NOW).toISOString()).toBe(
      '2025-04-28T23:59:59.999Z'
    );
  });

  test('a flow already at the end of its day stays there', () => {
    expect(flowValuationInstant(new Date('2025-04-28T23:59:59.999Z'), NOW).toISOString()).toBe(
      '2025-04-28T23:59:59.999Z'
    );
  });

  test("today's flow is valued now, as today's balance is", () => {
    expect(flowValuationInstant(new Date('2026-09-19T08:00:00Z'), NOW)).toEqual(NOW);
  });
});

describe('ExternalFlowService values a flow at that instant', () => {
  test('a deposit in another currency is converted at the end of its day', async () => {
    const asked: Date[] = [];
    Container.set(HoldingTransactionRepository, {
      findForHoldingsInRange: async () => [
        {
          id: 'tx-1',
          userId: 'u',
          holdingId: 'h-eur',
          tokenId: 'token-EUR',
          kind: 'deposit',
          quantity: '8900',
          priceNative: '1',
          priceNativeTokenId: 'token-EUR',
          occurredAt: new Date('2025-04-28T10:28:00Z'),
          transferReview: null,
          transferReviewSplit: null,
        } as unknown as HoldingTransaction,
      ],
    } as unknown as HoldingTransactionRepository);
    Container.set(HoldingRepository, {
      findIdsIncludedInTotal: async (ids: readonly string[]) => new Set(ids),
      findByIds: async () => [{ id: 'h-eur', tokenId: 'token-EUR' }],
    } as unknown as HoldingRepository);
    Container.set(PriceReader, {
      series: async () =>
        seriesStub((_tokenId, at) => {
          asked.push(at);
          return true;
        }),
    } as unknown as PriceReader);

    Container.set(DriftLedgerService, {
      forHoldings: async () => new Map(),
    } as unknown as DriftLedgerService);
    await new ExternalFlowService().forHoldings(
      [{ holdingId: 'h-eur', weight: new Decimal(1) }],
      'token-GBP',
      new Date('2025-04-01T00:00:00Z'),
      new Date('2025-05-01T00:00:00Z')
    );

    expect(asked.map((d) => d.toISOString())).toEqual(['2025-04-28T23:59:59.999Z']);
  });
});

describe('the valuation run clock and its price asks', () => {
  const now = new Date('2026-09-19T12:00:00Z');
  const occurredAt = new Date('2026-09-19T08:00:00Z');
  const base = 'USD';
  const held = 'BTC';
  const row = (overrides: Partial<HoldingTransaction> = {}) =>
    ({
      kind: 'deposit',
      quantity: '2',
      tokenId: held,
      occurredAt,
      priceNative: null,
      priceNativeTokenId: null,
      counterTokenId: null,
      counterQuantity: null,
      feeQuantity: null,
      feeTokenId: null,
      ...overrides,
    }) as HoldingTransaction;
  const key = (ask: { tokenId: string; at: Date }) => `${ask.tokenId}@${ask.at.toISOString()}`;
  const cases: Array<{ name: string; tx: HoldingTransaction; expected: Array<[string, Date]> }> = [
    { name: 'today’s flow uses the run instant', tx: row(), expected: [[held, now]] },
    {
      name: 'a past flow uses its close',
      tx: row({ occurredAt: new Date('2026-09-18T08:00:00Z') }),
      expected: [[held, new Date('2026-09-18T23:59:59.999Z')]],
    },
    {
      name: 'execution outside base includes FX and the held fallback at the trade instant',
      tx: row({ kind: 'buy', priceNative: '3', priceNativeTokenId: 'EUR' }),
      expected: [
        ['EUR', occurredAt],
        [held, occurredAt],
      ],
    },
    {
      name: 'execution in base asks nothing',
      tx: row({ kind: 'sell', priceNative: '3', priceNativeTokenId: base }),
      expected: [],
    },
    {
      name: 'execution in base still prices a third-token fee',
      tx: row({
        kind: 'buy',
        priceNative: '3',
        priceNativeTokenId: base,
        feeQuantity: '-0.1',
        feeTokenId: 'BNB',
      }),
      expected: [['BNB', occurredAt]],
    },
    {
      name: 'non-trade execution uses close with a fallback',
      tx: row({ priceNative: '3', priceNativeTokenId: 'EUR' }),
      expected: [
        ['EUR', now],
        [held, now],
      ],
    },
    {
      name: 'swap in prices its arrival then the execution fallback at close',
      tx: row({ kind: 'swap_in', priceNative: '3', priceNativeTokenId: 'EUR' }),
      expected: [
        [held, now],
        ['EUR', now],
      ],
    },
    {
      name: 'swap out prices its counter arrival then its own fallback',
      tx: row({ kind: 'swap_out', counterTokenId: 'ETH', counterQuantity: '4' }),
      expected: [
        ['ETH', now],
        [held, now],
      ],
    },
    {
      name: 'swap out without counter falls back to the held token',
      tx: row({ kind: 'swap_out' }),
      expected: [[held, now]],
    },
    {
      name: 'own-token fee uses the own instant even on a flow',
      tx: row({ feeQuantity: '0.1', feeTokenId: held }),
      expected: [
        [held, now],
        [held, occurredAt],
      ],
    },
    {
      name: 'zero fee adds no ask',
      tx: row({
        priceNative: '3',
        priceNativeTokenId: base,
        feeQuantity: '0.00',
        feeTokenId: 'BNB',
      }),
      expected: [],
    },
  ];
  for (const { name, tx, expected } of cases) {
    test(name, async () => {
      const listed = valuationInstantsOf(tx, base, held, now).map(key);
      expect(listed).toEqual(expected.map(([tokenId, at]) => key({ tokenId, at })));
      // Both successful conversion and an absent route exercise the fallback paths.
      for (const found of [true, false]) {
        const asked: string[] = [];
        const prices = seriesStub((tokenId, at) => {
          asked.push(key({ tokenId, at }));
          return found;
        });
        valueRowInBase(prices, tx, new Decimal(2), base, held, now);
        valueTradeFeeInBase(prices, tx, base, held, now);
        for (const ask of asked) expect(listed).toContain(ask);
      }
    });
  }

  test('valueRowInBase freezes today at the supplied run instant', async () => {
    const asked: Date[] = [];
    const prices = seriesStub((_tokenId, at) => {
      asked.push(at);
      return true;
    });
    valueRowInBase(prices, row(), new Decimal(2), base, held, now);
    expect(asked).toEqual([now]);
  });
});

/** A series that answers 1 when `priced` says so, and records every ask. */
function seriesStub(priced: (tokenId: string, at: Date) => boolean): PriceSeries {
  return {
    priceAt: (tokenId, at) =>
      priced(tokenId, at)
        ? { price: new Decimal(1), readingAt: at, path: 'direct', stale: false, source: 'test' }
        : null,
    fingerprint: 'stub',
  };
}
