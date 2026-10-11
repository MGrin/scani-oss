import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { HouseholdViewService } from '../../../src/services/household/HouseholdViewService';
import { PortfolioValuationService } from '../../../src/services/portfolio/PortfolioValuationService';
import { withTestDb } from '../../../test/helpers/db';
import { absorb, ago, travelling } from '../../../test/helpers/transit';

/**
 * Money in transit (SC-1675) counts with the account it travels to, so a
 * transfer between two shared accounts never dips the household figure while
 * the owner's own Home stays flat (SC-1647).
 */
const view = new HouseholdViewService();

async function household(tx: DatabaseTransaction, baseCurrencyId: string, admin: string) {
  const [row] = await tx
    .insert(schema.households)
    .values({ name: 'Home', baseCurrencyId, createdBy: admin })
    .returning();
  const householdId = row?.id ?? '';
  await tx.insert(schema.householdMembers).values({ householdId, userId: admin, role: 'admin' });
  return householdId;
}

const share = (tx: DatabaseTransaction, householdId: string, accountId: string, owner: string) =>
  tx.insert(schema.accountShares).values({ accountId, householdId, sharedBy: owner });

describe('HouseholdViewService and money in transit (SC-1647, SC-1675)', () => {
  test('both accounts shared: the household total equals the owner’s own, transit included', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      await absorb(tx, t);
      const householdId = await household(tx, t.baseId, t.userId);
      await share(tx, householdId, t.sourceAccount.id, t.userId);
      await share(tx, householdId, t.destinationAccount.id, t.userId);

      const own = await new PortfolioValuationService().computePortfolioValueAt(t.userId, {
        at: new Date(),
        tx,
      });
      const result = await view.now(t.userId, 'token_type', { tx });

      expect(own.totalValue).toBe('3000');
      expect(result.total).toBe('3000');
    });
  });

  test('only the destination shared: the travelling money counts with it', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      await absorb(tx, t);
      const householdId = await household(tx, t.baseId, t.userId);
      await share(tx, householdId, t.destinationAccount.id, t.userId);

      const result = await view.now(t.userId, 'token_type', { tx });

      expect(result.total).toBe('1500');
      // The account's own figure is what the account holds; the money is in neither.
      expect(result.accounts.map((a) => a.value)).toEqual(['1000']);
    });
  });

  test('only the source shared: the travelling money is not the household’s', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      await absorb(tx, t);
      const householdId = await household(tx, t.baseId, t.userId);
      await share(tx, householdId, t.sourceAccount.id, t.userId);

      const result = await view.now(t.userId, 'token_type', { tx });

      expect(result.total).toBe('1500');
    });
  });

  test('history adds a stored transit row only when its destination account is shared', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      const day = ago(2).toISOString().slice(0, 10);
      const stored = (scopeKind: 'account' | 'transit', scopeId: string, value: string) =>
        tx.insert(schema.portfolioValueDaily).values({
          userId: t.userId,
          scopeKind,
          scopeId,
          snapshotDate: day,
          baseCurrencyId: t.baseId,
          totalValue: value,
          costBasis: value,
          coverageQuality: 'full',
          holdingsWithKnownValue: 1,
          holdingsTotal: 1,
        });
      await stored('account', t.sourceAccount.id, '1500');
      await stored('account', t.destinationAccount.id, '1000');
      await stored('transit', t.destination.id, '500');
      const householdId = await household(tx, t.baseId, t.userId);
      await share(tx, householdId, t.sourceAccount.id, t.userId);

      const sourceOnly = await view.history(t.userId, ago(4), ago(1), tx);
      expect(sourceOnly.series).toEqual([{ date: day, value: '1500' }]);

      await share(tx, householdId, t.destinationAccount.id, t.userId);
      const both = await view.history(t.userId, ago(4), ago(1), tx);
      expect(both.series).toEqual([{ date: day, value: '3000' }]);
    });
  });
});
