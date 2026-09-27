import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { eq, inArray } from 'drizzle-orm';
import { makeAuthedCaller } from '../../helpers/test-caller';

// SC-1273: a newcomer typed "BTC" and the picker offered "ABTC — Ameriican
// Bitcoin" above "BTC — Bitcoin", because the catalogue half of the search
// sorted alphabetically and `A` < `B`. An exact symbol is the answer to the
// question the user typed; a symbol that merely contains it is not.
//
// `tokens.search` reads through `getDb()`, so this commits its own rows and
// removes them. The symbols are unique per run, so the shared catalogue
// cannot place a row between them.

restoreContainerAfterAll();

type User = typeof schema.users.$inferSelect;

const db = () => getDb();
const stem = `Q${crypto.randomUUID().replace(/-/g, '').slice(0, 7).toUpperCase()}`;
let user: User;

beforeAll(async () => {
  const [row] = await db()
    .insert(schema.users)
    .values({ email: `sc1273-${crypto.randomUUID()}@example.test`, name: 'sc1273' })
    .returning();
  if (!row) throw new Error('fixture: user insert returned no row');
  user = row;
  const [cryptoType] = await db()
    .select({ id: schema.tokenTypes.id })
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, 'crypto'));
  if (!cryptoType) throw new Error('fixture: no crypto token type');
  // `A…` sorts before the exact symbol and `Z…` after it: the old order put
  // the exact match second, and a correct order must put it first either way.
  await db()
    .insert(schema.tokens)
    .values(
      [`A${stem}`, stem, `Z${stem}`].map((symbol) => ({
        symbol,
        name: `SC-1273 ${symbol}`,
        typeId: cryptoType.id,
        decimals: 8,
        createdByUserId: user.id,
      }))
    );
});

afterAll(async () => {
  await db().delete(schema.tokens).where(eq(schema.tokens.createdByUserId, user.id));
  await db()
    .delete(schema.users)
    .where(inArray(schema.users.id, [user.id]));
});

describe('tokens.search ranks an exact symbol first (SC-1273)', () => {
  test('the exact symbol leads, then the rest alphabetically', async () => {
    const results = await makeAuthedCaller(user).tokens.search({ query: stem });
    expect(results.map((t) => t.symbol)).toEqual([stem, `A${stem}`, `Z${stem}`]);
  });

  test('the match is case-blind, as the search itself is', async () => {
    const results = await makeAuthedCaller(user).tokens.search({ query: stem.toLowerCase() });
    expect(results[0]?.symbol).toBe(stem);
  });

  test('control: a query no symbol equals keeps alphabetical order', async () => {
    const results = await makeAuthedCaller(user).tokens.search({ query: stem.slice(0, 6) });
    expect(results.map((t) => t.symbol)).toEqual([`A${stem}`, stem, `Z${stem}`]);
  });
});
