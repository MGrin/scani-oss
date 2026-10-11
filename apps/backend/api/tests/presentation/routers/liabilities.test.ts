import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { makeAuthedCaller } from '../../helpers/test-caller';

// SC-1640: the liabilities router maps the service's refusals to tRPC codes,
// so a client can tell "not yours" from "not a liability account".

const suffix = randomUUID().slice(0, 8);
type User = typeof schema.users.$inferSelect;

let owner: User;
let stranger: User;
let institutionTypeId: string;
let institutionId: string;
let mortgageId: string;
let checkingId: string;

async function makeUser(name: string): Promise<User> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `sc1640-${name}-${suffix}@scani.local`, name })
    .returning();
  if (!user) throw new Error(`user insert failed: ${name}`);
  return user;
}

async function makeAccount(typeCode: string): Promise<string> {
  const [type] = await db
    .select({ id: schema.accountTypes.id })
    .from(schema.accountTypes)
    .where(eq(schema.accountTypes.code, typeCode));
  const [account] = await db
    .insert(schema.accounts)
    .values({ userId: owner.id, institutionId, name: `SC-1640 ${typeCode}`, typeId: type!.id })
    .returning();
  return account!.id;
}

beforeAll(async () => {
  owner = await makeUser('owner');
  stranger = await makeUser('stranger');
  const [institutionType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `sc1640-${suffix}`, name: 'SC-1640 type' })
    .returning();
  institutionTypeId = institutionType!.id;
  const [institution] = await db
    .insert(schema.institutions)
    .values({ name: `SC-1640 ${suffix}`, typeId: institutionTypeId })
    .returning();
  institutionId = institution!.id;
  mortgageId = await makeAccount('mortgage');
  checkingId = await makeAccount('checking');
});

afterAll(async () => {
  await db.delete(schema.users).where(inArray(schema.users.id, [owner.id, stranger.id]));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, institutionId));
  await db.delete(schema.institutionTypes).where(eq(schema.institutionTypes.id, institutionTypeId));
});

const terms = {
  kind: 'loan' as const,
  annualRatePct: '3.5',
  termMonths: 360,
  startDate: '2026-01-15',
  originalPrincipal: '500000',
};

describe('liabilities router', () => {
  test('saves terms on the owner liability account and projects from them', async () => {
    const caller = makeAuthedCaller(owner);
    await caller.liabilities.setTerms({ accountId: mortgageId, ...terms });
    const p = await caller.liabilities.getProjection({ accountId: mortgageId });
    expect(p?.schedule).toHaveLength(360);
    expect(p?.owed).toBe('0');
    expect(p?.projection?.status).toBe('paid_off');
    expect(p?.kind).toBe('loan');
    expect(p?.hasTerms).toBe(true);
  });

  // Inactive until an amount owed could be entered (review I4), active since
  // batch 2 made that path.
  test('the pickers offer the four liability types, each with its class', async () => {
    const types = await makeAuthedCaller(owner).accountTypes.getAll();
    const classOf = (code: string) => types.find((type) => type.code === code)?.class;
    expect(classOf('checking')).toBe('asset');
    for (const code of ['loan', 'mortgage', 'credit_card', 'other_liability']) {
      expect(classOf(code)).toBe('liability');
    }
  });

  test('terms on an asset account are a BAD_REQUEST', async () => {
    await expect(
      makeAuthedCaller(owner).liabilities.setTerms({ accountId: checkingId, ...terms })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('reads on an asset account are null, not an error', async () => {
    const caller = makeAuthedCaller(owner);
    expect(await caller.liabilities.getProjection({ accountId: checkingId })).toBeNull();
    expect(await caller.liabilities.getTerms({ accountId: checkingId })).toBeNull();
  });

  test("another user's account is NOT_FOUND", async () => {
    await expect(
      makeAuthedCaller(stranger).liabilities.getProjection({ accountId: mortgageId })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
