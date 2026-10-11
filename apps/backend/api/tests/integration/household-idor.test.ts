import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { HouseholdAccessService, HouseholdMembershipService } from '@scani/domain/services';
import {
  makeAccount,
  makeHolding,
  makeInstitution,
  makeInstitutionType,
  makeToken,
  makeUser,
  restoreContainerAfterAll,
} from '@scani/domain/test-helpers';
import { eq, inArray } from 'drizzle-orm';
import { makeAuthedCaller } from '../helpers/test-caller';

// SC-1647: household access is view-only by construction. A member who can
// see another member's shared account reaches it through no write path; every
// write route keeps its own owner filter. Each case asserts the refusal AND
// that the row is unchanged, since a refusal after a write would also reject.

restoreContainerAfterAll();

const db = () => getDb();
const made = {
  users: [] as string[],
  tokens: [] as string[],
  institutions: [] as string[],
  households: [] as string[],
};

let alice: typeof schema.users.$inferSelect;
let bob: typeof schema.users.$inferSelect;
let accountId = '';
let holdingId = '';

beforeAll(async () => {
  const usd = await db().transaction((tx) => makeToken(tx));
  const coin = await db().transaction((tx) => makeToken(tx));
  made.tokens.push(usd.id, coin.id);
  const type = await db().transaction((tx) => makeInstitutionType(tx, { code: 'bank' }));
  const institution = await db().transaction((tx) => makeInstitution(tx, { typeId: type.id }));
  made.institutions.push(institution.id);
  alice = await db().transaction((tx) => makeUser(tx, { name: 'alice', baseCurrencyId: usd.id }));
  bob = await db().transaction((tx) => makeUser(tx, { name: 'bob', baseCurrencyId: usd.id }));
  made.users.push(alice.id, bob.id);

  const account = await db().transaction((tx) =>
    makeAccount(tx, { userId: alice.id, institutionId: institution.id, name: 'Joint' })
  );
  accountId = account.id;
  const holding = await db().transaction((tx) =>
    makeHolding(tx, { userId: alice.id, accountId, tokenId: coin.id, balance: '10' })
  );
  holdingId = holding.id;

  const memberships = new HouseholdMembershipService();
  const household = await memberships.create(alice.id, 'Home');
  made.households.push(household.id);
  const invite = await memberships.invite(alice.id, bob.email);
  await memberships.accept(bob.id, bob.email, invite.token);
  await memberships.share(alice.id, accountId);
});

afterAll(async () => {
  await db().delete(schema.households).where(inArray(schema.households.id, made.households));
  await db().delete(schema.users).where(inArray(schema.users.id, made.users));
  await db().delete(schema.institutions).where(inArray(schema.institutions.id, made.institutions));
  await db().delete(schema.tokens).where(inArray(schema.tokens.id, made.tokens));
});

async function account() {
  const [row] = await db().select().from(schema.accounts).where(eq(schema.accounts.id, accountId));
  return row;
}

async function holding() {
  const [row] = await db().select().from(schema.holdings).where(eq(schema.holdings.id, holdingId));
  return row;
}

describe('a household member cannot write a shared account (SC-1647)', () => {
  test('the control: bob can see alice’s shared account', async () => {
    const seen = await new HouseholdAccessService().visibleAccounts(bob.id);
    expect(seen.map((v) => [v.accountId, v.ownerId])).toEqual([[accountId, alice.id]]);
  });

  test('accounts.update is refused and the name is unchanged', async () => {
    const asBob = makeAuthedCaller(bob);
    await expect(
      asBob.accounts.update({ id: accountId, data: { name: 'taken' } })
    ).rejects.toThrow();
    expect((await account())?.name).toBe('Joint');
  });

  test('accounts.delete is refused and the account remains', async () => {
    const asBob = makeAuthedCaller(bob);
    await expect(asBob.accounts.delete({ id: accountId })).rejects.toThrow();
    expect(await account()).toBeDefined();
  });

  test('holdings.update is refused and the balance is unchanged', async () => {
    const asBob = makeAuthedCaller(bob);
    await expect(
      asBob.holdings.update({ id: holdingId, data: { balance: '99' } })
    ).rejects.toThrow();
    expect((await holding())?.balance).toBe('10');
  });

  test('holdings.delete is refused and the holding remains', async () => {
    const asBob = makeAuthedCaller(bob);
    await expect(asBob.holdings.delete({ id: holdingId })).rejects.toThrow();
    expect(await holding()).toBeDefined();
  });
});
