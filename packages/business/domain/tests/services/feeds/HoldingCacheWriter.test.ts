/**
 * `HoldingCacheWriter.apply` against Postgres: the one writer of
 * `holdings.balance`, so what it does to a hidden holding is what every sync,
 * edit and transfer does (SC-1557).
 */

import { describe, expect, spyOn, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { Decimal } from '@scani/shared';
import { eq, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingCacheWriter } from '../../../src/services/feeds/HoldingCacheWriter';
import { SnapshotWriter } from '../../../src/services/feeds/SnapshotWriter';
import { PriceHubResolver } from '../../../src/services/pricing/PriceHubResolver';
import { PriceReader } from '../../../src/services/pricing/PriceReader';
import { withTestDb } from '../../../test/helpers/db';
import { seedHoldingCache, sqlStateOf } from '../../../test/helpers/engine-guard';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../../test/helpers/factories-extra';

type Tx = Parameters<Parameters<typeof withTestDb>[0]>[0];

async function hiddenHolding(tx: Tx, hiddenBy: 'auto' | 'user' | null) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const token = await makeToken(tx);
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
    balance: '0',
    isHidden: true,
    hiddenBy,
  });
  return { userId: user.id, holdingId: holding.id };
}

/**
 * The evidence that makes the engine's balance `quantity`: one ledger row a
 * minute ago on a holding with no reading (A5 D-1: `apply` writes what the
 * evidence says, so a test states the evidence, never the figure).
 */
async function evidenceFor(tx: Tx, userId: string, holdingId: string, quantity: string) {
  if (new Decimal(quantity).isZero()) return;
  await makeHoldingTransaction(tx, {
    userId,
    holdingId,
    kind: new Decimal(quantity).isNegative() ? 'withdraw' : 'deposit',
    quantity,
    occurredAt: new Date(Date.now() - 60_000),
  });
}

async function write(tx: Tx, hiddenBy: 'auto' | 'user' | null, balance: string) {
  const { userId, holdingId } = await hiddenHolding(tx, hiddenBy);
  await evidenceFor(tx, userId, holdingId, balance);
  await Container.get(HoldingCacheWriter).apply(userId, [{ holdingId, balance }], tx);
  const [row] = await tx.select().from(schema.holdings).where(eq(schema.holdings.id, holdingId));
  if (!row) throw new Error('the holding is gone');
  return { balance: row.balance, isHidden: row.isHidden, hiddenBy: row.hiddenBy };
}

describe('HoldingCacheWriter — a holding the sweep hid (SC-1557)', () => {
  test('is shown again by a non-zero balance, and still reads as swept', async () => {
    await withTestDb(async (tx) => {
      expect(await write(tx, 'auto', '12.5')).toEqual({
        balance: '12.5',
        isHidden: false,
        hiddenBy: 'auto',
      });
    });
  });

  test('is shown again by a negative balance', async () => {
    await withTestDb(async (tx) => {
      expect((await write(tx, 'auto', '-3')).isHidden).toBe(false);
    });
  });

  test('stays hidden when the balance written is zero, however it is spelled', async () => {
    await withTestDb(async (tx) => {
      expect((await write(tx, 'auto', '0')).isHidden).toBe(true);
      expect((await write(tx, 'auto', '0.000')).isHidden).toBe(true);
    });
  });
});

describe('HoldingCacheWriter — a holding that is shown (SC-1559)', () => {
  // The other direction: the writer shows and never hides, whatever it writes.
  test('stays shown when the balance written is zero, swept before or not', async () => {
    await withTestDb(async (tx) => {
      for (const hiddenBy of ['auto', null] as const) {
        const { userId, holdingId } = await hiddenHolding(tx, hiddenBy);
        await seedHoldingCache(tx, (calculator) =>
          calculator
            .update(schema.holdings)
            .set({ isHidden: false, balance: '9' })
            .where(eq(schema.holdings.id, holdingId))
        );

        await Container.get(HoldingCacheWriter).apply(userId, [{ holdingId, balance: '0' }], tx);

        const [row] = await tx
          .select()
          .from(schema.holdings)
          .where(eq(schema.holdings.id, holdingId));
        expect({ balance: row?.balance, isHidden: row?.isHidden }).toEqual({
          balance: '0',
          isHidden: false,
        });
      }
    });
  });
});

