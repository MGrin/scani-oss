import { describe, expect, spyOn, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { Container } from 'typedi';
import { PortfolioValueDailyRepository } from '../../../src/repositories/PortfolioValueDailyRepository';
import { HouseholdViewService } from '../../../src/services/household/HouseholdViewService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeToken } from '../../../test/helpers/factories-extra';

const view = new HouseholdViewService();
const FROM = new Date('2026-08-30T00:00:00.000Z');
const TO = new Date('2026-09-03T00:00:00.000Z');

async function world(tx: DatabaseTransaction) {
  const usd = await makeToken(tx);
  const gbp = await makeToken(tx);
  // One GBP→USD rate, stamped on 1 September: nothing converts 31 August.
  await tx.insert(schema.tokenPrices).values({
    tokenId: gbp.id,
    baseTokenId: usd.id,
    price: '1.25',
    timestamp: new Date('2026-09-01T12:00:00.000Z'),
    source: 'test',
    granularity: 'intraday',
  });
  const institution = await makeInstitution(tx);
  const member = (name: string, baseCurrencyId: string) => makeUser(tx, { name, baseCurrencyId });
  const account = (userId: string, name: string) =>
    makeAccount(tx, { userId, institutionId: institution.id, name });
  const row = (
    userId: string,
    baseCurrencyId: string,
    accountId: string,
    date: string,
    value: string
  ) =>
    tx.insert(schema.portfolioValueDaily).values({
      userId,
      scopeKind: 'account',
      scopeId: accountId,
      snapshotDate: date,
      baseCurrencyId,
      totalValue: value,
      coverageQuality: 'full',
      holdingsWithKnownValue: 1,
      holdingsTotal: 1,
    });
  const household = async (baseCurrencyId: string, admin: string, members: string[]) => {
    const [created] = await tx
      .insert(schema.households)
      .values({ name: 'Home', baseCurrencyId, createdBy: admin })
      .returning();
    const householdId = created?.id ?? '';
    await tx.insert(schema.householdMembers).values({ householdId, userId: admin, role: 'admin' });
    for (const userId of members) {
      await tx.insert(schema.householdMembers).values({ householdId, userId, role: 'member' });
    }
    return householdId;
  };
  const share = (householdId: string, accountId: string, owner: string) =>
    tx.insert(schema.accountShares).values({ accountId, householdId, sharedBy: owner });
  return { usd, gbp, member, account, row, household, share };
}

describe('HouseholdViewService.history (SC-1647)', () => {
  test('owners in the household currency sum day by day, exactly as stored', async () => {
    await withTestDb(async (tx) => {
      const { usd, member, account, row, household, share } = await world(tx);
      const alice = await member('Alice', usd.id);
      const dan = await member('Dan', usd.id);
      const householdId = await household(usd.id, alice.id, [dan.id]);
      const a1 = await account(alice.id, 'A1');
      const d1 = await account(dan.id, 'D1');
      await share(householdId, a1.id, alice.id);
      await share(householdId, d1.id, dan.id);
      await row(alice.id, usd.id, a1.id, '2026-09-01', '100');
      await row(alice.id, usd.id, a1.id, '2026-09-02', '110');
      await row(dan.id, usd.id, d1.id, '2026-09-01', '40');

      const history = await view.history(alice.id, FROM, TO, tx);
      expect(history.baseCurrencyId).toBe(usd.id);
      expect(history.series).toEqual([
        { date: '2026-09-01', value: '140' },
        { date: '2026-09-02', value: '110' },
      ]);
      expect(history.unmeasuredDates).toEqual([]);
    });
  });

  test('another currency converts at that day’s rate, a day with no rate is unmeasured, and unshared rows are never read', async () => {
    await withTestDb(async (tx) => {
      const { usd, gbp, member, account, row, household, share } = await world(tx);
      const alice = await member('Alice', usd.id);
      const bob = await member('Bob', gbp.id);
      const householdId = await household(usd.id, alice.id, [bob.id]);
      const a1 = await account(alice.id, 'A1');
      const unshared = await account(alice.id, 'Private');
      const b1 = await account(bob.id, 'B1');
      await share(householdId, a1.id, alice.id);
      await share(householdId, b1.id, bob.id);
      await row(alice.id, usd.id, a1.id, '2026-08-31', '100');
      await row(alice.id, usd.id, a1.id, '2026-09-01', '100');
      await row(alice.id, usd.id, unshared.id, '2026-09-01', '999');
      await row(bob.id, gbp.id, b1.id, '2026-08-31', '80');
      await row(bob.id, gbp.id, b1.id, '2026-09-01', '100');

      const reads = spyOn(Container.get(PortfolioValueDailyRepository), 'findRange');
      try {
        const history = await view.history(bob.id, FROM, TO, tx);
        // Bob's 100 GBP at 1.25 is 125 USD beside Alice's 100.
        expect(history.series).toEqual([{ date: '2026-09-01', value: '225' }]);
        // Review Focus 5: a day with a rate missing is named, never summed short.
        expect(history.unmeasuredDates).toEqual(['2026-08-31']);
        const scopes = reads.mock.calls.map((call) => call[5]?.id);
        expect(scopes.sort()).toEqual([a1.id, b1.id].sort());
      } finally {
        reads.mockRestore();
      }
    });
  });
});
