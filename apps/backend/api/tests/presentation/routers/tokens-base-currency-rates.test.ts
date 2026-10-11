import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { PortfolioValueCache } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { BullMqEnqueueService } from '@scani/queue';
import { RedisRealtimeUpdatesService } from '@scani/realtime';
import { eq, inArray, or } from 'drizzle-orm';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

// `tokens.getBaseCurrencyRates` (foundation A3, Task 16): each currency's rate
// in the caller's base, read through `PriceReader` from stored readings, dated
// by the reading it binds to. A currency nothing prices answers null and has
// a refresh enqueued; the answer never waits on one.
//
// The route reads through the global connection, so this commits its own rows
// and removes them.

restoreContainerAfterAll();

type User = typeof schema.users.$inferSelect;
type Token = typeof schema.tokens.$inferSelect;

const db = () => getDb();
const enqueued: Array<{ fromTokenId: string; toTokenId: string }> = [];
const made = { users: [] as string[], tokens: [] as string[] };
const READ_AT = new Date(Date.now() - 60_000);

let user: User;
let base: Token;
let unpriced: Token;
let usd: Token;

async function makeFiat(label: string): Promise<Token> {
  const [fiat] = await db()
    .select({ id: schema.tokenTypes.id })
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, 'fiat'));
  if (!fiat) throw new Error('fixture: the fiat token type is seeded by migration');
  const [row] = await db()
    .insert(schema.tokens)
    .values({
      symbol: `${label}${crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`,
      name: `Rates ${label}`,
      typeId: fiat.id,
    })
    .returning();
  if (!row) throw new Error('fixture: token insert returned no row');
  made.tokens.push(row.id);
  return row;
}

beforeAll(async () => {
  Container.set(BullMqEnqueueService, {
    add: async (_name: string, payload: { fromTokenId: string; toTokenId: string }) => {
      enqueued.push(payload);
      return 'job-id';
    },
  } as unknown as BullMqEnqueueService);
  Container.set(RedisRealtimeUpdatesService, {
    broadcast: () => {},
  } as unknown as RedisRealtimeUpdatesService);
  Container.set(PortfolioValueCache, { bust: async () => {} } as unknown as PortfolioValueCache);

  const [usdRow] = await db()
    .select({ token: schema.tokens })
    .from(schema.tokens)
    .innerJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
    .where(eq(schema.tokenTypes.code, 'fiat'))
    .then((rows) => rows.filter((r) => r.token.symbol === 'USD' && !r.token.marketSegment));
  if (!usdRow) throw new Error('fixture: no fiat USD');
  usd = usdRow.token;
  base = await makeFiat('RBASE');
  unpriced = await makeFiat('RNONE');
  // One of the caller's base buys 2 USD.
  await db().insert(schema.tokenPrices).values({
    tokenId: base.id,
    baseTokenId: usd.id,
    price: '2',
    timestamp: READ_AT,
    source: 'frankfurter',
  });
  const [row] = await db()
    .insert(schema.users)
    .values({
      email: `rates-${crypto.randomUUID()}@example.test`,
      name: 'Rates',
      baseCurrencyId: base.id,
    })
    .returning();
  if (!row) throw new Error('fixture: user insert returned no row');
  made.users.push(row.id);
  user = row;
});

afterAll(async () => {
  const custom = await db()
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .where(inArray(schema.tokens.createdByUserId, made.users));
  made.tokens.push(...custom.map((t) => t.id));
  await db()
    .delete(schema.tokenPriceEditHistory)
    .where(inArray(schema.tokenPriceEditHistory.editedByUserId, made.users));
  await db().delete(schema.users).where(inArray(schema.users.id, made.users));
  await db()
    .delete(schema.tokenPrices)
    .where(
      or(
        inArray(schema.tokenPrices.tokenId, made.tokens),
        inArray(schema.tokenPrices.baseTokenId, made.tokens)
      )
    );
  await db().delete(schema.tokens).where(inArray(schema.tokens.id, made.tokens));
});

describe('tokens.getBaseCurrencyRates', () => {
  test('the rates endpoint answers from stored readings and enqueues a refresh for a missing pair', async () => {
    enqueued.length = 0;

    const answer = await makeAuthedCaller(user).tokens.getBaseCurrencyRates({
      currencyTokenIds: [usd.id, unpriced.id],
    });

    expect(answer.baseTokenId).toBe(base.id);
    expect(answer.rates).toEqual([
      { currencyTokenId: usd.id, symbol: 'USD', rate: '0.5', asOf: READ_AT.toISOString() },
      { currencyTokenId: unpriced.id, symbol: unpriced.symbol, rate: null, asOf: null },
    ]);
    // The refresh is fire-and-forget; give it the tick it runs on.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(enqueued.map((job) => [job.fromTokenId, job.toTokenId])).toEqual([
      [unpriced.id, base.id],
    ]);
  });
});

describe('tokens.listCustom', () => {
  test('a custom token shows the price in force in the caller’s base, as the valuation reads it', async () => {
    const created = await makeAuthedCaller(user).tokens.createCustom({
      symbol: `RCUST${crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`,
      name: 'Rates Private Co',
      typeCode: 'private-company',
      manualPrice: 2000,
      baseCurrencyCode: 'USD',
    });

    const listed = await makeAuthedCaller(user).tokens.listCustom();
    const row = listed.find((t) => t.id === created.id);

    // 2000 USD, at 2 USD to one of the caller's base.
    expect(row).toMatchObject({
      latestPrice: '1000',
      latestPriceSource: 'manual',
      latestPriceBaseCurrency: base.symbol,
    });
  });
});
