import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { PortfolioValueCache } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { BullMqEnqueueService } from '@scani/queue';
import { RedisRealtimeUpdatesService } from '@scani/realtime';
import { and, eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

// SC-1285: a custom token is private to the user who created it (mgrin,
// 2026-09-21). On 2026-09-19 one account listed every user's private-company
// tokens, re-priced another account's, and could read the email of whoever had
// edited one. Every case here is A/B: A owns the token and B attacks it — and
// where a refusal could be a broken procedure rather than a working guard, A
// doing the same thing is the control.
//
// The custom-token services open their own transactions on `getDb()`, so this
// cannot run inside `withTestDb`. It commits its own rows and removes them.

restoreContainerAfterAll();

type User = typeof schema.users.$inferSelect;

const db = () => getDb();
const createdUserIds: string[] = [];
const enqueued: unknown[] = [];

async function makeUser(label: string): Promise<User> {
  const [row] = await db()
    .insert(schema.users)
    .values({ email: `sc1285-${label}-${crypto.randomUUID()}@example.test`, name: label })
    .returning();
  if (!row) throw new Error('fixture: user insert returned no row');
  createdUserIds.push(row.id);
  return row;
}

function symbol(): string {
  return `SC1285${crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

function stubSideEffects() {
  Container.set(BullMqEnqueueService, {
    add: async (_name: string, payload: unknown) => {
      enqueued.push(payload);
      return 'job-id';
    },
  } as unknown as BullMqEnqueueService);
  Container.set(RedisRealtimeUpdatesService, {
    broadcast: () => {},
  } as unknown as RedisRealtimeUpdatesService);
  Container.set(PortfolioValueCache, { bust: async () => {} } as unknown as PortfolioValueCache);
}

let a: User;
let b: User;
let usd: typeof schema.tokens.$inferSelect;

beforeAll(async () => {
  stubSideEffects();
  a = await makeUser('a');
  b = await makeUser('b');
  const [row] = await db()
    .select({ token: schema.tokens })
    .from(schema.tokens)
    .innerJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
    .where(and(eq(schema.tokens.symbol, 'USD'), eq(schema.tokenTypes.code, 'fiat')));
  if (!row) throw new Error('fixture: no USD token');
  usd = row.token;
  // Both users have a base currency, as a real account does; a batch create
  // refuses without one before it reaches the check this file is about.
  for (const u of [a, b]) {
    await db()
      .update(schema.users)
      .set({ baseCurrencyId: usd.id })
      .where(eq(schema.users.id, u.id));
    u.baseCurrencyId = usd.id;
  }
});

afterAll(async () => {
  if (createdUserIds.length === 0) return;
  await db()
    .delete(schema.tokenPriceEditHistory)
    .where(inArray(schema.tokenPriceEditHistory.editedByUserId, createdUserIds));
  await db().delete(schema.tokens).where(inArray(schema.tokens.createdByUserId, createdUserIds));
  await db().delete(schema.users).where(inArray(schema.users.id, createdUserIds));
});

async function aCreates() {
  return makeAuthedCaller(a).tokens.createCustom({
    symbol: symbol(),
    name: 'Acme Private Co',
    typeCode: 'private-company',
    manualPrice: 2000,
    baseCurrencyCode: 'USD',
  });
}

describe('custom tokens are private to their owner (SC-1285)', () => {
  test('createCustom records the caller as the owner', async () => {
    const token = await aCreates();
    expect(token.createdByUserId).toBe(a.id);
  });

  test('listCustom returns the caller’s own tokens and never another user’s', async () => {
    const token = await aCreates();

    const forA = await makeAuthedCaller(a).tokens.listCustom();
    const forB = await makeAuthedCaller(b).tokens.listCustom();

    expect(forA.map((t) => t.id)).toContain(token.id);
    expect(forB.map((t) => t.id)).not.toContain(token.id);
  });

  test('updateCustomPrice by another user is refused exactly as a missing token is', async () => {
    const token = await aCreates();
    const missing = crypto.randomUUID();
    const reprice = (id: string) =>
      makeAuthedCaller(b).tokens.updateCustomPrice({
        tokenId: id,
        newPrice: 1,
        baseCurrencyCode: 'USD',
        reason: 'edited by acctB',
      });

    const onTheirs = await reprice(token.id).catch((e: unknown) => e);
    const onNothing = await reprice(missing).catch((e: unknown) => e);

    expect(onTheirs).toMatchObject({ code: 'NOT_FOUND' });
    expect(onNothing).toMatchObject({ code: 'NOT_FOUND' });
    expect((onTheirs as Error).message.replace(token.id, '<id>')).toBe(
      (onNothing as Error).message.replace(missing, '<id>')
    );

    const prices = await db()
      .select()
      .from(schema.tokenPrices)
      .where(eq(schema.tokenPrices.tokenId, token.id));
    expect(prices.map((p) => p.price)).toEqual(['2000']);

    // Control: the owner can.
    const mine = await makeAuthedCaller(a).tokens.updateCustomPrice({
      tokenId: token.id,
      newPrice: 2100,
      baseCurrencyCode: 'USD',
    });
    expect(mine.newPrice).toBe('2100');
  });

  test('getPriceEditHistory is empty for another user and carries no other user’s email', async () => {
    const token = await aCreates();
    // An edit by B already on record — the 2026-09-19 row, written before this
    // fix could refuse it. The owner still must not be handed B's address.
    await db().insert(schema.tokenPriceEditHistory).values({
      tokenId: token.id,
      baseTokenId: usd.id,
      previousPrice: '2000',
      newPrice: '1',
      editedByUserId: b.id,
      reason: 'edited by acctB',
    });

    expect(await makeAuthedCaller(b).tokens.getPriceEditHistory({ tokenId: token.id })).toEqual([]);

    const forA = await makeAuthedCaller(a).tokens.getPriceEditHistory({ tokenId: token.id });
    expect(forA).toHaveLength(2);
    const emails = forA.map((row) => row.editorEmail);
    expect(emails).toContain(a.email);
    expect(emails).not.toContain(b.email);
    expect(forA.find((row) => row.editedByUserId === b.id)?.editorName).toBeNull();
  });

  test('createCustom with a symbol another user already has is not a conflict', async () => {
    const token = await aCreates();

    const theirs = await makeAuthedCaller(b).tokens.createCustom({
      symbol: token.symbol,
      name: 'Something else entirely',
      typeCode: 'private-company',
      manualPrice: 5,
      baseCurrencyCode: 'USD',
    });
    expect(theirs.id).not.toBe(token.id);
    expect(theirs.createdByUserId).toBe(b.id);

    // Control: the same symbol twice for ONE owner is still refused.
    const again = await makeAuthedCaller(a)
      .tokens.createCustom({
        symbol: token.symbol,
        name: 'Acme Private Co',
        typeCode: 'private-company',
        manualPrice: 1,
        baseCurrencyCode: 'USD',
      })
      .catch((e: unknown) => e);
    expect(again).toMatchObject({ code: 'CONFLICT' });
  });

  test('another user cannot attach the token to a holding', async () => {
    const token = await aCreates();
    const batch = (u: User) =>
      makeAuthedCaller(u).batchOperations.createHoldingsBatch({
        requestId: crypto.randomUUID(),
        accountId: crypto.randomUUID(),
        newHoldings: [{ tokenId: token.id, balance: '10' }],
      });

    enqueued.length = 0;
    expect(await batch(b).catch((e: unknown) => e)).toMatchObject({ code: 'NOT_FOUND' });
    expect(enqueued).toHaveLength(0);

    // Control: the owner's identical request reaches the queue.
    await batch(a);
    expect(enqueued).toHaveLength(1);
  });

  test('another user cannot find, price, or adopt it through any other token-id path', async () => {
    const token = await aCreates();
    const asB = makeAuthedCaller(b);
    const asA = makeAuthedCaller(a);

    expect((await asB.tokens.getAll()).map((t) => t.id)).not.toContain(token.id);
    expect((await asA.tokens.getAll()).map((t) => t.id)).toContain(token.id);

    expect((await asB.tokens.search({ query: token.symbol })).map((t) => t.id)).not.toContain(
      token.id
    );
    expect((await asA.tokens.search({ query: token.symbol })).map((t) => t.id)).toContain(token.id);

    const rates = await asB.tokens.getBaseCurrencyRates({ currencyTokenIds: [token.id] });
    expect(rates.rates).toEqual([
      { currencyTokenId: token.id, symbol: null, rate: null, asOf: null },
    ]);

    expect(
      await asB.tokens.markAsScam({ tokenId: token.id }).catch((e: unknown) => e)
    ).toMatchObject({ code: 'NOT_FOUND' });

    expect(
      await asB.users.updateCurrent({ baseCurrencyId: token.id }).catch((e: unknown) => e)
    ).toMatchObject({ code: 'NOT_FOUND' });
    const [bNow] = await db().select().from(schema.users).where(eq(schema.users.id, b.id));
    expect(bNow?.baseCurrencyId).toBe(usd.id);

    expect(
      await asB.portfolio
        .getNetWorthSeries({
          from: new Date('2026-01-01'),
          to: new Date('2026-02-01'),
          baseCurrencyId: token.id,
        })
        .catch((e: unknown) => e)
    ).toMatchObject({ code: 'NOT_FOUND' });

    expect(
      await asB.vaults
        .create({ name: 'v', targetAmount: '1', currencyId: token.id, color: '#000000' } as never)
        .catch((e: unknown) => e)
    ).toMatchObject({ code: 'NOT_FOUND' });

    expect(
      await asB.payments
        .create({
          vendorId: crypto.randomUUID(),
          direction: 'outflow',
          kind: 'fixed',
          currencyTokenId: token.id,
          intervalUnit: 'month',
          intervalCount: 1,
          anchorDate: '2026-01-01',
        } as never)
        .catch((e: unknown) => e)
    ).toMatchObject({ code: 'NOT_FOUND' });
  });
});