describe('HoldingCacheWriter — a holding its owner hid (SC-1557)', () => {
  test('stays hidden when it gets a balance', async () => {
    await withTestDb(async (tx) => {
      expect(await write(tx, 'user', '12.5')).toEqual({
        balance: '12.5',
        isHidden: true,
        hiddenBy: 'user',
      });
    });
  });

  test('stays hidden when nothing says who hid it', async () => {
    await withTestDb(async (tx) => {
      expect((await write(tx, null, '12.5')).isHidden).toBe(true);
    });
  });
});

describe('HoldingCacheWriter — the value cache (SC-1610)', () => {
  const T0 = new Date('2026-10-07T10:00:00.000Z');
  const AT = new Date('2026-10-07T10:30:00.000Z');

  /** The three hubs, in order; USDT is added where the database has no canonical row. */
  async function hubs(tx: Tx) {
    const [usdt] = await tx
      .select({ id: schema.tokens.id })
      .from(schema.tokens)
      .where(eq(schema.tokens.symbol, 'USDT'));
    if (usdt === undefined) await makeToken(tx, { symbol: 'USDT', name: 'Tether' });
    const [usd, , eur] = await Container.get(PriceHubResolver).hubTokenIds(tx);
    if (!usd || !eur) throw new Error('the seeded hubs did not resolve');
    return { usd, eur };
  }

  async function holder(tx: Tx, baseCurrencyId: string, balance: string, tokenId?: string) {
    const user = await makeUser(tx, { baseCurrencyId });
    const institution = await makeInstitution(tx);
    const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
    const token = tokenId ? { id: tokenId } : await makeToken(tx);
    const holding = await makeHolding(tx, {
      userId: user.id,
      accountId: account.id,
      tokenId: token.id,
      balance,
    });
    return { userId: user.id, holdingId: holding.id, tokenId: token.id };
  }

  async function price(tx: Tx, tokenId: string, baseTokenId: string, value: string, at = T0) {
    await tx.insert(schema.tokenPrices).values({
      tokenId,
      baseTokenId,
      price: value,
      timestamp: at,
      granularity: 'intraday',
      source: 'fixture',
    });
  }

  async function cached(tx: Tx, holdingId: string) {
    const [row] = await tx
      .select({ value: schema.holdings.valueBase, pricedAt: schema.holdings.valuePricedAt })
      .from(schema.holdings)
      .where(eq(schema.holdings.id, holdingId));
    return { value: row?.value ?? null, pricedAt: row?.pricedAt?.toISOString() ?? null };
  }

  test('revalue writes balance x price in the base, dated by the reading', async () => {
    await withTestDb(async (tx) => {
      const { usd } = await hubs(tx);
      const h = await holder(tx, usd, '2.5');
      await price(tx, h.tokenId, usd, '123.456');

      await Container.get(HoldingCacheWriter).revalue(h.userId, [h.holdingId], AT, tx);

      expect(await cached(tx, h.holdingId)).toEqual({
        value: '308.64',
        pricedAt: T0.toISOString(),
      });
    });
  });

  test('a revalue that moves nothing writes nothing', async () => {
    await withTestDb(async (tx) => {
      const { usd } = await hubs(tx);
      const h = await holder(tx, usd, '2');
      await price(tx, h.tokenId, usd, '10');
      const writer = Container.get(HoldingCacheWriter);

      expect(await writer.revalue(h.userId, [h.holdingId], AT, tx)).toEqual([h.holdingId]);
      expect(await writer.revalue(h.userId, [h.holdingId], AT, tx)).toEqual([]);
      // A newer reading at the same price, well inside the refresh horizon: nothing to write.
      await price(tx, h.tokenId, usd, '10', new Date(T0.getTime() + 60_000));
      expect(await writer.revalue(h.userId, [h.holdingId], AT, tx)).toEqual([]);
      await price(tx, h.tokenId, usd, '11', new Date(T0.getTime() + 120_000));
      expect(await writer.revalue(h.userId, [h.holdingId], AT, tx)).toEqual([h.holdingId]);
    });
  });

  test('an unpriced holding is cached as null, and the base itself at its balance', async () => {
    await withTestDb(async (tx) => {
      const { usd } = await hubs(tx);
      const unpriced = await holder(tx, usd, '7');
      const cash = await holder(tx, usd, '40.10', usd);
      const writer = Container.get(HoldingCacheWriter);

      await writer.revalue(unpriced.userId, [unpriced.holdingId], AT, tx);
      await writer.revalue(cash.userId, [cash.holdingId], AT, tx);

      expect(await cached(tx, unpriced.holdingId)).toEqual({ value: null, pricedAt: null });
      expect(await cached(tx, cash.holdingId)).toEqual({
        value: '40.1',
        pricedAt: AT.toISOString(),
      });
    });
  });

  test('apply revalues what it wrote, in the same transaction', async () => {
    await withTestDb(async (tx) => {
      const { usd } = await hubs(tx);
      const h = await holder(tx, usd, '1');
      await price(tx, h.tokenId, usd, '10');
      await evidenceFor(tx, h.userId, h.holdingId, '3');

      await Container.get(HoldingCacheWriter).apply(
        h.userId,
        [{ holdingId: h.holdingId, balance: '3' }],
        tx
      );

      expect((await cached(tx, h.holdingId)).value).toBe('30');
    });
  });

  test('a changed pair revalues the holdings routed through it, and writes only a moved value', async () => {
    await withTestDb(async (tx) => {
      const { usd, eur } = await hubs(tx);
      const h = await holder(tx, eur, '2');
      await price(tx, h.tokenId, usd, '10');
      await price(tx, eur, usd, '1.25');
      const bystander = await holder(tx, usd, '1');
      await price(tx, bystander.tokenId, usd, '5');
      const writer = Container.get(HoldingCacheWriter);
      await writer.revalue(h.userId, [h.holdingId], AT, tx);
      await writer.revalue(bystander.userId, [bystander.holdingId], AT, tx);
      expect((await cached(tx, h.holdingId)).value).toBe('16');

      const later = new Date(AT.getTime() + 60_000);
      await price(tx, eur, usd, '1.6', later);
      const after = new Date(later.getTime() + 60_000);
      const written = await writer.revalueAffected([{ tokenId: eur, baseTokenId: usd }], after, {
        tx,
      });

      // Dated by the route's binding leg, the older one: the token's own reading.
      expect(await cached(tx, h.holdingId)).toEqual({ value: '12.5', pricedAt: T0.toISOString() });
      // A candidate too (a route of it hops through EUR), but its value did not move.
      expect((await cached(tx, bystander.holdingId)).value).toBe('5');
      expect(written).toContain(h.holdingId);
      expect(written).not.toContain(bystander.holdingId);

      const unrelated = await makeToken(tx);
      expect(
        await writer.revalueAffected([{ tokenId: unrelated.id, baseTokenId: usd }], after, { tx })
      ).toEqual([]);
    });
  });

  test('a cached date past its refresh horizon is rewritten unmoved; a custom one never', async () => {
    await withTestDb(async (tx) => {
      const { usd } = await hubs(tx);
      const [customType] = await tx
        .select({ id: schema.tokenTypes.id })
        .from(schema.tokenTypes)
        .where(eq(schema.tokenTypes.code, 'private-company'));
      if (!customType) throw new Error('the private-company type is not seeded');
      const coin = await holder(tx, usd, '2');
      const house = await holder(tx, usd, '1', (await makeToken(tx, { typeId: customType.id })).id);
      await price(tx, coin.tokenId, usd, '10');
      await price(tx, house.tokenId, usd, '500');
      const writer = Container.get(HoldingCacheWriter);
      await writer.revalue(coin.userId, [coin.holdingId], AT, tx);
      await writer.revalue(house.userId, [house.holdingId], AT, tx);

      const sameAgain = new Date(T0.getTime() + 5 * 3_600_000);
      await price(tx, coin.tokenId, usd, '10', sameAgain);
      await price(tx, house.tokenId, usd, '500', sameAgain);
      const early = new Date(T0.getTime() + 5.5 * 3_600_000);
      // Other files' committed holdings may be swept too; only these two are asserted.
      expect(await writer.revalueAffected([], early, { tx, sweep: true })).not.toContain(
        coin.holdingId
      );

      const late = new Date(T0.getTime() + 6.5 * 3_600_000);
      const late_ = await writer.revalueAffected([], late, { tx, sweep: true });
      expect(late_).toContain(coin.holdingId);
      expect(late_).not.toContain(house.holdingId);
      expect((await cached(tx, coin.holdingId)).pricedAt).toBe(sameAgain.toISOString());
      expect((await cached(tx, house.holdingId)).pricedAt).toBe(T0.toISOString());
    });
  });

  test('the sweep fills a holding never valued, and refreshes a base holding past 24h', async () => {
    await withTestDb(async (tx) => {
      const { usd } = await hubs(tx);
      const fresh = await holder(tx, usd, '3');
      await price(tx, fresh.tokenId, usd, '4');
      const cash = await holder(tx, usd, '50', usd);
      const writer = Container.get(HoldingCacheWriter);
      await writer.revalue(cash.userId, [cash.holdingId], AT, tx);

      const nextDay = new Date(AT.getTime() + 25 * 3_600_000);
      const swept = await writer.revalueAffected([], nextDay, { tx, sweep: true });

      expect(swept).toEqual(expect.arrayContaining([fresh.holdingId, cash.holdingId]));
      expect(await cached(tx, fresh.holdingId)).toEqual({
        value: '12',
        pricedAt: T0.toISOString(),
      });
      expect(await cached(tx, cash.holdingId)).toEqual({
        value: '50',
        pricedAt: nextDay.toISOString(),
      });
      // Without the sweep, neither is a candidate.
      expect(await writer.revalueAffected([], nextDay, { tx })).toEqual([]);
    });
  });

  test('a balance written while the price loads is revalued once more, never overwritten stale (SC-1620)', async () => {
    await withTestDb(async (tx) => {
      const { usd } = await hubs(tx);
      const h = await holder(tx, usd, '2');
      await price(tx, h.tokenId, usd, '10');
      const reader = Container.get(PriceReader);
      const load = reader.at.bind(reader);
      const during = spyOn(reader, 'at').mockImplementation(async (...args) => {
        await seedHoldingCache(tx, (calculator) =>
          calculator
            .update(schema.holdings)
            .set({ balance: '9' })
            .where(eq(schema.holdings.id, h.holdingId))
        );
        return load(...args);
      });
      try {
        const written = await Container.get(HoldingCacheWriter).revalue(
          h.userId,
          [h.holdingId],
          AT,
          tx
        );
        expect(written).toEqual([h.holdingId]);
        expect((await cached(tx, h.holdingId)).value).toBe('90');
        // The skipped holding is retried once, not looped.
        expect(during).toHaveBeenCalledTimes(2);
      } finally {
        during.mockRestore();
      }
    });
  });

  test('an uninterleaved revalue loads its prices once (SC-1620 control)', async () => {
    await withTestDb(async (tx) => {
      const { usd } = await hubs(tx);
      const h = await holder(tx, usd, '2');
      await price(tx, h.tokenId, usd, '10');
      const loads = spyOn(Container.get(PriceReader), 'at');
      try {
        await Container.get(HoldingCacheWriter).revalue(h.userId, [h.holdingId], AT, tx);
        expect(loads).toHaveBeenCalledTimes(1);
        expect((await cached(tx, h.holdingId)).value).toBe('20');
      } finally {
        loads.mockRestore();
      }
    });
  });

  /** A holding its owner hid, whose balance no write has touched since. */
  async function hiddenByOwner(tx: Tx, usd: string) {
    const h = await holder(tx, usd, '2');
    await price(tx, h.tokenId, usd, '10');
    await seedHoldingCache(tx, (calculator) =>
      calculator
        .update(schema.holdings)
        .set({ isHidden: true, hiddenBy: 'user' })
        .where(eq(schema.holdings.id, h.holdingId))
    );
    return h;
  }

  // The data-quality flag for a hidden holding with a new balance reads
  // `value_base` (A5 #9), so a price run that skipped hidden rows left that
  // flag reading a value from whenever the balance last moved (SC-1676).
  test('the price run revalues a holding its owner hid, as it does a visible one (SC-1676)', async () => {
    await withTestDb(async (tx) => {
      const { usd } = await hubs(tx);
      const h = await hiddenByOwner(tx, usd);

      const written = await Container.get(HoldingCacheWriter).revalueAffected(
        [{ tokenId: h.tokenId, baseTokenId: usd }],
        AT,
        { tx }
      );

      expect(written).toEqual([h.holdingId]);
      expect((await cached(tx, h.holdingId)).value).toBe('20');
    });
  });

  test('the sweep fills a hidden holding never valued (SC-1676)', async () => {
    await withTestDb(async (tx) => {
      const { usd } = await hubs(tx);
      const h = await hiddenByOwner(tx, usd);

      const swept = await Container.get(HoldingCacheWriter).revalueAffected([], AT, {
        tx,
        sweep: true,
      });

      expect(swept).toContain(h.holdingId);
      expect((await cached(tx, h.holdingId)).value).toBe('20');
    });
  });

  test('the value is the exact product, as the live valuation computes it', async () => {
    await withTestDb(async (tx) => {
      const { usd } = await hubs(tx);
      const h = await holder(tx, usd, '0.123456789012345678');
      await price(tx, h.tokenId, usd, '61234.987654321');

      await Container.get(HoldingCacheWriter).revalue(h.userId, [h.holdingId], AT, tx);

      expect((await cached(tx, h.holdingId)).value).toBe(
        new Decimal('0.123456789012345678').mul(new Decimal('61234.987654321')).toString()
      );
    });
  });
});

