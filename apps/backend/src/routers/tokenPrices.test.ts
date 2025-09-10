import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { clearTestData, createTestData } from '../db/test-utils';
import { router } from '../trpc';
import { tokenPricesRouter } from './tokenPrices';
import { tokensRouter } from './tokens';

const appRouter = router({
  tokenPrices: tokenPricesRouter,
  tokens: tokensRouter,
});

// Type assertion for test operations (development/test environment uses SQLite)
const routerDb = db as ReturnType<typeof import('drizzle-orm/bun-sqlite').drizzle>;

// Test utility functions
const getTokens = async () => {
  return await routerDb.select().from(schema.tokens);
};

describe('tokenPrices router', () => {
  let testTokenId: string;
  let baseTokenId: string;

  beforeEach(async () => {
    await clearTestData();
    await createTestData();

    // Get existing tokens from test data instead of creating new ones
    const tokens = await getTokens();
    const btcToken = tokens.find((t) => t.symbol === 'BTC');
    const usdToken = tokens.find((t) => t.symbol === 'USD');

    if (!btcToken || !usdToken) {
      throw new Error('Required test tokens (BTC, USD) not found in test data');
    }

    testTokenId = btcToken.id;
    baseTokenId = usdToken.id;
  });

  describe('getAll', () => {
    test('should return empty array when no prices exist', async () => {
      const caller = appRouter.createCaller({});
      const result = await caller.tokenPrices.getAll();
      expect(result).toEqual([]);
    });

    test('should return all prices sorted by timestamp descending', async () => {
      const caller = appRouter.createCaller({});

      const price1 = await caller.tokenPrices.create({
        tokenId: testTokenId,
        baseTokenId: baseTokenId,
        price: 50000.0,
        timestamp: new Date('2024-01-01'),
        source: 'test',
      });

      const price2 = await caller.tokenPrices.create({
        tokenId: testTokenId,
        baseTokenId: baseTokenId,
        price: 60000.0,
        timestamp: new Date('2024-01-02'),
        source: 'test',
      });

      const result = await caller.tokenPrices.getAll();
      expect(result).toHaveLength(2);
      expect(result[0]?.id).toBe(price2.id); // Most recent first
      expect(result[1]?.id).toBe(price1.id);
    });
  });

  describe('getByTokenId', () => {
    test('should return prices for specific token', async () => {
      const caller = appRouter.createCaller({});

      // Get existing ETH token from test data
      const tokens = await getTokens();
      const ethToken = tokens.find((t) => t.symbol === 'ETH');
      if (!ethToken) throw new Error('ETH token not found in test data');

      await caller.tokenPrices.create({
        tokenId: testTokenId,
        baseTokenId: baseTokenId,
        price: 50000.0,
        timestamp: new Date(),
        source: 'test',
      });

      await caller.tokenPrices.create({
        tokenId: ethToken.id,
        baseTokenId: baseTokenId,
        price: 3000.0,
        timestamp: new Date(),
        source: 'test',
      });

      const result = await caller.tokenPrices.getByTokenId({
        tokenId: testTokenId,
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.tokenId).toBe(testTokenId);
    });
  });

  describe('getLatestByTokenId', () => {
    test('should return latest price for token', async () => {
      const caller = appRouter.createCaller({});

      await caller.tokenPrices.create({
        tokenId: testTokenId,
        baseTokenId: baseTokenId,
        price: 50000.0,
        timestamp: new Date('2024-01-01'),
        source: 'test',
      });

      const latestPrice = await caller.tokenPrices.create({
        tokenId: testTokenId,
        baseTokenId: baseTokenId,
        price: 60000.0,
        timestamp: new Date('2024-01-02'),
        source: 'test',
      });

      const result = await caller.tokenPrices.getLatestByTokenId({
        tokenId: testTokenId,
      });

      expect(result?.id).toBe(latestPrice.id);
      expect(result?.price).toBe(60000.0);
    });

    test('should filter by baseTokenId when provided', async () => {
      const caller = appRouter.createCaller({});

      // Use existing AAPL token as alternative base token
      const tokens = await getTokens();
      const aaplToken = tokens.find((t) => t.symbol === 'AAPL');
      if (!aaplToken) throw new Error('AAPL token not found in test data');

      await caller.tokenPrices.create({
        tokenId: testTokenId,
        baseTokenId: baseTokenId,
        price: 60000.0,
        timestamp: new Date('2024-01-02'),
        source: 'test',
      });

      const eurPrice = await caller.tokenPrices.create({
        tokenId: testTokenId,
        baseTokenId: aaplToken.id,
        price: 55000.0,
        timestamp: new Date('2024-01-03'),
        source: 'test',
      });

      const result = await caller.tokenPrices.getLatestByTokenId({
        tokenId: testTokenId,
        baseTokenId: aaplToken.id,
      });

      expect(result?.id).toBe(eurPrice.id);
      expect(result?.baseTokenId).toBe(aaplToken.id);
    });

    test('should return null when no prices exist', async () => {
      const caller = appRouter.createCaller({});

      const result = await caller.tokenPrices.getLatestByTokenId({
        tokenId: 'non-existent',
      });

      expect(result).toBeNull();
    });
  });

  describe('getByDateRange', () => {
    test('should return prices within date range', async () => {
      const caller = appRouter.createCaller({});

      await caller.tokenPrices.create({
        tokenId: testTokenId,
        baseTokenId: baseTokenId,
        price: 50000.0,
        timestamp: new Date('2024-01-01'),
        source: 'test',
      });

      const priceInRange = await caller.tokenPrices.create({
        tokenId: testTokenId,
        baseTokenId: baseTokenId,
        price: 55000.0,
        timestamp: new Date('2024-01-15'),
        source: 'test',
      });

      await caller.tokenPrices.create({
        tokenId: testTokenId,
        baseTokenId: baseTokenId,
        price: 60000.0,
        timestamp: new Date('2024-02-01'),
        source: 'test',
      });

      const result = await caller.tokenPrices.getByDateRange({
        tokenId: testTokenId,
        startDate: new Date('2024-01-10'),
        endDate: new Date('2024-01-20'),
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe(priceInRange.id);
    });
  });

  describe('getPriceAtTime', () => {
    test('should return price at or before specific timestamp', async () => {
      const caller = appRouter.createCaller({});

      const priceAtTime = await caller.tokenPrices.create({
        tokenId: testTokenId,
        baseTokenId: baseTokenId,
        price: 50000.0,
        timestamp: new Date('2024-01-15T10:00:00Z'),
        source: 'test',
      });

      await caller.tokenPrices.create({
        tokenId: testTokenId,
        baseTokenId: baseTokenId,
        price: 55000.0,
        timestamp: new Date('2024-01-15T14:00:00Z'),
        source: 'test',
      });

      const result = await caller.tokenPrices.getPriceAtTime({
        tokenId: testTokenId,
        timestamp: new Date('2024-01-15T12:00:00Z'),
      });

      expect(result?.id).toBe(priceAtTime.id);
      expect(result?.price).toBe(50000.0);
    });

    test('should return null when no prices before timestamp', async () => {
      const caller = appRouter.createCaller({});

      await caller.tokenPrices.create({
        tokenId: testTokenId,
        baseTokenId: baseTokenId,
        price: 50000.0,
        timestamp: new Date('2024-01-15'),
        source: 'test',
      });

      const result = await caller.tokenPrices.getPriceAtTime({
        tokenId: testTokenId,
        timestamp: new Date('2024-01-01'),
      });

      expect(result).toBeNull();
    });
  });

  describe('getById', () => {
    test('should return price by id', async () => {
      const caller = appRouter.createCaller({});

      const price = await caller.tokenPrices.create({
        tokenId: testTokenId,
        baseTokenId: baseTokenId,
        price: 50000.0,
        timestamp: new Date(),
        source: 'test',
      });

      const result = await caller.tokenPrices.getById({ id: price.id });
      expect(result.id).toBe(price.id);
      expect(result.price).toBe(50000.0);
    });

    test('should throw error when price not found', async () => {
      const caller = appRouter.createCaller({});

      await expect(caller.tokenPrices.getById({ id: 'non-existent' })).rejects.toThrow(
        'Token price not found'
      );
    });
  });

  describe('create', () => {
    test('should create token price with valid data', async () => {
      const caller = appRouter.createCaller({});

      const priceData = {
        tokenId: testTokenId,
        baseTokenId: baseTokenId,
        price: 50000.0,
        timestamp: new Date('2024-01-15'),
        source: 'test',
      };

      const result = await caller.tokenPrices.create(priceData);

      expect(result.tokenId).toBe(priceData.tokenId);
      expect(result.baseTokenId).toBe(priceData.baseTokenId);
      expect(result.price).toBe(priceData.price);
      expect(result.source).toBe(priceData.source);
      expect(result.id).toBeDefined();
      expect(result.createdAt).toBeInstanceOf(Date);
    });
  });

  describe('createBulk', () => {
    test('should create multiple token prices', async () => {
      const caller = appRouter.createCaller({});

      const pricesData = [
        {
          tokenId: testTokenId,
          baseTokenId: baseTokenId,
          price: 50000.0,
          timestamp: new Date('2024-01-01'),
          source: 'test',
        },
        {
          tokenId: testTokenId,
          baseTokenId: baseTokenId,
          price: 51000.0,
          timestamp: new Date('2024-01-02'),
          source: 'test',
        },
      ];

      const result = await caller.tokenPrices.createBulk(pricesData);

      expect(result).toHaveLength(2);
      expect(result[0]?.price).toBe(50000.0);
      expect(result[1]?.price).toBe(51000.0);
    });
  });

  describe('delete', () => {
    test('should delete token price', async () => {
      const caller = appRouter.createCaller({});

      const price = await caller.tokenPrices.create({
        tokenId: testTokenId,
        baseTokenId: baseTokenId,
        price: 50000.0,
        timestamp: new Date(),
        source: 'test',
      });

      const result = await caller.tokenPrices.delete({ id: price.id });

      expect(result.success).toBe(true);
      expect(result.deleted.id).toBe(price.id);

      // Verify price is deleted
      await expect(caller.tokenPrices.getById({ id: price.id })).rejects.toThrow(
        'Token price not found'
      );
    });

    test('should throw error when price not found', async () => {
      const caller = appRouter.createCaller({});

      await expect(caller.tokenPrices.delete({ id: 'non-existent' })).rejects.toThrow(
        'Token price not found'
      );
    });
  });

  describe('deleteOlderThan', () => {
    test('should delete prices older than cutoff date', async () => {
      const caller = appRouter.createCaller({});

      const oldPrice = await caller.tokenPrices.create({
        tokenId: testTokenId,
        baseTokenId: baseTokenId,
        price: 50000.0,
        timestamp: new Date('2024-01-01'),
        source: 'test',
      });

      const newPrice = await caller.tokenPrices.create({
        tokenId: testTokenId,
        baseTokenId: baseTokenId,
        price: 55000.0,
        timestamp: new Date('2024-01-15'),
        source: 'test',
      });

      const result = await caller.tokenPrices.deleteOlderThan({
        cutoffDate: new Date('2024-01-10'),
      });

      expect(result.success).toBe(true);
      expect(result.deletedCount).toBe(1);
      expect(result.deleted[0]?.id).toBe(oldPrice.id);

      // Verify old price is deleted and new price remains
      await expect(caller.tokenPrices.getById({ id: oldPrice.id })).rejects.toThrow(
        'Token price not found'
      );
      const remainingPrice = await caller.tokenPrices.getById({
        id: newPrice.id,
      });
      expect(remainingPrice.id).toBe(newPrice.id);
    });

    test('should filter by tokenId when provided', async () => {
      const caller = appRouter.createCaller({});

      // Use existing ETH token from test data
      const tokens = await getTokens();
      const ethToken = tokens.find((t) => t.symbol === 'ETH');
      if (!ethToken) throw new Error('ETH token not found in test data');

      const btcOldPrice = await caller.tokenPrices.create({
        tokenId: testTokenId,
        baseTokenId: baseTokenId,
        price: 50000.0,
        timestamp: new Date('2024-01-01'),
        source: 'test',
      });

      const ethOldPrice = await caller.tokenPrices.create({
        tokenId: ethToken.id,
        baseTokenId: baseTokenId,
        price: 3000.0,
        timestamp: new Date('2024-01-01'),
        source: 'test',
      });

      const result = await caller.tokenPrices.deleteOlderThan({
        cutoffDate: new Date('2024-01-10'),
        tokenId: testTokenId,
      });

      expect(result.success).toBe(true);
      expect(result.deletedCount).toBe(1);
      expect(result.deleted[0]?.id).toBe(btcOldPrice.id);

      // Verify only BTC price is deleted, ETH price remains
      await expect(caller.tokenPrices.getById({ id: btcOldPrice.id })).rejects.toThrow(
        'Token price not found'
      );
      const remainingEthPrice = await caller.tokenPrices.getById({
        id: ethOldPrice.id,
      });
      expect(remainingEthPrice.id).toBe(ethOldPrice.id);
    });
  });
});
