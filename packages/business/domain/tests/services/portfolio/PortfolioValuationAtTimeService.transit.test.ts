import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { PnLAtTimeService } from '../../../src/services/portfolio/PnLAtTimeService';
import { PortfolioValuationAtTimeService } from '../../../src/services/portfolio/PortfolioValuationAtTimeService';
import { withTestDb } from '../../../test/helpers/db';
import { makeAccount, makeHolding, seedReading } from '../../../test/helpers/factories-extra';
import { absorb, ago, travelling } from '../../../test/helpers/transit';

/**
 * History and P&L across a transfer in transit (SC-1675). The person owns
 * 3000 on every day after the outflow. A provider reading at day -3 holds the
 * destination at 1000, so from then the 500 is in neither balance.
 */

const valuation = () => Container.get(PortfolioValuationAtTimeService);
const pnl = () => Container.get(PnLAtTimeService);

describe('historical value counts money in transit (SC-1675)', () => {
  test('after the reading that does not hold it, the day still reads 3000, 500 of it in transit', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      await absorb(tx, t);
      const day = await valuation().getPortfolioValue(t.userId, ago(2), undefined, { tx });
      expect(day.totalValueInBase.toFixed()).toBe('3000');
      expect(day.inTransit).toHaveLength(1);
      expect(day.inTransit?.[0]?.quantity.toFixed()).toBe('500');
      expect(day.inTransit?.[0]?.valueInBase?.toFixed()).toBe('500');
    });
  });

  test('CONTROL: before that reading the destination holds it, and nothing is in transit', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      await absorb(tx, t);
      const day = await valuation().getPortfolioValue(t.userId, ago(4), undefined, { tx });
      expect(day.totalValueInBase.toFixed()).toBe('3000');
      expect(day.inTransit ?? []).toEqual([]);
    });
  });

  test('an account scope carries no transit', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      await absorb(tx, t);
      const day = await valuation().getPortfolioValue(t.userId, ago(2), undefined, {
        tx,
        scope: { kind: 'account', id: t.destination.accountId },
      });
      expect(day.inTransit ?? []).toEqual([]);
      expect(day.totalValueInBase.toFixed()).toBe('1000');
    });
  });
});

describe('P&L across a transfer in transit (SC-1675)', () => {
  test('the money in transit is in the value and is neither a gain nor a loss', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      await absorb(tx, t);
      const before = await pnl().getPnL(t.userId, ago(4), t.baseId, { tx });
      const during = await pnl().getPnL(t.userId, ago(2), t.baseId, { tx });
      expect(during.totalValueInBase.toFixed()).toBe('3000');
      expect(during.totalUnrealizedPnl.toFixed()).toBe(before.totalUnrealizedPnl.toFixed());
      expect(during.totalPnl.toFixed()).toBe(before.totalPnl.toFixed());
      // Carried at its value as its cost, so the day's cost basis does not dip either.
      expect(during.totalCostBasis.toFixed()).toBe(before.totalCostBasis.toFixed());
    });
  });
});

describe('P&L with a loan beside a transfer in transit (SC-1664 × SC-1675)', () => {
  // The loan leaves P&L once as debtValue and the money travelling is carried
  // at its value as its cost (#24145, confirmed #24146). Every figure here is
  // the base currency at par, so neither is a gain or a loss.
  test('a loan and money in transit leave unrealized at 0, before and during', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      await absorb(tx, t);
      const [card] = await tx
        .select({ id: schema.accountTypes.id })
        .from(schema.accountTypes)
        .where(eq(schema.accountTypes.code, 'credit_card'));
      const cardAccount = await makeAccount(tx, {
        userId: t.userId,
        institutionId: t.sourceAccount.institutionId,
        typeId: card!.id,
      });
      const loan = await makeHolding(tx, {
        userId: t.userId,
        accountId: cardAccount.id,
        tokenId: t.baseId,
        source: 'manual',
        kind: 'snapshot',
      });
      await seedReading(tx, {
        userId: t.userId,
        holdingId: loan.id,
        balance: '-4000',
        at: ago(10),
      });

      const before = await pnl().getPnL(t.userId, ago(4), t.baseId, { tx });
      const during = await pnl().getPnL(t.userId, ago(2), t.baseId, { tx });
      expect(before.totalValueInBase.toFixed()).toBe('-1000');
      expect(during.totalValueInBase.toFixed()).toBe('-1000');
      expect(before.totalUnrealizedPnl.toFixed()).toBe('0');
      expect(during.totalUnrealizedPnl.toFixed()).toBe('0');
      expect(during.totalCostBasis.toFixed()).toBe(before.totalCostBasis.toFixed());
      const loanRow = during.perHolding.find((p) => p.holdingId === loan.id);
      expect(loanRow?.debt).toBe(true);
      expect(loanRow?.costBasis.toFixed()).toBe('0');
    });
  });
});
