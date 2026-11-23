import { expect, spyOn, test } from 'bun:test';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingCacheWriter } from '../../../src/services/feeds/HoldingCacheWriter';
import { PortfolioValuationService } from '../../../src/services/portfolio/PortfolioValuationService';
import { PriceReader } from '../../../src/services/pricing/PriceReader';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../test/helpers/factories-extra';

const at = new Date('2026-11-01T12:00:00Z');
const later = new Date(+at + 60_000);
const writer = () => Container.get(HoldingCacheWriter);

async function fixture() {
  const f = await db.transaction(async (tx) => {
    const base = await makeToken(tx);
    const alternate = await makeToken(tx);
    const asset = await makeToken(tx);
    const user = await makeUser(tx, { baseCurrencyId: base.id });
    const institution = await makeInstitution(tx);
    const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
    const holding = await makeHolding(tx, {
      userId: user.id,
      accountId: account.id,
      tokenId: asset.id,
      balance: '2',
    });
    await tx.insert(schema.tokenPrices).values([
      { tokenId: asset.id, baseTokenId: base.id, price: '10', timestamp: at, source: 'fixture' },
      {
        tokenId: asset.id,
        baseTokenId: alternate.id,
        price: '20',
        timestamp: at,
        source: 'fixture',
      },
    ]);
    return { user, holding, base, alternate, asset, institution };
  });
  return {
    ...f,
    read: async () =>
      (await db.select().from(schema.holdings).where(eq(schema.holdings.id, f.holding.id)))[0]!,
    cleanup: async () => {
      await db.delete(schema.users).where(eq(schema.users.id, f.user.id));
      await db.delete(schema.tokenPrices).where(eq(schema.tokenPrices.tokenId, f.asset.id));
      await db
        .delete(schema.tokens)
        .where(inArray(schema.tokens.id, [f.base.id, f.alternate.id, f.asset.id]));
      await db.delete(schema.institutions).where(eq(schema.institutions.id, f.institution.id));
    },
  };
}

async function blocked(pid: number) {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    const [row] = await db.execute<{ blocked: boolean }>(
      sql`SELECT cardinality(pg_blocking_pids(${pid})) > 0 AS blocked`
    );
    if (row?.blocked) return;
    await Bun.sleep(10);
  }
  throw new Error(`session ${pid} did not block within 3000ms`);
}

test('two sessions cannot commit an older calculation over a newer quote', async () => {
  const f = await fixture();
  const loaded = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const reader = Container.get(PriceReader);
  const load = reader.at.bind(reader);
  const spy = spyOn(reader, 'at').mockImplementation(async (...args) => {
    const result = await load(...args);
    if (+args[2] === +at) {
      loaded.resolve();
      await resume.promise;
    }
    return result;
  });
  const old = db.transaction((tx) => writer().revalue(f.user.id, [f.holding.id], at, tx));
  try {
    await loaded.promise;
    await db.transaction(async (tx) => {
      await tx.insert(schema.tokenPrices).values({
        tokenId: f.asset.id,
        baseTokenId: f.base.id,
        price: '12',
        timestamp: later,
        source: 'new',
      });
      await writer().revalue(f.user.id, [f.holding.id], later, tx);
    });
    resume.resolve();
    await old;
    expect((await f.read()).valueBase).toBe('24');
    expect((await f.read()).valueQuote?.price).toBe('12');
  } finally {
    resume.resolve();
    await old.catch(() => {});
    spy.mockRestore();
    await f.cleanup();
  }
}, 10000);

test('a concurrent currency update waits for valuation and cannot relabel its old quote', async () => {
  const f = await fixture();
  const loaded = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const reader = Container.get(PriceReader);
  const load = reader.at.bind(reader);
  const spy = spyOn(reader, 'at').mockImplementation(async (...args) => {
    const result = await load(...args);
    loaded.resolve();
    await resume.promise;
    return result;
  });
  const valuation = db.transaction((tx) => writer().revalue(f.user.id, [f.holding.id], at, tx));
  const pid = Promise.withResolvers<number>();
  let change: Promise<unknown> | undefined;
  try {
    await loaded.promise;
    change = db.transaction(async (tx) => {
      const [row] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      pid.resolve(row!.pid);
      await tx
        .update(schema.users)
        .set({ baseCurrencyId: f.alternate.id })
        .where(eq(schema.users.id, f.user.id));
    });
    await blocked(await pid.promise);
    resume.resolve();
    await valuation;
    await change;
    spy.mockRestore();
    expect((await f.read()).valueQuote?.baseTokenId).toBe(f.base.id);
    expect(
      await Container.get(PortfolioValuationService).readCachedPortfolioValueAt(f.user.id, {
        at: later,
        baseCurrencyId: f.alternate.id,
      })
    ).toBeNull();
    await db.transaction((tx) => writer().revalue(f.user.id, [f.holding.id], later, tx));
    expect((await f.read()).valueQuote?.baseTokenId).toBe(f.alternate.id);
    expect((await f.read()).valueBase).toBe('40');
  } finally {
    resume.resolve();
    await valuation.catch(() => {});
    await change?.catch(() => {});
    spy.mockRestore();
    await f.cleanup();
  }
}, 10000);

test('balance writes lock currency before holdings, avoiding inversion with a currency writer', async () => {
  const f = await fixture();
  const ownerLocked = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const first = db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL deadlock_timeout = '100ms'`);
    await tx
      .update(schema.users)
      .set({ baseCurrencyId: f.alternate.id })
      .where(eq(schema.users.id, f.user.id));
    ownerLocked.resolve();
    await proceed.promise;
    await writer().revalue(f.user.id, [f.holding.id], at, tx);
  });
  const pid = Promise.withResolvers<number>();
  let second: Promise<unknown> | undefined;
  try {
    await ownerLocked.promise;
    second = db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL deadlock_timeout = '100ms'`);
      const [row] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      pid.resolve(row!.pid);
      await writer().apply(f.user.id, [{ holdingId: f.holding.id }], tx);
    });
    await blocked(await pid.promise);
    proceed.resolve();
    await Promise.all([first, second]);
    expect((await f.read()).valueQuote?.baseTokenId).toBe(f.alternate.id);
    expect((await f.read()).valueBase).toBe('0');
  } finally {
    proceed.resolve();
    await Promise.allSettled([first, second]);
    await f.cleanup();
  }
}, 10000);
