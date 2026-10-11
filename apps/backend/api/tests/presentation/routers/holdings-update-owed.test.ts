/**
 * SC-1640. The person's own balance edit may go below zero only on what a
 * loan or card owes. The refusal sits on this route, not in the use case,
 * because internal writes go negative on purpose (review I1).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import {
  makeAccount,
  makeHolding,
  makeInstitution,
  makeInstitutionType,
  makeToken,
  makeUser,
  restoreContainerAfterAll,
  seedReading,
} from '@scani/domain/test-helpers';
import { BullMqEnqueueService } from '@scani/queue';
import { eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

restoreContainerAfterAll();

type User = typeof schema.users.$inferSelect;

let user: User;
const tokenIds: string[] = [];
const institutionIds: string[] = [];

async function typeId(code: string): Promise<string> {
  const [row] = await db
    .select({ id: schema.accountTypes.id })
    .from(schema.accountTypes)
    .where(eq(schema.accountTypes.code, code));
  if (!row) throw new Error(`account type ${code} not seeded`);
  return row.id;
}

async function fiatHolding(accountType: string, balance: string): Promise<string> {
  const [fiat] = await db
    .select({ id: schema.tokenTypes.id })
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, 'fiat'));
  const token = await makeToken(db, { typeId: fiat!.id });
  tokenIds.push(token.id);
  const account = await makeAccount(db, {
    userId: user.id,
    institutionId: institutionIds[0]!,
    typeId: await typeId(accountType),
  });
  const holding = await makeHolding(db, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
    balance,
    source: 'manual',
  });
  await seedReading(db, {
    userId: user.id,
    holdingId: holding.id,
    balance,
    at: new Date('2026-01-01T00:00:00Z'),
  });
  return holding.id;
}

beforeAll(async () => {
  user = await makeUser(db);
  const type = await makeInstitutionType(db, { code: `sc1640-owed-${user.id.slice(0, 8)}` });
  const institution = await makeInstitution(db, { typeId: type.id });
  institutionIds.push(institution.id);
  Container.set(BullMqEnqueueService, {
    add: async () => 'job-1',
  } as unknown as BullMqEnqueueService);
});

afterAll(async () => {
  await db.delete(schema.users).where(eq(schema.users.id, user.id));
  await db.delete(schema.tokens).where(inArray(schema.tokens.id, tokenIds));
  await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutionIds));
});

describe('holdings.update below zero', () => {
  test('is a BAD_REQUEST on an asset account, and nothing is written', async () => {
    const id = await fiatHolding('checking', '100');
    await expect(
      makeAuthedCaller(user).holdings.update({
        id,
        data: { balance: '-500', editCause: 'correction' },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const [row] = await db.select().from(schema.holdings).where(eq(schema.holdings.id, id));
    expect(row?.balance).toBe('100');
  });

  test('is what a mortgage owes, saved', async () => {
    const id = await fiatHolding('mortgage', '-480000');
    await makeAuthedCaller(user).holdings.update({
      id,
      data: { balance: '-479000', editCause: 'correction' },
    });
    const [row] = await db.select().from(schema.holdings).where(eq(schema.holdings.id, id));
    expect(row?.balance).toBe('-479000');
  });
});
