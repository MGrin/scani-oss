import { expect, spyOn, test } from 'bun:test';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingCacheWriter } from '../../../src/services/feeds/HoldingCacheWriter';
import { PortfolioValuationService } from '../../../src/services/portfolio/PortfolioValuationService';
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
