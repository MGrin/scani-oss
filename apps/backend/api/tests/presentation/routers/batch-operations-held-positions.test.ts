import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { seedHoldingCache } from '@scani/domain/test-helpers';
import { TRPCError } from '@trpc/server';
import { eq, inArray } from 'drizzle-orm';
import { makeAuthedCaller } from '../../helpers/test-caller';

// SC-1527: adding a token the account already holds passed the form and failed
// the whole batch in the worker. The form now asks `heldPositions` first, and
// `createHoldingsBatch` refuses the collision before anything is enqueued.

const suffix = randomUUID().slice(0, 8);
type User = typeof schema.users.$inferSelect;

let alice: User;
let mallory: User;
let accountId: string;
let institutionId: string;
let institutionTypeId: string;
let accountTypeId: string;
let tokenTypeId: string;
let btcId: string;
let ethId: string;

async function makeToken(symbol: string): Promise<string> {
  const [token] = await db
    .insert(schema.tokens)
    .values({ symbol: `${symbol}${suffix}`, name: `SC-1527 ${symbol}`, typeId: tokenTypeId })
    .returning();
  if (!token) throw new Error(`token insert failed: ${symbol}`);
  return token.id;
}

beforeAll(async () => {
  const [tokenType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `sc1527-tok-${suffix}`, name: 'SC-1527 token type' })
    .returning();
  tokenTypeId = tokenType!.id;
  btcId = await makeToken('B');
  ethId = await makeToken('E');
  const users = await db
    .insert(schema.users)
    .values([
      { email: `sc1527-alice-${suffix}@scani.local`, name: 'alice', baseCurrencyId: btcId },
      { email: `sc1527-mallory-${suffix}@scani.local`, name: 'mallory', baseCurrencyId: btcId },
    ])
    .returning();
  alice = users[0]!;
  mallory = users[1]!;
  const [institutionType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `sc1527-${suffix}`, name: 'SC-1527 type' })
    .returning();
  institutionTypeId = institutionType!.id;
  const [institution] = await db
    .insert(schema.institutions)
    .values({ name: `SC-1527 ${suffix}`, typeId: institutionTypeId, isVerified: true })
    .returning();
  institutionId = institution!.id;
  const [accountType] = await db
    .insert(schema.accountTypes)
    .values({ code: `sc1527-acct-${suffix}`, name: 'SC-1527 account type' })
    .returning();
  accountTypeId = accountType!.id;
  const [account] = await db
    .insert(schema.accounts)
    .values({ userId: alice.id, institutionId, name: `SC-1527 ${suffix}`, typeId: accountTypeId })
    .returning();
  accountId = account!.id;
  await seedHoldingCache(db, (calculator) =>
    calculator
      .insert(schema.holdings)
      .values({ userId: alice.id, accountId, tokenId: btcId, balance: '0.4', source: 'manual' })
  );
});

afterAll(async () => {
  await db.delete(schema.users).where(inArray(schema.users.id, [alice.id, mallory.id]));
  await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, accountTypeId));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, institutionId));
  await db.delete(schema.institutionTypes).where(eq(schema.institutionTypes.id, institutionTypeId));
  await db.delete(schema.tokens).where(inArray(schema.tokens.id, [btcId, ethId]));
  await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, tokenTypeId));
});

describe('batchOperations.heldPositions (SC-1527)', () => {
  test("returns the account's hand-entered positions for the tokens asked about", async () => {
    const held = await makeAuthedCaller(alice).batchOperations.heldPositions({
      accountId,
      tokenIds: [btcId, ethId],
    });
    expect(held).toEqual([{ tokenId: btcId, label: null }]);
  });

  test("another user's account reads as holding nothing", async () => {
    const held = await makeAuthedCaller(mallory).batchOperations.heldPositions({
      accountId,
      tokenIds: [btcId],
    });
    expect(held).toEqual([]);
  });
});

describe('batchOperations.createHoldingsBatch refuses a held token before enqueueing (SC-1527)', () => {
  test('an unnamed second BTC is a CONFLICT naming the token', async () => {
    const error = await makeAuthedCaller(alice)
      .batchOperations.createHoldingsBatch({
        requestId: randomUUID(),
        accountId,
        newHoldings: [
          { tokenId: btcId, balance: '0.5' },
          { tokenId: ethId, balance: '2' },
        ],
        updateHoldings: [],
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('CONFLICT');
    expect((error as TRPCError).message).toContain(`B${suffix}`);
  });

  test('a balance no holding can hold is refused at the wire', async () => {
    await expect(
      makeAuthedCaller(alice).batchOperations.createHoldingsBatch({
        requestId: randomUUID(),
        accountId,
        newHoldings: [{ tokenId: ethId, balance: '123456789012345678901' }],
        updateHoldings: [],
      })
    ).rejects.toThrow();
  });
});
