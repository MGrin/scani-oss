import { expect, spyOn, test } from 'bun:test';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingCacheWriter } from '../../../src/services/feeds/HoldingCacheWriter';
import { SnapshotWriter } from '../../../src/services/feeds/SnapshotWriter';
import { PortfolioValuationService } from '../../../src/services/portfolio/PortfolioValuationService';
import { PriceReader } from '../../../src/services/pricing/PriceReader';
import { UpdateHoldingUseCase } from '../../../src/use-cases/UpdateHoldingUseCase';
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

for (const path of ['edit', 'snapshot'] as const) {
  test(`real ${path} with a holding lock avoids inversion with a currency writer`, async () => {
    const f = await fixture();
    const ownerLocked = Promise.withResolvers<void>();
    const holdingLocked = Promise.withResolvers<void>();
    const firstPid = Promise.withResolvers<number>();
    const proceedFirst = Promise.withResolvers<void>();
    const proceedSecond = Promise.withResolvers<void>();
    const first = db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL deadlock_timeout = '100ms'`);
      const [pid] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      firstPid.resolve(pid!.pid);
      await tx
        .update(schema.users)
        .set({ baseCurrencyId: f.alternate.id })
        .where(eq(schema.users.id, f.user.id));
      ownerLocked.resolve();
      await proceedFirst.promise;
      await writer().revalue(f.user.id, [f.holding.id], at, tx);
    });
    let second: Promise<unknown> | undefined;
    try {
      await ownerLocked.promise;
      second = db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL deadlock_timeout = '100ms'`);
        await tx
          .select()
          .from(schema.holdings)
          .where(eq(schema.holdings.id, f.holding.id))
          .for('no key update');
        holdingLocked.resolve();
        await proceedSecond.promise;
        if (path === 'edit') {
          await Container.get(UpdateHoldingUseCase).execute(
            f.holding.id,
            { balance: '3', editCause: 'flow' },
            f.user.id,
            tx
          );
        } else {
          await Container.get(SnapshotWriter).record(
            {
              userId: f.user.id,
              holdingId: f.holding.id,
              amount: '3',
              at: new Date(),
              cause: 'flow',
              legacySource: 'manual',
              legacyMeta: {},
            },
            { cache: 'set' },
            tx
          );
        }
      });
      await holdingLocked.promise;
      proceedFirst.resolve();
      await blocked(await firstPid.promise);
      proceedSecond.resolve();
      await Promise.all([first, second]);
      expect((await f.read()).balance).toBe('3');
      expect((await f.read()).valueQuote?.baseTokenId).toBe(f.alternate.id);
      expect((await f.read()).valueBase).toBe('60');
    } finally {
      proceedFirst.resolve();
      proceedSecond.resolve();
      await Promise.allSettled([first, second]);
      await f.cleanup();
    }
  }, 10000);
}

test('currency contention invalidates a quote and takes live fallback until refill', async () => {
  const f = await fixture();
  await db.transaction((tx) => writer().revalue(f.user.id, [f.holding.id], at, tx));
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const owner = db.transaction(async (tx) => {
    await tx
      .update(schema.users)
      .set({ baseCurrencyId: f.alternate.id })
      .where(eq(schema.users.id, f.user.id));
    locked.resolve();
    await release.promise;
  });
  let expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    release.resolve();
  }, 2000);
  try {
    await locked.promise;
    await db.transaction((tx) => writer().revalue(f.user.id, [f.holding.id], later, tx));
    expect(expired).toBe(false);
    expect((await f.read()).valueQuote).toBeNull();
    expect((await f.read()).valueBase).toBe('20');
    expect(
      await Container.get(PortfolioValuationService).readCachedPortfolioValueAt(f.user.id, {
        at: later,
        baseCurrencyId: f.base.id,
      })
    ).toBeNull();
    release.resolve();
    await owner;
    await db.transaction((tx) => writer().revalue(f.user.id, [f.holding.id], later, tx));
    expect((await f.read()).valueQuote?.baseTokenId).toBe(f.alternate.id);
    expect((await f.read()).valueBase).toBe('40');
  } finally {
    clearTimeout(timeout);
    release.resolve();
    await owner.catch(() => {});
    await f.cleanup();
  }
}, 10000);
