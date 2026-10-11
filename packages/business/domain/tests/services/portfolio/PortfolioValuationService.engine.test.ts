process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Container } from 'typedi';
import {
  PortfolioValuationService,
  type PortfolioValueResult,
} from '../../../src/services/portfolio/PortfolioValuationService';
import { seedHoldingCache } from '../../../test/helpers/engine-guard';

/**
 * The live valuation priced by `PriceReader` (foundation A3, Task 15). Rows
 * are committed because the service reads the module `db`; every row this
 * file inserts is deleted after it.
 *
 * Everything is valued at one fixed instant, a Monday, so no assertion moves
 * with the wall clock.
 */
const AT = new Date('2026-09-28T14:00:00.000Z');
const HOUR_MS = 3_600_000;
const hoursBefore = (hours: number) => new Date(AT.getTime() - hours * HOUR_MS);

const suffix = randomUUID().slice(0, 6).toUpperCase();
const created = {
  userIds: [] as string[],
  tokenIds: [] as string[],
  priceIds: [] as string[],
  institutionId: '',
  institutionTypeId: '',
  accountTypeId: '',
};

async function typeId(code: string): Promise<string> {
  const [row] = await db
    .select({ id: schema.tokenTypes.id })
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, code));
  if (!row) throw new Error(`token type ${code} is not seeded`);
  return row.id;
}

async function seededFiat(symbol: string): Promise<string> {
  const [row] = await db
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .innerJoin(schema.tokenTypes, eq(schema.tokenTypes.id, schema.tokens.typeId))
    .where(
      and(
        eq(schema.tokens.symbol, symbol),
        eq(schema.tokenTypes.code, 'fiat'),
        isNull(schema.tokens.marketSegment)
      )
    );
  if (!row) throw new Error(`${symbol} is not seeded`);
  return row.id;
}

async function token(code: string, symbol: string): Promise<string> {
  const [row] = await db
    .insert(schema.tokens)
    .values({
      symbol: `${symbol}${suffix}`,
      name: `${symbol} ${suffix}`,
      typeId: await typeId(code),
    })
    .returning({ id: schema.tokens.id });
  if (!row) throw new Error(`token insert failed: ${symbol}`);
  created.tokenIds.push(row.id);
  return row.id;
}

async function price(
  tokenId: string,
  baseTokenId: string,
  value: string,
  timestamp: Date,
  source: string
): Promise<void> {
  const [row] = await db
    .insert(schema.tokenPrices)
    .values({ tokenId, baseTokenId, price: value, timestamp, source, granularity: 'intraday' })
    .returning({ id: schema.tokenPrices.id });
  if (!row) throw new Error('price insert failed');
  created.priceIds.push(row.id);
}

async function userHolding(
  baseCurrencyId: string,
  holdings: ReadonlyArray<{ tokenId: string; balance: string }>
): Promise<string> {
  const [user] = await db
    .insert(schema.users)
    .values({
      email: `pvs-engine-${randomUUID().slice(0, 8)}@scani.local`,
      name: 'PVS',
      baseCurrencyId,
    })
    .returning({ id: schema.users.id });
  if (!user) throw new Error('user insert failed');
  created.userIds.push(user.id);
  const [account] = await db
    .insert(schema.accounts)
    .values({
      userId: user.id,
      institutionId: created.institutionId,
      name: 'PVS Account',
      typeId: created.accountTypeId,
    })
    .returning({ id: schema.accounts.id });
  await seedHoldingCache(db, (calculator) =>
    calculator
      .insert(schema.holdings)
      .values(holdings.map((h) => ({ userId: user.id, accountId: account!.id, ...h })))
  );
  return user.id;
}

const ids: Record<string, string> = {};
let eurUser = '';
let usdUser = '';

const value = (userId: string) =>
  Container.get(PortfolioValuationService).computePortfolioValueAt(userId, {
    at: AT,
  });
const holding = (result: PortfolioValueResult, tokenId: string) => {
  const found = result.holdings.find((h) => h.tokenId === tokenId);
  if (!found) throw new Error('holding missing from the result');
  return found;
};

