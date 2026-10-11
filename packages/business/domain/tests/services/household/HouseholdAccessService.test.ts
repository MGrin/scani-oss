import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { HouseholdAccessService } from '../../../src/services/household/HouseholdAccessService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeToken } from '../../../test/helpers/factories-extra';

const access = new HouseholdAccessService();

async function household(tx: DatabaseTransaction, admin: string, members: string[] = []) {
  const usd = await makeToken(tx);
  const [row] = await tx
    .insert(schema.households)
    .values({ name: 'Home', baseCurrencyId: usd.id, createdBy: admin })
    .returning();
  const householdId = row?.id ?? '';
  await tx.insert(schema.householdMembers).values({ householdId, userId: admin, role: 'admin' });
  for (const userId of members) {
    await tx.insert(schema.householdMembers).values({ householdId, userId, role: 'member' });
  }
  return { householdId, baseCurrencyId: usd.id };
}

async function share(
  tx: DatabaseTransaction,
  householdId: string,
  accountId: string,
  owner: string
) {
  await tx.insert(schema.accountShares).values({ accountId, householdId, sharedBy: owner });
}

describe('HouseholdAccessService (SC-1647)', () => {
  test('a user with no household sees no household account and has no membership', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      expect(await access.visibleAccounts(user.id, tx)).toEqual([]);
      expect(await access.membershipOf(user.id, tx)).toBeNull();
    });
  });

  test('both members see every shared account, their own included, and never an unshared one', async () => {
    await withTestDb(async (tx) => {
      const alice = await makeUser(tx, { name: 'Alice' });
      const bob = await makeUser(tx, { name: 'Bob' });
      const institution = await makeInstitution(tx);
      const { householdId } = await household(tx, alice.id, [bob.id]);
      const aliceShared = await makeAccount(tx, {
        userId: alice.id,
        institutionId: institution.id,
        name: 'A1',
      });
      await makeAccount(tx, { userId: alice.id, institutionId: institution.id, name: 'A-private' });
      const bobShared = await makeAccount(tx, {
        userId: bob.id,
        institutionId: institution.id,
        name: 'B1',
      });
      await share(tx, householdId, aliceShared.id, alice.id);
      await share(tx, householdId, bobShared.id, bob.id);

      const seenByBob = await access.visibleAccounts(bob.id, tx);
      expect(seenByBob).toEqual([
        { accountId: aliceShared.id, ownerId: alice.id, ownerName: 'Alice', ownedByViewer: false },
        { accountId: bobShared.id, ownerId: bob.id, ownerName: 'Bob', ownedByViewer: true },
      ]);
      const seenByAlice = await access.visibleAccounts(alice.id, tx);
      expect(seenByAlice.map((row) => [row.accountId, row.ownedByViewer])).toEqual([
        [aliceShared.id, true],
        [bobShared.id, false],
      ]);
    });
  });

  test('a user in another household sees none of this household’s accounts', async () => {
    await withTestDb(async (tx) => {
      const alice = await makeUser(tx);
      const carol = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const { householdId } = await household(tx, alice.id);
      await household(tx, carol.id);
      const shared = await makeAccount(tx, { userId: alice.id, institutionId: institution.id });
      await share(tx, householdId, shared.id, alice.id);

      expect(await access.visibleAccounts(carol.id, tx)).toEqual([]);
    });
  });

  test('a share whose owner has left the household reaches nobody', async () => {
    await withTestDb(async (tx) => {
      const alice = await makeUser(tx);
      const bob = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const { householdId } = await household(tx, alice.id, [bob.id]);
      const bobShared = await makeAccount(tx, { userId: bob.id, institutionId: institution.id });
      await share(tx, householdId, bobShared.id, bob.id);
      await tx.delete(schema.householdMembers).where(eq(schema.householdMembers.userId, bob.id));

      expect(await access.visibleAccounts(alice.id, tx)).toEqual([]);
    });
  });

  test('membershipOf names the role and the household currency', async () => {
    await withTestDb(async (tx) => {
      const alice = await makeUser(tx);
      const bob = await makeUser(tx);
      const { householdId, baseCurrencyId } = await household(tx, alice.id, [bob.id]);

      expect(await access.membershipOf(alice.id, tx)).toEqual({
        householdId,
        name: 'Home',
        role: 'admin',
        baseCurrencyId,
      });
      expect((await access.membershipOf(bob.id, tx))?.role).toBe('member');
    });
  });

  test('an owner with an empty name is labelled by email', async () => {
    await withTestDb(async (tx) => {
      const alice = await makeUser(tx, { name: '', email: 'alice@example.com' });
      const institution = await makeInstitution(tx);
      const { householdId } = await household(tx, alice.id);
      const shared = await makeAccount(tx, { userId: alice.id, institutionId: institution.id });
      await share(tx, householdId, shared.id, alice.id);

      const [row] = await access.visibleAccounts(alice.id, tx);
      expect(row?.ownerName).toBe('alice@example.com');
    });
  });
});
