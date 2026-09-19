process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';
import {
  ExternalFlowService,
  flowValuationInstant,
} from '../../../src/services/returns/ExternalFlowService';
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
      findByIds: async () => [{ id: 'h-eur', tokenId: 'token-EUR' }],
    } as unknown as HoldingRepository);
    Container.set(PriceGraphService, {
      buildPriceLookup: async () => ({ covers: () => false }),
      convert: async (amount: Decimal, _from: string, _to: string, at: Date) => {
        asked.push(at);
        return { amount: new Decimal(amount), stale: false };
      },
    } as unknown as PriceGraphService);

    await new ExternalFlowService().forHoldings(
      [{ holdingId: 'h-eur', weight: new Decimal(1) }],
      'token-GBP',
      new Date('2025-04-01T00:00:00Z'),
      new Date('2025-05-01T00:00:00Z')
    );

    expect(asked.map((d) => d.toISOString())).toEqual(['2025-04-28T23:59:59.999Z']);
  });
});