beforeAll(async () => {
  const [institutionType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `pvs-engine-${suffix}`, name: 'PVS' })
    .returning({ id: schema.institutionTypes.id });
  const [institution] = await db
    .insert(schema.institutions)
    .values({ name: 'PVS', typeId: institutionType!.id })
    .returning({ id: schema.institutions.id });
  const [accountType] = await db
    .insert(schema.accountTypes)
    .values({ code: `pvs-engine-${suffix}`, name: 'PVS' })
    .returning({ id: schema.accountTypes.id });
  created.institutionTypeId = institutionType!.id;
  created.institutionId = institution!.id;
  created.accountTypeId = accountType!.id;

  const usd = await seededFiat('USD');
  const eur = await seededFiat('EUR');
  ids.usd = usd;
  ids.eur = eur;
  ids.hub = await token('crypto', 'HUB');
  ids.frozen = await token('crypto', 'FRZ');
  ids.old = await token('crypto', 'OLD');
  ids.stock = await token('stock', 'STK');
  ids.fund = await token('private-company', 'FND');
  ids.none = await token('crypto', 'NON');
  ids.orphanFiat = await token('fiat', 'ZQX');
  ids.orphan = await token('crypto', 'ORF');

  // EUR → USD, five hours old: the hub leg every EUR answer below goes through.
  await price(eur, usd, '1.25', hoursBefore(5), 'frankfurter');
  // Priced in USD two hours ago: reached through the hub.
  await price(ids.hub, usd, '100', hoursBefore(2), 'coingecko');
  // SC-1477: a ten-day-old row in the user's base, and a newer one in USD.
  await price(ids.frozen, eur, '50', hoursBefore(240), 'coingecko');
  await price(ids.frozen, usd, '100', hoursBefore(3), 'coingecko');
  // A crypto price five days old.
  await price(ids.old, usd, '10', hoursBefore(120), 'coingecko');
  // A stock priced at Friday's close, read on Monday afternoon.
  await price(ids.stock, usd, '20', new Date('2026-09-25T20:00:00.000Z'), 'yahoo-finance');
  // A hand-valued fund, valued a year ago.
  await price(ids.fund, usd, '1000', hoursBefore(365 * 24), 'manual');
  // Priced only in a currency nothing prices.
  await price(ids.orphan, ids.orphanFiat, '7', hoursBefore(1), 'coingecko');

  eurUser = await userHolding(eur, [
    { tokenId: ids.hub, balance: '2' },
    { tokenId: ids.frozen, balance: '1' },
    { tokenId: eur, balance: '30' },
  ]);
  usdUser = await userHolding(usd, [
    { tokenId: ids.old, balance: '3' },
    { tokenId: ids.stock, balance: '5' },
    { tokenId: ids.fund, balance: '1' },
    { tokenId: ids.none, balance: '4' },
    { tokenId: ids.orphan, balance: '6' },
  ]);
});

afterAll(async () => {
  if (created.userIds.length)
    await db.delete(schema.users).where(inArray(schema.users.id, created.userIds));
  if (created.priceIds.length)
    await db.delete(schema.tokenPrices).where(inArray(schema.tokenPrices.id, created.priceIds));
  if (created.tokenIds.length)
    await db.delete(schema.tokens).where(inArray(schema.tokens.id, created.tokenIds));
  if (created.accountTypeId)
    await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, created.accountTypeId));
  if (created.institutionId)
    await db.delete(schema.institutions).where(eq(schema.institutions.id, created.institutionId));
  if (created.institutionTypeId)
    await db
      .delete(schema.institutionTypes)
      .where(eq(schema.institutionTypes.id, created.institutionTypeId));
});

describe('the live valuation priced by PriceReader', () => {
  test('a holding priced through a hub carries the reading’s time and the asset leg’s source', async () => {
    const h = holding(await value(eurUser), ids.hub!);
    expect(h.currentPrice).toBe('80');
    expect(h.priceTimestamp?.toISOString()).toBe(hoursBefore(5).toISOString());
    expect(h.priceSource).toBe('coingecko');
    expect(h.priceStale).toBe(false);
  });

  test('a holding whose only price is five days old is priced and stale (crypto)', async () => {
    const h = holding(await value(usdUser), ids.old!);
    expect(h.value).toBe('30');
    expect(h.priceStale).toBe(true);
  });

  test('CONTROL: a stock priced on Friday is not stale on Monday', async () => {
    const h = holding(await value(usdUser), ids.stock!);
    expect(h.value).toBe('100');
    expect(h.priceStale).toBe(false);
  });

  test('a manual price a year old is not stale', async () => {
    const h = holding(await value(usdUser), ids.fund!);
    expect(h.value).toBe('1000');
    expect(h.priceSource).toBe('manual');
    expect(h.priceStale).toBe(false);
  });

  test('a holding with no reading has value null and priceStale undefined', async () => {
    const h = holding(await value(usdUser), ids.none!);
    expect(h.value).toBeNull();
    expect(h.priceStale).toBeUndefined();
  });

  test('a holding whose FX leg is missing has value null, and the total leaves it out', async () => {
    const result = await value(usdUser);
    expect(holding(result, ids.orphan!).value).toBeNull();
    // 3 × 10 + 5 × 20 + 1 × 1000; the unpriced holdings add nothing.
    expect(result.totalValue).toBe('1130');
  });

  test('a newer reading through USD beats an older row in the user’s base (SC-1477)', async () => {
    const h = holding(await value(eurUser), ids.frozen!);
    expect(h.currentPrice).toBe('80');
    expect(h.priceTimestamp?.toISOString()).toBe(hoursBefore(5).toISOString());
  });

  test('CONTROL: cash in the base currency is 1, dated now, from the base currency', async () => {
    const h = holding(await value(eurUser), ids.eur!);
    expect(h.currentPrice).toBe('1');
    expect(h.priceTimestamp?.toISOString()).toBe(AT.toISOString());
    expect(h.priceSource).toBe('Base Currency');
    expect(h.priceStale).toBe(false);
  });
});
