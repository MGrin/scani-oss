import { expect, spyOn, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingCacheWriter } from '../../../src/services/feeds/HoldingCacheWriter';
import { PriceHubResolver } from '../../../src/services/pricing/PriceHubResolver';
import { PriceReader } from '../../../src/services/pricing/PriceReader';
import { withTestDb } from '../../../test/helpers/db';
import { seedHoldingCache, sqlStateOf } from '../../../test/helpers/engine-guard';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../test/helpers/factories-extra';

type Tx = Parameters<Parameters<typeof withTestDb>[0]>[0];
const at = new Date('2026-11-01T12:00:00Z');
const later = new Date(+at + 60_000);
async function fixture(tx: Tx, balance = '0') {
  await makeToken(tx, { symbol: 'USDT', name: 'Tether' });
  const [base, , alternate] = await Container.get(PriceHubResolver).hubTokenIds(tx);
  if (!base || !alternate) throw new Error('hubs missing');
  const user = await makeUser(tx, { baseCurrencyId: base });
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const token = await makeToken(tx);
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
    balance,
  });
  const price = (value: string, timestamp = at, source = 'first', currency = base) =>
    tx
      .insert(schema.tokenPrices)
      .values({ tokenId: token.id, baseTokenId: currency, price: value, timestamp, source });
  const read = async () =>
    (await tx.select().from(schema.holdings).where(eq(schema.holdings.id, holding.id)))[0]!;
  const revalue = (instant = at) =>
    Container.get(HoldingCacheWriter).revalue(user.id, [holding.id], instant, tx);
  return { user, holding, token, base, alternate, price, read, revalue };
}

test('zero balance refreshes unit price, source and date without a value change', async () => {
  await withTestDb(async (tx) => {
    const f = await fixture(tx);
    await f.price('10');
    await f.revalue();
    await f.price('11', later, 'second');
    await f.revalue(later);
    expect((await f.read()).valueQuote).toMatchObject({
      version: 1,
      baseTokenId: f.base,
      price: '11',
      source: 'second',
    });
    expect((await f.read()).valuePricedAt).toEqual(later);
    expect((await f.read()).valueBase).toBe('0');
  });
});

test('old writers invalidate quotes and bare writers cannot change or clear quotes', async () => {
  await withTestDb(async (tx) => {
    const f = await fixture(tx, '2');
    await f.price('10');
    await f.revalue();
    expect((await f.read()).valueQuote).not.toBeNull();
    expect(
      await sqlStateOf(tx, (sp) =>
        sp
          .update(schema.holdings)
          .set({ valueQuote: null })
          .where(eq(schema.holdings.id, f.holding.id))
      )
    ).toBe('SCE01');
    await seedHoldingCache(tx, (c) =>
      c
        .update(schema.holdings)
        .set({ balance: '3', valueBase: '30' })
        .where(eq(schema.holdings.id, f.holding.id))
    );
    expect((await f.read()).valueQuote).toBeNull();
  });
});

test('an older calculation cannot replace a newer quote even when the balance agrees', async () => {
  await withTestDb(async (tx) => {
    const f = await fixture(tx, '2');
    await f.price('10');
    const reader = Container.get(PriceReader);
    const load = reader.at.bind(reader);
    let interleaved = false;
    const spy = spyOn(reader, 'at').mockImplementation(async (...args) => {
      const old = await load(...args);
      if (!interleaved) {
        interleaved = true;
        await f.price('12', later);
        await f.revalue(later);
      }
      return old;
    });
    try {
      await f.revalue();
    } finally {
      spy.mockRestore();
    }
    expect((await f.read()).valueBase).toBe('24');
    expect((await f.read()).valueQuote?.price).toBe('12');
  });
});

test('a currency change during pricing cannot stamp a quote in the previous currency', async () => {
  await withTestDb(async (tx) => {
    const f = await fixture(tx, '2');
    await f.price('10');
    await f.price('20', at, 'fx', f.alternate);
    const reader = Container.get(PriceReader);
    const load = reader.at.bind(reader);
    let moved = false;
    const spy = spyOn(reader, 'at').mockImplementation(async (...args) => {
      const answer = await load(...args);
      if (!moved) {
        moved = true;
        await tx
          .update(schema.users)
          .set({ baseCurrencyId: f.alternate })
          .where(eq(schema.users.id, f.user.id));
      }
      return answer;
    });
    try {
      await f.revalue();
    } finally {
      spy.mockRestore();
    }
    expect((await f.read()).valueQuote?.baseTokenId).toBe(f.alternate);
    expect((await f.read()).valueBase).toBe('40');
  });
});
