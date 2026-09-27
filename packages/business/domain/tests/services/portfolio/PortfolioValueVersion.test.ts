process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { PortfolioValuationService } from '../../../src/services/portfolio/PortfolioValuationService';
import { PortfolioValueCache } from '../../../src/services/portfolio/PortfolioValueCache';
import { PortfolioValueVersion } from '../../../src/services/portfolio/PortfolioValueVersion';
import { PricingService } from '../../../src/services/pricing/PricingService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

restoreContainerAfterAll();

const suffix = randomUUID().slice(0, 6);
const T1 = new Date('2026-09-20T10:00:00Z');
const T2 = new Date('2026-09-20T11:00:00Z');

let userId: string;
let holdingId: string;
let baseId: string;
let assetId: string;
let unheldId: string;
let tokenTypeId: string;
let institutionId: string;
let institutionTypeId: string;
let accountTypeId: string;

async function makeToken(typeId: string, symbol: string): Promise<string> {
  const [token] = await db
    .insert(schema.tokens)
    .values({ symbol, name: symbol, typeId })
    .returning();
  if (!token) throw new Error(`token insert failed: ${symbol}`);
  return token.id;
}

// The upsert both `token_prices` writers use: a conflict rewrites `price` in
// place and leaves `created_at` alone.
async function setPrice(tokenId: string, price: string, timestamp: Date): Promise<void> {
  await db
    .insert(schema.tokenPrices)
    .values({ tokenId, baseTokenId: baseId, price, timestamp, source: 'coingecko' })
    .onConflictDoUpdate({
      target: [
        schema.tokenPrices.tokenId,
        schema.tokenPrices.baseTokenId,
        schema.tokenPrices.timestamp,
        schema.tokenPrices.granularity,
      ],
      set: { price },
    });
}

const version = () => new PortfolioValueVersion().read(userId);

beforeAll(async () => {
  const [tokenType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `pvv-${suffix}`, name: 'PVV Token Type' })
    .returning();
  tokenTypeId = tokenType!.id;
  baseId = await makeToken(tokenTypeId, `PVVEUR${suffix.toUpperCase()}`);
  assetId = await makeToken(tokenTypeId, `PVVBTC${suffix.toUpperCase()}`);
  unheldId = await makeToken(tokenTypeId, `PVVSOL${suffix.toUpperCase()}`);

  const [user] = await db
    .insert(schema.users)
    .values({ email: `pvv-${suffix}@scani.local`, name: 'PVV User', baseCurrencyId: baseId })
    .returning();
  userId = user!.id;

  const [institutionType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `pvv-inst-${suffix}`, name: 'PVV Institution Type' })
    .returning();
  institutionTypeId = institutionType!.id;
  const [institution] = await db
    .insert(schema.institutions)
    .values({ name: 'PVV Exchange', typeId: institutionTypeId })
    .returning();
  institutionId = institution!.id;
  const [accountType] = await db
    .insert(schema.accountTypes)
    .values({ code: `pvv-acct-${suffix}`, name: 'PVV Account Type' })
    .returning();
  accountTypeId = accountType!.id;
  const [account] = await db
    .insert(schema.accounts)
    .values({ userId, institutionId, name: 'PVV Account', typeId: accountTypeId })
    .returning();

  const [holding] = await db
    .insert(schema.holdings)
    .values({ userId, accountId: account!.id, tokenId: assetId, balance: '2' })
    .returning();
  holdingId = holding!.id;

  await setPrice(assetId, '60000', T1);
  await setPrice(unheldId, '150', T1);
});

afterAll(async () => {
  await db.delete(schema.users).where(eq(schema.users.id, userId));
  await db
    .delete(schema.tokenPrices)
    .where(inArray(schema.tokenPrices.tokenId, [baseId, assetId, unheldId]));
  await db.delete(schema.tokens).where(inArray(schema.tokens.id, [baseId, assetId, unheldId]));
  await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, tokenTypeId));
  await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, accountTypeId));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, institutionId));
  await db.delete(schema.institutionTypes).where(eq(schema.institutionTypes.id, institutionTypeId));
});

describe('PortfolioValueVersion (SC-1322)', () => {
  test('reads the same fingerprint twice over unchanged data', async () => {
    const first = await version();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(await version()).toBe(first);
  });

  test('a price rewritten IN PLACE for a held asset moves it — created_at never changes there', async () => {
    const before = await version();
    await setPrice(assetId, '61000', T1);
    const after = await version();
    expect(after).not.toBe(before);

    const [row] = await db
      .select({ createdAt: schema.tokenPrices.createdAt })
      .from(schema.tokenPrices)
      .where(and(eq(schema.tokenPrices.tokenId, assetId), eq(schema.tokenPrices.timestamp, T1)));
    expect(row).toBeDefined();
  });

  test('a newer price row for a held asset moves it', async () => {
    const before = await version();
    await setPrice(assetId, '61000', T2);
    expect(await version()).not.toBe(before);
  });

  test('a write that changes no value does not move it', async () => {
    const before = await version();
    await setPrice(assetId, '61000', T2);
    expect(await version()).toBe(before);
  });

  test('a price for a token the user does not hold does not move it', async () => {
    const before = await version();
    await setPrice(unheldId, '999', T2);
    expect(await version()).toBe(before);
  });

  test('a balance change moves it', async () => {
    const before = await version();
    await db.update(schema.holdings).set({ balance: '3' }).where(eq(schema.holdings.id, holdingId));
    expect(await version()).not.toBe(before);
  });
});

describe('PortfolioValuationService keys its cross-request cache on the version (SC-1322)', () => {
  const store = new Map<string, unknown>();
  let computed = 0;

  beforeAll(() => {
    Container.set(PricingService, {
      getCachedTokenPrices: async () => {
        computed += 1;
        return new Map([[assetId, '61000']]);
      },
    } as unknown as PricingService);
    Container.set(PortfolioValueCache, {
      getOrCompute: async (key: string, factory: () => Promise<unknown>) => {
        if (!store.has(key)) store.set(key, await factory());
        return store.get(key);
      },
      bust: async () => {},
    } as unknown as PortfolioValueCache);
    Container.set(PortfolioValuationService, new PortfolioValuationService());
  });

  afterAll(() => {
    Container.set(PricingService, new PricingService());
    Container.set(PortfolioValueCache, new PortfolioValueCache());
    Container.set(PortfolioValuationService, new PortfolioValuationService());
  });

  test('a reload over unchanged data is a hit; a price write for a held asset is a miss', async () => {
    const service = Container.get(PortfolioValuationService);

    await service.getUserPortfolioValue(userId);
    await service.getUserPortfolioValue(userId);
    expect(computed).toBe(1);

    await setPrice(assetId, '62000', T2);
    await service.getUserPortfolioValue(userId);
    expect(computed).toBe(2);
  });
});
