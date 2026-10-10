import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { PortfolioValuationService } from '../../../src/services/portfolio/PortfolioValuationService';
import { withTestDb } from '../../../test/helpers/db';
import { absorb, travelling } from '../../../test/helpers/transit';

/**
 * 500 left a 2000 account for a provider-fed account holding 1000 (SC-1675).
 * The person owns 3000 throughout: live net worth must say so while the
 * money travels, not 2500 until the destination reports it.
 */

const value = (userId: string, tx: DatabaseTransaction, accountId?: string) =>
  Container.get(PortfolioValuationService).computePortfolioValueAt(userId, {
    at: new Date(),
    tx,
    ...(accountId === undefined ? {} : { accountId }),
  });

describe('live net worth counts money in transit (SC-1675)', () => {
  test('answered, no reading since: the destination holds it, and nothing is in transit', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      const result = await value(t.userId, tx);
      expect(result.totalValue).toBe('3000');
      expect(result.inTransit ?? []).toEqual([]);
    });
  });

  test('a provider reading without it: the 500 is in transit, and the total stays 3000', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      await absorb(tx, t);
      const result = await value(t.userId, tx);
      const destination = result.holdings.find((h) => h.holdingId === t.destination.id);
      expect(destination?.balance).toBe('1000');
      expect(result.inTransit).toHaveLength(1);
      expect(result.inTransit?.[0]).toMatchObject({
        outflowId: t.outflowId,
        destinationHoldingId: t.destination.id,
        quantity: '500',
        value: '500',
      });
      expect(result.totalValue).toBe('3000');
    });
  });

  test('an account on its own carries no transit: the money is in neither account', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      await absorb(tx, t);
      const result = await value(t.userId, tx, t.destination.accountId);
      expect(result.inTransit ?? []).toEqual([]);
      expect(result.totalValue).toBe('1000');
    });
  });

  test('a destination hidden by its owner takes its transit out of the total too', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      await absorb(tx, t);
      await tx
        .update(schema.holdings)
        .set({ isHidden: true, hiddenBy: 'user' })
        .where(eq(schema.holdings.id, t.destination.id));
      const result = await value(t.userId, tx);
      expect(result.inTransit ?? []).toEqual([]);
      expect(result.totalValue).toBe('1500');
    });
  });
});
