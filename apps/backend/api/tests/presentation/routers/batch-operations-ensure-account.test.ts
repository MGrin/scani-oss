import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { makeAuthedCaller } from '../../helpers/test-caller';

// SC-1340: `ensureAccount` confirmed any client-sent account id without an
// owner check. SC-1341: account `metadata` was stored exactly as the client
// sent it, including keys the server later reads as trusted (`userWalletId`).

const suffix = randomUUID().slice(0, 8);
type User = typeof schema.users.$inferSelect;

let alice: User;
let mallory: User;
let institutionId: string;
let institutionTypeId: string;
let accountTypeId: string;
let currencyTypeId: string;
let currencyId: string;

async function makeUser(name: string): Promise<User> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `sc1340-${name}-${suffix}@scani.local`, name, baseCurrencyId: currencyId })
    .returning();
  if (!user) throw new Error(`user insert failed: ${name}`);
  return user;
}

async function makeAccount(userId: string): Promise<string> {
  const [account] = await db
    .insert(schema.accounts)
    .values({ userId, institutionId, name: `SC-1340 ${randomUUID()}`, typeId: accountTypeId })
    .returning();
  if (!account) throw new Error('account insert failed');
  return account.id;
}

async function accountsNamed(userId: string, name: string) {
  return db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.userId, userId), eq(schema.accounts.name, name)));
}

beforeAll(async () => {
  const [currencyType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `sc1340-cur-${suffix}`, name: 'SC-1340 currency type' })
    .returning();
  currencyTypeId = currencyType!.id;
  const [currency] = await db
    .insert(schema.tokens)
    .values({ symbol: `S${suffix}`, name: 'SC-1340 currency', typeId: currencyTypeId })
    .returning();
  currencyId = currency!.id;
  alice = await makeUser('alice');
  mallory = await makeUser('mallory');
  const [institutionType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `sc1340-${suffix}`, name: 'SC-1340 type' })
    .returning();
  institutionTypeId = institutionType!.id;
  const [institution] = await db
    .insert(schema.institutions)
    // A catalogue row: every user may put an account on it (SC-1354).
    .values({ name: `SC-1340 ${suffix}`, typeId: institutionTypeId, isVerified: true })
    .returning();
  institutionId = institution!.id;
  const [accountType] = await db
    .insert(schema.accountTypes)
    .values({ code: `sc1340-acct-${suffix}`, name: 'SC-1340 account type' })
    .returning();
  accountTypeId = accountType!.id;
});

afterAll(async () => {
  await db.delete(schema.users).where(inArray(schema.users.id, [alice.id, mallory.id]));
  await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, accountTypeId));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, institutionId));
  await db.delete(schema.institutionTypes).where(eq(schema.institutionTypes.id, institutionTypeId));
  await db.delete(schema.tokens).where(eq(schema.tokens.id, currencyId));
  await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, currencyTypeId));
});

describe('batchOperations.ensureAccount checks the owner (SC-1340)', () => {
  test("another user's account id is refused", async () => {
    const aliceAccount = await makeAccount(alice.id);
    await expect(
      makeAuthedCaller(mallory).batchOperations.ensureAccount({ accountId: aliceAccount })
    ).rejects.toThrow();
  });

  test('control: the owner gets their own account back', async () => {
    const own = await makeAccount(alice.id);
    const result = await makeAuthedCaller(alice).batchOperations.ensureAccount({ accountId: own });
    expect(result.accountId).toBe(own);
    expect(result.institutionId).toBe(institutionId);
    expect(result.createdAccount).toBe(false);
  });
});

describe('account metadata is not taken from the client (SC-1341)', () => {
  test('a client-sent userWalletId is refused and nothing is created', async () => {
    const name = `SC-1341 planted ${suffix}`;
    await expect(
      makeAuthedCaller(mallory).batchOperations.ensureAccount({
        account: {
          institutionId,
          name,
          typeId: accountTypeId,
          metadata: { userWalletId: randomUUID() },
        },
      } as never)
    ).rejects.toThrow();
    expect(await accountsNamed(mallory.id, name)).toHaveLength(0);
  });

  test('control: the payload the frontend sends still creates the account', async () => {
    const name = `SC-1341 plain ${suffix}`;
    const result = await makeAuthedCaller(mallory).batchOperations.ensureAccount({
      account: { institutionId, name, typeId: accountTypeId },
    });
    expect(result.createdAccount).toBe(true);
    const [row] = await accountsNamed(mallory.id, name);
    expect(row?.id).toBe(result.accountId);
    expect(row?.metadata).toEqual({});
  });
});