describe('HoldingCacheWriter — the engine writer guard (A5 D-2)', () => {
  test('with the guard on, apply writes and a later bare write is refused', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId } = await hiddenHolding(tx, null);
      await evidenceFor(tx, userId, holdingId, '7');

      await Container.get(HoldingCacheWriter).apply(userId, [{ holdingId, balance: '7' }], tx);
      const balance = async () =>
        (await tx.select().from(schema.holdings).where(eq(schema.holdings.id, holdingId)))[0]
          ?.balance;
      expect(await balance()).toBe('7');
      expect(
        await sqlStateOf(tx, (sp) =>
          sp.update(schema.holdings).set({ balance: '8' }).where(eq(schema.holdings.id, holdingId))
        )
      ).toBe('SCE01');
      expect(await balance()).toBe('7');
    });
  });

  test('a null lastUpdated keeps the stored instant, to the microsecond', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId } = await hiddenHolding(tx, null);
      const stamp = async () =>
        (
          (await tx.execute(
            sql`SELECT last_updated::text AS t FROM holdings WHERE id = ${holdingId}`
          )) as unknown as { t: string }[]
        )[0]?.t;
      const before = await stamp();

      await Container.get(HoldingCacheWriter).apply(
        userId,
        [{ holdingId, balance: '7', lastUpdated: null }],
        tx
      );
      expect(await stamp()).toBe(before);
    });
  });
});

