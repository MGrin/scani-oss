import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { HouseholdAccessService } from '../../../src/services/household/HouseholdAccessService';
import { HouseholdMembershipService } from '../../../src/services/household/HouseholdMembershipService';
import { HouseholdError } from '../../../src/services/household/household-errors';
import { DeleteAllUserDataUseCase } from '../../../src/use-cases/DeleteAllUserDataUseCase';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeToken } from '../../../test/helpers/factories-extra';

const memberships = new HouseholdMembershipService();
const access = new HouseholdAccessService();

async function person(tx: DatabaseTransaction, email: string) {
  const usd = await makeToken(tx);
  return makeUser(tx, { email, name: email.split('@')[0] ?? email, baseCurrencyId: usd.id });
}

async function join(tx: DatabaseTransaction, adminId: string, userId: string, email: string) {
  const invite = await memberships.invite(adminId, email, tx);
  await memberships.accept(userId, email, invite.token, tx);
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (err) {
    if (err instanceof HouseholdError) return err.code;
    throw err;
  }
  return 'no error';
}

async function household(tx: DatabaseTransaction) {
  const alice = await person(tx, 'alice@example.com');
  const bob = await person(tx, 'bob@example.com');
  const institution = await makeInstitution(tx);
  const home = await memberships.create(alice.id, 'Home', tx);
  await join(tx, alice.id, bob.id, 'bob@example.com');
  const aliceAccount = await makeAccount(tx, { userId: alice.id, institutionId: institution.id });
  const bobAccount = await makeAccount(tx, { userId: bob.id, institutionId: institution.id });
  return { alice, bob, home, aliceAccount, bobAccount, institution };
}

describe('HouseholdMembershipService: sharing, leaving and succession (SC-1647)', () => {
  test('only the owner shares an account, and a non-owner writes nothing', async () => {
    await withTestDb(async (tx) => {
      const { alice, bob, aliceAccount } = await household(tx);

      expect(await codeOf(memberships.share(bob.id, aliceAccount.id, tx))).toBe('not-owner');
      expect(await access.visibleAccounts(bob.id, tx)).toEqual([]);

      await memberships.share(alice.id, aliceAccount.id, tx);
      await memberships.share(alice.id, aliceAccount.id, tx);
      expect((await access.visibleAccounts(bob.id, tx)).map((a) => a.accountId)).toEqual([
        aliceAccount.id,
      ]);
    });
  });

  test('unshare removes the share row', async () => {
    await withTestDb(async (tx) => {
      const { alice, bob, aliceAccount } = await household(tx);
      await memberships.share(alice.id, aliceAccount.id, tx);
      await memberships.unshare(alice.id, aliceAccount.id, tx);

      expect(await access.visibleAccounts(bob.id, tx)).toEqual([]);
      const rows = await tx
        .select()
        .from(schema.accountShares)
        .where(eq(schema.accountShares.accountId, aliceAccount.id));
      expect(rows).toEqual([]);
    });
  });

  test('sharing without a household is refused', async () => {
    await withTestDb(async (tx) => {
      const carol = await person(tx, 'carol@example.com');
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: carol.id, institutionId: institution.id });
      expect(await codeOf(memberships.share(carol.id, account.id, tx))).toBe('no-household');
    });
  });

  test('a member who leaves takes their shares and loses everyone else’s at once', async () => {
    await withTestDb(async (tx) => {
      const { alice, bob, aliceAccount, bobAccount } = await household(tx);
      await memberships.share(alice.id, aliceAccount.id, tx);
      await memberships.share(bob.id, bobAccount.id, tx);

      await memberships.leave(bob.id, tx);

      expect((await access.visibleAccounts(alice.id, tx)).map((a) => a.accountId)).toEqual([
        aliceAccount.id,
      ]);
      expect(await access.membershipOf(bob.id, tx)).toBeNull();
      expect(await access.visibleAccounts(bob.id, tx)).toEqual([]);
      const bobShares = await tx
        .select()
        .from(schema.accountShares)
        .where(eq(schema.accountShares.accountId, bobAccount.id));
      expect(bobShares).toEqual([]);
    });
  });

  test('the admin cannot leave while others remain; alone, leaving removes the household', async () => {
    await withTestDb(async (tx) => {
      const { alice, bob, home } = await household(tx);

      expect(await codeOf(memberships.leave(alice.id, tx))).toBe('admin-must-hand-over');

      await memberships.remove(alice.id, bob.id, tx);
      await memberships.leave(alice.id, tx);
      const left = await tx
        .select()
        .from(schema.households)
        .where(eq(schema.households.id, home.id));
      expect(left).toEqual([]);
    });
  });

  test('remove is the admin’s, and only for a member of this household', async () => {
    await withTestDb(async (tx) => {
      const { alice, bob } = await household(tx);
      const carol = await person(tx, 'carol@example.com');

      expect(await codeOf(memberships.remove(bob.id, alice.id, tx))).toBe('not-admin');
      expect(await codeOf(memberships.remove(alice.id, carol.id, tx))).toBe('not-a-member');
      await memberships.remove(alice.id, bob.id, tx);
      expect(await access.membershipOf(bob.id, tx)).toBeNull();
    });
  });

  test('transferAdmin swaps the roles', async () => {
    await withTestDb(async (tx) => {
      const { alice, bob } = await household(tx);
      await memberships.transferAdmin(alice.id, bob.id, tx);

      expect((await access.membershipOf(alice.id, tx))?.role).toBe('member');
      expect((await access.membershipOf(bob.id, tx))?.role).toBe('admin');
    });
  });

  test('setCurrency is the admin’s', async () => {
    await withTestDb(async (tx) => {
      const { alice, bob } = await household(tx);
      const eur = await makeToken(tx);

      expect(await codeOf(memberships.setCurrency(bob.id, eur.id, tx))).toBe('not-admin');
      await memberships.setCurrency(alice.id, eur.id, tx);
      expect((await access.membershipOf(bob.id, tx))?.baseCurrencyId).toBe(eur.id);
    });
  });

  test('deleting the admin’s data hands the role to the member who joined first', async () => {
    await withTestDb(async (tx) => {
      const { alice, bob } = await household(tx);
      const carol = await person(tx, 'carol@example.com');
      await join(tx, alice.id, carol.id, 'carol@example.com');
      await tx
        .update(schema.householdMembers)
        .set({ joinedAt: new Date('2026-01-01T00:00:00Z') })
        .where(eq(schema.householdMembers.userId, bob.id));

      await new DeleteAllUserDataUseCase().deleteRows(tx, alice.id);

      expect((await access.membershipOf(bob.id, tx))?.role).toBe('admin');
      expect((await access.membershipOf(carol.id, tx))?.role).toBe('member');
    });
  });

  test('deleting the data of an admin alone removes the household', async () => {
    await withTestDb(async (tx) => {
      const alice = await person(tx, 'alice@example.com');
      const home = await memberships.create(alice.id, 'Home', tx);

      await new DeleteAllUserDataUseCase().deleteRows(tx, alice.id);

      const left = await tx
        .select()
        .from(schema.households)
        .where(eq(schema.households.id, home.id));
      expect(left).toEqual([]);
    });
  });
});
