process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { and, eq, inArray, or } from 'drizzle-orm';
import { Container } from 'typedi';
import { PortfolioValuationService } from '../../../src/services/portfolio/PortfolioValuationService';
import { PortfolioValueCache } from '../../../src/services/portfolio/PortfolioValueCache';
import { PortfolioValueVersion } from '../../../src/services/portfolio/PortfolioValueVersion';
import { PriceHubResolver } from '../../../src/services/pricing/PriceHubResolver';
import { PriceReader } from '../../../src/services/pricing/PriceReader';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { seedHoldingCache } from '../../../test/helpers/engine-guard';

restoreContainerAfterAll();

const suffix = randomUUID().slice(0, 6);
const T1 = new Date('2026-09-20T10:00:00Z');
const T2 = new Date('2026-09-20T11:00:00Z');

let userId: string;
let holdingId: string;
let baseId: string;
let assetId: string;
let unheldId: string;
let quoteId: string;
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

let pairWrites = 0;

/** A reading of any pair, at a stamp no other write here uses. */
async function setPair(tokenId: string, baseTokenId: string, price: string): Promise<void> {
  pairWrites += 1;
  await db.insert(schema.tokenPrices).values({
    tokenId,
    baseTokenId,
    price,
    timestamp: new Date(T2.getTime() + pairWrites * 60_000),
    source: 'coingecko',
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
  quoteId = await makeToken(tokenTypeId, `PVVCHF${suffix.toUpperCase()}`);

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

  const [holding] = await seedHoldingCache(db, (calculator) =>
    calculator
      .insert(schema.holdings)
      .values({ userId, accountId: account!.id, tokenId: assetId, balance: '2' })
      .returning()
  );
  holdingId = holding!.id;

  await setPrice(assetId, '60000', T1);
  await setPrice(unheldId, '150', T1);
});

afterAll(async () => {
  await db.delete(schema.users).where(eq(schema.users.id, userId));
  const made = [baseId, assetId, unheldId, quoteId];
  await db
    .delete(schema.tokenPrices)
    .where(
      or(inArray(schema.tokenPrices.tokenId, made), inArray(schema.tokenPrices.baseTokenId, made))
    );
  await db.delete(schema.tokens).where(inArray(schema.tokens.id, made));
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

  // Every pair `PriceReader` could read to value the holding, not only the
  // forward ones: a route takes an inverse leg or a hub as readily (Task 16).
  test('the version changes when an inverse or a hub leg gets a new reading', async () => {
    const usdId = await Container.get(PriceHubResolver).usdTokenId();

    let before = await version();
    await setPair(baseId, assetId, '2');
    expect(await version()).not.toBe(before);

    before = await version();
    await setPair(usdId, assetId, '3');
    expect(await version()).not.toBe(before);
  });

  test('once the asset is quoted in a currency, that currency’s leg to the base moves it', async () => {
    await setPair(assetId, quoteId, '4');
    const before = await version();
    await setPair(quoteId, baseId, '5');
    expect(await version()).not.toBe(before);
  });

  test('a balance change moves it', async () => {
    const before = await version();
    await seedHoldingCache(db, (calculator) =>
      calculator
        .update(schema.holdings)
        .set({ balance: '3' })
        .where(eq(schema.holdings.id, holdingId))
    );
    expect(await version()).not.toBe(before);
  });
});

describe('PortfolioValueVersion sees a transfer answered internal (SC-1675)', () => {
  test('answering an outflow internal moves it, though no balance changed', async () => {
    const [outflow] = await db
      .insert(schema.holdingTransactions)
      .values({
        userId,
        holdingId,
        tokenId: assetId,
        kind: 'withdraw',
        quantity: '-1',
        occurredAt: T1,
        source: 'test-fixture',
        externalId: `pvv-out-${suffix}`,
      })
      .returning();
    const unanswered = await version();
    await db
      .update(schema.holdingTransactions)
      .set({ transferReview: 'internal', transferGroupId: randomUUID(), transferReviewedAt: T2 })
      .where(eq(schema.holdingTransactions.id, outflow!.id));
    expect(await version()).not.toBe(unanswered);
  });
});

describe('PortfolioValuationService keys its cross-request cache on the version (SC-1322)', () => {
  const store = new Map<string, unknown>();
  let computed = 0;

  beforeAll(() => {
    Container.set(PriceReader, {
      at: async (tokenIds: readonly string[]) => {
        computed += 1;
        return new Map(tokenIds.map((tokenId) => [tokenId, null]));
      },
    } as unknown as PriceReader);
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
    Container.set(PriceReader, new PriceReader());
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