describe('HoldingCacheWriter — the engine writes the balance (A5 D-1, D-16)', () => {
  const HOUR = 3_600_000;

  async function holding(tx: Tx, fields: { createdAt?: Date } = {}) {
    const user = await makeUser(tx);
    const institution = await makeInstitution(tx);
    const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
    const token = await makeToken(tx);
    const row = await makeHolding(tx, {
      userId: user.id,
      accountId: account.id,
      tokenId: token.id,
      balance: '0',
      ...fields,
    });
    return { userId: user.id, holdingId: row.id };
  }

  /** What a person typed, written as the app writes it. */
  async function typed(tx: Tx, h: { userId: string; holdingId: string }, amount: string, at: Date) {
    await Container.get(SnapshotWriter).record(
      {
        ...h,
        amount,
        at,
        cause: 'flow',
        legacySource: 'sync-capture',
        legacyMeta: { origin: 'updateHolding' },
      },
      { cache: 'unchanged' },
      tx
    );
  }

  async function stored(tx: Tx, holdingId: string) {
    const [row] = await tx
      .select({ balance: schema.holdings.balance })
      .from(schema.holdings)
      .where(eq(schema.holdings.id, holdingId));
    return row?.balance;
  }

  test('writes the reading, not the figure it is handed, and returns what it wrote', async () => {
    await withTestDb(async (tx) => {
      const h = await holding(tx);
      await typed(tx, h, '50', new Date(Date.now() - HOUR));

      const written = await Container.get(HoldingCacheWriter).apply(
        h.userId,
        [{ holdingId: h.holdingId, balance: '70' }],
        tx
      );

      expect(await stored(tx, h.holdingId)).toBe('50');
      expect(written.get(h.holdingId)).toBe('50');
    });
  });

  test('walks forward from the reading through the ledger written after it', async () => {
    await withTestDb(async (tx) => {
      const h = await holding(tx);
      await typed(tx, h, '50', new Date(Date.now() - 2 * HOUR));
      await makeHoldingTransaction(tx, {
        userId: h.userId,
        holdingId: h.holdingId,
        kind: 'deposit',
        quantity: '5',
        occurredAt: new Date(Date.now() - HOUR),
      });

      await Container.get(HoldingCacheWriter).apply(
        h.userId,
        [{ holdingId: h.holdingId, balance: '999' }],
        tx
      );

      expect(await stored(tx, h.holdingId)).toBe('55');
    });
  });

  test('a holding with no reading writes the sum of its ledger', async () => {
    await withTestDb(async (tx) => {
      const h = await holding(tx);
      for (const quantity of ['8', '2']) {
        await makeHoldingTransaction(tx, {
          userId: h.userId,
          holdingId: h.holdingId,
          kind: 'deposit',
          quantity,
          occurredAt: new Date(Date.now() - HOUR),
        });
      }

      await Container.get(HoldingCacheWriter).apply(
        h.userId,
        [{ holdingId: h.holdingId, balance: '0' }],
        tx
      );

      expect(await stored(tx, h.holdingId)).toBe('10');
    });
  });

  test('a holding that has not started yet writes zero', async () => {
    await withTestDb(async (tx) => {
      const h = await holding(tx, { createdAt: new Date(Date.now() + 24 * HOUR) });

      const written = await Container.get(HoldingCacheWriter).apply(
        h.userId,
        [{ holdingId: h.holdingId, balance: '4' }],
        tx
      );

      expect(await stored(tx, h.holdingId)).toBe('0');
      expect(written.get(h.holdingId)).toBe('0');
    });
  });

  test('a figure the engine agrees with is written as the caller wrote it (U4)', async () => {
    await withTestDb(async (tx) => {
      const h = await holding(tx);
      await typed(tx, h, '12.30', new Date(Date.now() - HOUR));
      const writer = Container.get(HoldingCacheWriter);

      expect((await writer.engineBalances(h.userId, [h.holdingId], tx)).get(h.holdingId)).toBe(
        '12.3'
      );
      const written = await writer.apply(
        h.userId,
        [{ holdingId: h.holdingId, balance: '12.30' }],
        tx
      );

      expect(await stored(tx, h.holdingId)).toBe('12.30');
      expect(written.get(h.holdingId)).toBe('12.30');
    });
  });
});
