import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { makeAuthedCaller } from '../../helpers/test-caller';

// SC-1336: `deleteAccount` ignored the caller, so any signed-in user who knew
// another user's account id could delete it — and, through a wallet id the
// client wrote into its OWN account's metadata, strip someone else's wallet.

const suffix = randomUUID().slice(0, 8);
type User = typeof schema.users.$inferSelect;

let alice: User;
let mallory: User;
let institutionId: string;
let institutionTypeId: string;
let accountTypeId: string;
let aliceWalletId: string;

async function makeUser(name: string): Promise<User> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `sc1336-${name}-${suffix}@scani.local`, name })
    .returning();
  if (!user) throw new Error(`user insert failed: ${name}`);
  return user;
}

async function makeAccount(
  userId: string,
  metadata: Record<string, unknown> = {}
): Promise<string> {
  const [account] = await db
    .insert(schema.accounts)
    .values({
      userId,
      institutionId,
      name: `SC-1336 ${randomUUID()}`,
      typeId: accountTypeId,
      metadata,
    })
    .returning();
  if (!account) throw new Error('account insert failed');
  return account.id;
}

async function exists(accountId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId));
  return rows.length === 1;
}

beforeAll(async () => {
  alice = await makeUser('alice');
  mallory = await makeUser('mallory');
  const [institutionType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `sc1336-${suffix}`, name: 'SC-1336 type' })
    .returning();
  institutionTypeId = institutionType!.id;
  const [institution] = await db
    .insert(schema.institutions)
    .values({ name: `SC-1336 ${suffix}`, typeId: institutionTypeId })
    .returning();
  institutionId = institution!.id;
  const [accountType] = await db
    .insert(schema.accountTypes)
    .values({ code: `sc1336-acct-${suffix}`, name: 'SC-1336 account type' })
    .returning();
  accountTypeId = accountType!.id;
  const [wallet] = await db
    .insert(schema.userWallets)
    .values({
      userId: alice.id,
      walletAddress: `0xsc1336${suffix}`,
      institutionIds: [institutionId],
    })
    .returning();
  aliceWalletId = wallet!.id;
});

afterAll(async () => {
  await db.delete(schema.users).where(inArray(schema.users.id, [alice.id, mallory.id]));
  await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, accountTypeId));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, institutionId));
  await db.delete(schema.institutionTypes).where(eq(schema.institutionTypes.id, institutionTypeId));
});

describe('accounts.delete is scoped to the caller (SC-1336)', () => {
  test("another user's account is not found, and it survives", async () => {
    const victim = await makeAccount(alice.id);
    await expect(makeAuthedCaller(mallory).accounts.delete({ id: victim })).rejects.toThrow();
    expect(await exists(victim)).toBe(true);
  });

  test("bulkDelete deletes none of another user's accounts", async () => {
    const victim = await makeAccount(alice.id);
    const result = await makeAuthedCaller(mallory).accounts.bulkDelete({ ids: [victim] });
    expect(result.deletedIds).toEqual([]);
    expect(await exists(victim)).toBe(true);
  });

  test("a wallet id written into your own account cannot reach another user's wallet", async () => {
    const forged = await makeAccount(mallory.id, { userWalletId: aliceWalletId });
    await makeAuthedCaller(mallory).accounts.delete({ id: forged });
    expect(await exists(forged)).toBe(false);

    const [wallet] = await db
      .select()
      .from(schema.userWallets)
      .where(eq(schema.userWallets.id, aliceWalletId));
    expect(wallet?.institutionIds).toEqual([institutionId]);
  });

  test('control: the owner deletes their own account', async () => {
    const own = await makeAccount(alice.id);
    await makeAuthedCaller(alice).accounts.delete({ id: own });
    expect(await exists(own)).toBe(false);
  });

  test("control: the owner's own wallet is still updated when its account goes", async () => {
    const [wallet] = await db
      .insert(schema.userWallets)
      .values({
        userId: alice.id,
        walletAddress: `0xsc1336own${suffix}`,
        institutionIds: [institutionId, randomUUID()],
      })
      .returning();
    const own = await makeAccount(alice.id, { userWalletId: wallet!.id });
    await makeAuthedCaller(alice).accounts.delete({ id: own });

    const [after] = await db
      .select()
      .from(schema.userWallets)
      .where(eq(schema.userWallets.id, wallet!.id));
    expect(after?.institutionIds).not.toContain(institutionId);
  });
});
