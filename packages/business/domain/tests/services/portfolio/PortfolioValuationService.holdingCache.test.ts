import { expect, spyOn, test } from 'bun:test';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingCacheWriter } from '../../../src/services/feeds/HoldingCacheWriter';
import { HoldingQueryService } from '../../../src/services/holdings/HoldingQueryService';
import { PortfolioValuationService } from '../../../src/services/portfolio/PortfolioValuationService';
import { PortfolioValueCache } from '../../../src/services/portfolio/PortfolioValueCache';
import { PortfolioValueVersion } from '../../../src/services/portfolio/PortfolioValueVersion';
import { PriceReader } from '../../../src/services/pricing/PriceReader';
import { withTestDb } from '../../../test/helpers/db';
import { seedHoldingCache } from '../../../test/helpers/engine-guard';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../test/helpers/factories-extra';
import { absorb, travelling } from '../../../test/helpers/transit';

type Tx = Parameters<Parameters<typeof withTestDb>[0]>[0];
const at = new Date('2026-11-02T12:00:00Z');
async function fixture(tx: Tx) {
  const base = await makeToken(tx);
  const asset = await makeToken(tx);
  const user = await makeUser(tx, { baseCurrencyId: base.id });
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const rows = [];
  for (const [tokenId, balance, isActive] of [
    [asset.id, '2', true],
    [asset.id, '-3', true],
    [asset.id, '0', true],
    [asset.id, '10', false],
    [base.id, '5', true],
  ] as const) {
    rows.push(
      await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId, balance, isActive })
    );
  }
  await tx.insert(schema.tokenPrices).values({
    tokenId: asset.id,
    baseTokenId: base.id,
    price: '10.123456789',
    timestamp: at,
    source: 'fixture',
  });
  await Container.get(HoldingCacheWriter).revalue(
    user.id,
    rows.map((r) => r.id),
    at,
    tx
  );
  return { base, asset, user, rows };
}

test('healthy current read skips price loads and price fingerprinting, with missing-cache positive control', async () => {
  await withTestDb(async (tx) => {
    const f = await fixture(tx);
    const service = Container.get(PortfolioValuationService);
    const select = spyOn(db, 'select').mockImplementation(tx.select.bind(tx));
    const prices = spyOn(Container.get(PriceReader), 'at');
    const version = spyOn(Container.get(PortfolioValueVersion), 'read');
    try {
      const result = await service.getUserPortfolioValue(f.user.id);
      expect(prices).not.toHaveBeenCalled();
      expect(version).not.toHaveBeenCalled();
      expect(result.totalValue).toBe('-5.123456789');
      expect(result.holdings.find((h) => h.holdingId === f.rows[2]?.id)?.currentPrice).toBe(
        '10.123456789'
      );
      const cash = result.holdings.find((h) => h.tokenId === f.base.id);
      expect(cash).toMatchObject({
        currentPrice: '1',
        priceSource: 'Base Currency',
        priceStale: false,
      });
      await seedHoldingCache(tx, (c) =>
        c
          .update(schema.holdings)
          .set({ valueQuote: null })
          .where(eq(schema.holdings.id, f.rows[0]!.id))
      );
      await service.getUserPortfolioValue(f.user.id);
      expect(version).toHaveBeenCalled();
      expect(prices).toHaveBeenCalled();
    } finally {
      select.mockRestore();
      prices.mockRestore();
      version.mockRestore();
    }
  });
});

test('cached reader preserves different quotes per holding and rejects the wrong base', async () => {
  await withTestDb(async (tx) => {
    const f = await fixture(tx);
    const service = Container.get(PortfolioValuationService);
    const row = f.rows[0]!;
    const [cached] = await tx.select().from(schema.holdings).where(eq(schema.holdings.id, row.id));
    await seedHoldingCache(tx, (c) =>
      c
        .update(schema.holdings)
        .set({ valueBase: '40', valueQuote: { ...cached!.valueQuote!, price: '20' } })
        .where(eq(schema.holdings.id, row.id))
    );
    const result = await service.readCachedPortfolioValueAt(f.user.id, {
      at,
      baseCurrencyId: f.base.id,
      tx,
    });
    expect(result?.holdings.find((h) => h.holdingId === row.id)?.currentPrice).toBe('20');
    expect(result?.holdings.find((h) => h.holdingId === f.rows[1]?.id)?.currentPrice).toBe(
      '10.123456789'
    );
    expect(
      await service.readCachedPortfolioValueAt(f.user.id, { at, baseCurrencyId: f.asset.id, tx })
    ).toBeNull();
    const live = await service.computePortfolioValueAt(f.user.id, {
      at,
      baseCurrencyId: f.asset.id,
      tx,
    });
    expect(live.baseCurrency).toBe(f.asset.symbol);
    expect(live.holdings.find((h) => h.tokenId === f.asset.id)?.currentPrice).toBe('1');
  });
});

