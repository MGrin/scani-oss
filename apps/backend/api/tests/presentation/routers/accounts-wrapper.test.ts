import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { and, eq } from 'drizzle-orm';
import { makeAuthedCaller } from '../../helpers/test-caller';

// SC-1645: the wrapper refusals reach the caller as a readable BAD_REQUEST,
// and the picker reads the seeded wrappers.

const suffix = randomUUID().slice(0, 8);
type User = typeof schema.users.$inferSelect;

let owner: User;
let institutionTypeId: string;
let institutionId: string;

async function typeId(code: string): Promise<string> {
  const [type] = await db
    .select({ id: schema.accountTypes.id })
    .from(schema.accountTypes)
    .where(eq(schema.accountTypes.code, code));
  return type!.id;
}

async function makeAccount(typeCode: string): Promise<string> {
  const [account] = await db
    .insert(schema.accounts)
    .values({
      userId: owner.id,
      institutionId,
      name: `SC-1645 ${typeCode} ${randomUUID()}`,
      typeId: await typeId(typeCode),
    })
    .returning();
  return account!.id;
}

beforeAll(async () => {
  // A batch create refuses a user with no base currency before it reaches
  // the wrapper check, so the owner has one, as a real account does.
  const [usd] = await db
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .innerJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
    .where(and(eq(schema.tokens.symbol, 'USD'), eq(schema.tokenTypes.code, 'fiat')));
  if (!usd) throw new Error('fixture: no USD token');
  const [user] = await db
    .insert(schema.users)
    .values({ email: `sc1645-owner-${suffix}@scani.local`, name: 'owner', baseCurrencyId: usd.id })
    .returning();
  owner = user!;
  const [institutionType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `sc1645-${suffix}`, name: 'SC-1645 type' })
    .returning();
  institutionTypeId = institutionType!.id;
  const [institution] = await db
    .insert(schema.institutions)
    .values({ name: `SC-1645 ${suffix}`, typeId: institutionTypeId })
    .returning();
  institutionId = institution!.id;
});

afterAll(async () => {
  await db.delete(schema.users).where(eq(schema.users.id, owner.id));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, institutionId));
  await db.delete(schema.institutionTypes).where(eq(schema.institutionTypes.id, institutionTypeId));
});

describe('accounts router: wrappers', () => {
  test('listWrappers returns the 46 seeded wrappers', async () => {
    const rows = await makeAuthedCaller(owner).accounts.listWrappers();
    expect(rows).toHaveLength(46);
    expect(rows[0]).toMatchObject({ code: 'brokerage', region: 'us', treatment: 'general' });
  });

  test('update saves a wrapper on an asset account', async () => {
    const id = await makeAccount('investment');
    const saved = await makeAuthedCaller(owner).accounts.update({ id, data: { wrapper: 'isa' } });
    expect(saved.wrapper).toBe('isa');
  });

  test('a wrapper on a liability account is a readable BAD_REQUEST', async () => {
    const id = await makeAccount('mortgage');
    await expect(
      makeAuthedCaller(owner).accounts.update({ id, data: { wrapper: 'isa' } })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'A wrapper belongs on an asset account',
    });
  });

  test('an asset-to-liability type change is a readable BAD_REQUEST', async () => {
    const id = await makeAccount('investment');
    await expect(
      makeAuthedCaller(owner).accounts.update({ id, data: { typeId: await typeId('loan') } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('creating a liability account with a wrapper is a readable BAD_REQUEST', async () => {
    await expect(
      makeAuthedCaller(owner).batchOperations.ensureAccount({
        account: {
          name: `SC-1645 loan ${suffix}`,
          institutionId,
          typeId: await typeId('loan'),
          wrapper: 'isa',
        },
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'A wrapper belongs on an asset account',
    });
  });
});
