import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq, inArray, like } from 'drizzle-orm';
import { makeAuthedCaller } from '../../helpers/test-caller';

// SC-1354: `institutions` was one shared, user-writable catalogue. Every user
// saw every row through `institutions.getAll`, `ensureInstitution` reused
// another user's row by name, and an account could hang off any institution id.
// A row a user creates is now theirs until it is verified.

const suffix = randomUUID().slice(0, 8);
type User = typeof schema.users.$inferSelect;

let alice: User;
let mallory: User;
let institutionTypeId: string;
let accountTypeId: string;
let currencyTypeId: string;
let currencyId: string;
let catalogueId: string;
const catalogueName = `SC-1354 Catalogue ${suffix}`;
const privateName = `SC-1354 Private ${suffix}`;

async function makeUser(name: string): Promise<User> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `sc1354-${name}-${suffix}@scani.local`, name, baseCurrencyId: currencyId })
    .returning();
  if (!user) throw new Error(`user insert failed: ${name}`);
  return user;
}

const namesSeenBy = async (user: User) =>
  (await makeAuthedCaller(user).institutions.getAll()).map((i) => i.name);

function createWithInstitution(user: User, institutionName: string, accountName: string) {
  return makeAuthedCaller(user).batchOperations.ensureAccount({
    institution: { name: institutionName, typeId: institutionTypeId },
    account: { name: accountName, typeId: accountTypeId },
  });
}

let alicePrivateId: string;

beforeAll(async () => {
  const [currencyType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `sc1354-cur-${suffix}`, name: 'SC-1354 currency type' })
    .returning();
  currencyTypeId = currencyType!.id;
  const [currency] = await db
    .insert(schema.tokens)
    .values({ symbol: `S${suffix}`, name: 'SC-1354 currency', typeId: currencyTypeId })
    .returning();
  currencyId = currency!.id;
  alice = await makeUser('alice');
  mallory = await makeUser('mallory');
  const [institutionType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `sc1354-${suffix}`, name: 'SC-1354 type' })
    .returning();
  institutionTypeId = institutionType!.id;
  const [accountType] = await db
    .insert(schema.accountTypes)
    .values({ code: `sc1354-acct-${suffix}`, name: 'SC-1354 account type' })
    .returning();
  accountTypeId = accountType!.id;
  const [catalogue] = await db
    .insert(schema.institutions)
    .values({ name: catalogueName, typeId: institutionTypeId, isVerified: true })
    .returning();
  catalogueId = catalogue!.id;

  const created = await createWithInstitution(alice, privateName, 'Alice main');
  if (!created.institutionId) throw new Error('alice got no institution');
  alicePrivateId = created.institutionId;
});

afterAll(async () => {
  await db.delete(schema.users).where(inArray(schema.users.id, [alice.id, mallory.id]));
  await db.delete(schema.institutions).where(like(schema.institutions.name, `SC-1354 %${suffix}`));
  await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, accountTypeId));
  await db.delete(schema.institutionTypes).where(eq(schema.institutionTypes.id, institutionTypeId));
  await db.delete(schema.tokens).where(eq(schema.tokens.id, currencyId));
  await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, currencyTypeId));
});

describe('a user-created institution stays with its creator (SC-1354)', () => {
  test('it is recorded as theirs and unverified', async () => {
    const [row] = await db
      .select()
      .from(schema.institutions)
      .where(eq(schema.institutions.id, alicePrivateId));
    expect(row?.createdByUserId).toBe(alice.id);
    expect(row?.isVerified).toBe(false);
  });

  test('another user does not see its name', async () => {
    expect(await namesSeenBy(mallory)).not.toContain(privateName);
  });

  test('control: the creator sees it, and both see the verified catalogue', async () => {
    const aliceSees = await namesSeenBy(alice);
    expect(aliceSees).toContain(privateName);
    expect(aliceSees).toContain(catalogueName);
    expect(await namesSeenBy(mallory)).toContain(catalogueName);
  });

  test('the same name from another user makes their own row, not a reuse', async () => {
    const result = await createWithInstitution(mallory, privateName.toUpperCase(), 'Mallory');
    expect(result.institutionId).not.toBe(alicePrivateId);
    expect(result.createdInstitution).toBe(true);
    expect(await namesSeenBy(alice)).not.toContain(privateName.toUpperCase());
  });

  test("another user's institution id cannot carry their account", async () => {
    await expect(
      makeAuthedCaller(mallory).batchOperations.ensureAccount({
        account: { institutionId: alicePrivateId, name: 'Mallory planted', typeId: accountTypeId },
      })
    ).rejects.toThrow();
    const planted = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.institutionId, alicePrivateId));
    expect(planted.map((a) => a.userId)).toEqual([alice.id]);
  });

  test('control: a verified catalogue row is reused by name and accepted by id', async () => {
    const byName = await createWithInstitution(mallory, catalogueName.toLowerCase(), 'By name');
    expect(byName.institutionId).toBe(catalogueId);
    expect(byName.createdInstitution).toBe(false);
    const byId = await makeAuthedCaller(mallory).batchOperations.ensureAccount({
      account: { institutionId: catalogueId, name: 'By id', typeId: accountTypeId },
    });
    expect(byId.createdAccount).toBe(true);
  });
});

test('updating an owned account cannot expose a foreign private institution', async () => {
  const caller = makeAuthedCaller(mallory);
  const own = await caller.batchOperations.ensureAccount({
    account: { institutionId: catalogueId, name: 'Move boundary', typeId: accountTypeId },
  });
  await expect(
    caller.accounts.update({ id: own.accountId!, data: { institutionId: alicePrivateId } })
  ).rejects.toThrow();
  const [unchanged] = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, own.accountId!));
  expect(unchanged?.institutionId).toBe(catalogueId);
  expect(await namesSeenBy(mallory)).not.toContain(privateName);
  const mine = await createWithInstitution(mallory, `SC-1354 Own ${suffix}`, 'Owned target');
  const moved = await caller.accounts.update({
    id: own.accountId!,
    data: { institutionId: mine.institutionId! },
  });
  expect(moved.institutionId).toBe(mine.institutionId!);
});