test('cached transit uses the destination holding and excludes hidden destinations', async () => {
  await withTestDb(async (tx) => {
    const t = await travelling(tx);
    await absorb(tx, t);
    const base = await makeToken(tx);
    await tx
      .update(schema.users)
      .set({ baseCurrencyId: base.id })
      .where(eq(schema.users.id, t.userId));
    await tx.insert(schema.tokenPrices).values({
      tokenId: t.destination.tokenId,
      baseTokenId: base.id,
      price: '1',
      timestamp: new Date(Date.now() - 1000),
      source: 'fixture',
    });
    const service = Container.get(PortfolioValuationService);
    const live = await service.computePortfolioValueAt(t.userId, { at: new Date(), tx });
    await Container.get(HoldingCacheWriter).revalue(
      t.userId,
      live.holdings.map((h) => h.holdingId),
      new Date(),
      tx
    );
    const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, t.userId));
    const result = await service.readCachedPortfolioValueAt(t.userId, {
      at: new Date(),
      baseCurrencyId: user!.baseCurrencyId!,
      tx,
    });
    expect(result?.totalValue).toBe('3000');
    expect(result?.inTransit?.[0]?.value).toBe('500');
    const [destination] = await tx
      .select()
      .from(schema.holdings)
      .where(eq(schema.holdings.id, t.destination.id));
    await seedHoldingCache(tx, (c) =>
      c
        .update(schema.holdings)
        .set({ valueBase: '2000', valueQuote: { ...destination!.valueQuote!, price: '2' } })
        .where(eq(schema.holdings.id, t.destination.id))
    );
    const changed = await service.readCachedPortfolioValueAt(t.userId, {
      at: new Date(),
      baseCurrencyId: base.id,
      tx,
    });
    expect(changed?.inTransit?.[0]?.currentPrice).toBe('2');
    expect(changed?.inTransit?.[0]?.value).toBe('1000');
    expect(changed?.totalValue).toBe('4500');
    await tx
      .update(schema.holdings)
      .set({ isHidden: true })
      .where(eq(schema.holdings.id, t.destination.id));
    const hidden = await service.readCachedPortfolioValueAt(t.userId, {
      at: new Date(),
      baseCurrencyId: user!.baseCurrencyId!,
      tx,
    });
    expect(hidden?.totalValue).toBe('1500');
    expect(hidden?.inTransit ?? []).toEqual([]);
  });
});

test('a damaged identity quote forces the live fallback', async () => {
  await withTestDb(async (tx) => {
    const f = await fixture(tx);
    const cash = f.rows[4]!;
    const [cached] = await tx.select().from(schema.holdings).where(eq(schema.holdings.id, cash.id));
    await seedHoldingCache(tx, (c) =>
      c
        .update(schema.holdings)
        .set({ valueBase: '10', valueQuote: { ...cached!.valueQuote!, price: '2' } })
        .where(eq(schema.holdings.id, cash.id))
    );
    expect(
      await Container.get(PortfolioValuationService).readCachedPortfolioValueAt(f.user.id, {
        at,
        baseCurrencyId: f.base.id,
        tx,
      })
    ).toBeNull();
  });
});

test('explicit hidden details keep their own value while portfolio totals exclude them', async () => {
  await withTestDb(async (tx) => {
    const f = await fixture(tx);
    const hidden = f.rows[1]!;
    await tx
      .update(schema.holdings)
      .set({ isHidden: true, hiddenBy: 'user' })
      .where(eq(schema.holdings.id, hidden.id));
    const select = spyOn(db, 'select').mockImplementation(tx.select.bind(tx));
    try {
      const details = await new HoldingQueryService().getHoldingsByAccountIdWithDetails(
        f.user,
        undefined,
        true
      );
      expect(details.find((h) => h.id === hidden.id)?.value).toBe(-30.3704);
      expect(details.find((h) => h.id === hidden.id)?.price?.value).toBe('10.123456789');
      const portfolio = await Container.get(PortfolioValuationService).getUserPortfolioValue(
        f.user.id
      );
      expect(portfolio.totalValue).toBe('25.246913578');
      expect(portfolio.holdings.some((h) => h.holdingId === hidden.id)).toBe(false);
      await seedHoldingCache(tx, (c) =>
        c.update(schema.holdings).set({ valueQuote: null }).where(eq(schema.holdings.id, hidden.id))
      );
      const redis = spyOn(Container.get(PortfolioValueCache), 'getOrCompute');
      const priceReader = Container.get(PriceReader);
      const load = priceReader.at.bind(priceReader);
      const priceLoad = spyOn(priceReader, 'at').mockImplementation((ids, base, instant) =>
        load(ids, base, instant, tx)
      );
      try {
        const fallback = await Container.get(PortfolioValuationService).getUserPortfolioValue(
          f.user.id,
          undefined,
          undefined,
          undefined,
          true
        );
        expect(fallback.holdings.find((h) => h.holdingId === hidden.id)?.currentPrice).toBe(
          '10.123456789'
        );
        expect(redis).not.toHaveBeenCalled();
      } finally {
        redis.mockRestore();
        priceLoad.mockRestore();
      }
    } finally {
      select.mockRestore();
    }
  });
});
