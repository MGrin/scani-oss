import { beforeEach, describe, expect, it } from 'bun:test';
import { db } from '../db/connection';
import type { Holding as DbHolding } from '../db/schema';
import * as schema from '../db/schema';
import { clearTestData, createTestData } from '../db/test-utils';
import { holdingsRouter } from './holdings';

// Set test database path
process.env.DB_PATH = './data/test.db';

// Type assertion for test operations (development/test environment uses SQLite)
const routerDb = db as ReturnType<typeof import('drizzle-orm/bun-sqlite').drizzle>;

// Test utility functions
const getHoldings = async () => {
  return await routerDb.select().from(schema.holdings);
};

const getAccounts = async () => {
  return await routerDb.select().from(schema.accounts);
};

const getTokens = async () => {
  return await routerDb.select().from(schema.tokens);
};

describe('Holdings Router', () => {
  let accountIds: string[] = [];
  let tokenIds: string[] = [];

  beforeEach(async () => {
    // Clear and reset test data
    await clearTestData();
    await createTestData();

    // Fetch test data IDs
    const accounts = await getAccounts();
    const tokens = await getTokens();
    accountIds = accounts.map((a) => a.id);
    tokenIds = tokens.map((t) => t.id);

    // Ensure we have enough test data
    if (accountIds.length < 2) {
      throw new Error(`Expected at least 2 accounts in test data, got ${accountIds.length}`);
    }
    if (tokenIds.length < 6) {
      throw new Error(`Expected at least 6 tokens in test data, got ${tokenIds.length}`);
    }
  });

  describe('getAll', () => {
    it('should return all holdings', async () => {
      const caller = holdingsRouter.createCaller({});
      const result = await caller.getAll();

      expect(Array.isArray(result)).toBe(true);
      // Check that each item has the expected holding structure
      result.forEach((holding: DbHolding) => {
        expect(holding).toHaveProperty('id');
        expect(holding).toHaveProperty('accountId');
        expect(holding).toHaveProperty('tokenId');
        expect(holding).toHaveProperty('balance');
        expect(holding).toHaveProperty('lastUpdated');
        expect(holding).toHaveProperty('createdAt');
      });
    });

    it('should return holdings sorted by lastUpdated desc', async () => {
      const caller = holdingsRouter.createCaller({});
      const result = await caller.getAll();

      if (result.length > 1) {
        for (let i = 1; i < result.length; i++) {
          const current = new Date(result[i].lastUpdated).getTime();
          const previous = new Date(result[i - 1].lastUpdated).getTime();
          expect(current).toBeLessThanOrEqual(previous);
        }
      }
    });
  });

  describe('getByAccountId', () => {
    it('should return holdings for specific account', async () => {
      const caller = holdingsRouter.createCaller({});

      // First create a holding using a combination that doesn't exist in seed data
      // Use account[0] with a token that's not already held in that account
      const createResult = await caller.create({
        accountId: accountIds[0],
        tokenId: tokenIds[2], // Use third token to avoid conflicts with seed data
        balance: 1000,
        lastUpdated: new Date(),
      });

      // Get holdings for this account
      const result = await caller.getByAccountId({ accountId: accountIds[0] });

      expect(Array.isArray(result)).toBe(true);
      const foundHolding = result.find((h: DbHolding) => h.id === createResult.id);
      expect(foundHolding).toBeDefined();
      expect(foundHolding?.accountId).toBe(accountIds[0]);
    });

    it('should return empty array for account with no holdings', async () => {
      const caller = holdingsRouter.createCaller({});
      const result = await caller.getByAccountId({
        accountId: 'non-existent-account',
      });

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });
  });

  describe('getByTokenId', () => {
    it('should return holdings for specific token', async () => {
      const caller = holdingsRouter.createCaller({});

      // Create a holding using a combination that doesn't conflict
      const createResult = await caller.create({
        accountId: accountIds[0],
        tokenId: tokenIds[3], // Use fourth token to avoid conflicts
        balance: 500,
        lastUpdated: new Date(),
      });

      // Get holdings for this token
      const result = await caller.getByTokenId({ tokenId: tokenIds[3] });

      expect(Array.isArray(result)).toBe(true);
      const foundHolding = result.find((h: DbHolding) => h.id === createResult.id);
      expect(foundHolding).toBeDefined();
      expect(foundHolding?.tokenId).toBe(tokenIds[3]);
    });
  });

  describe('getByAccountAndToken', () => {
    it('should return holding for specific account and token', async () => {
      const caller = holdingsRouter.createCaller({});

      // Create a holding with a non-conflicting combination
      const createResult = await caller.create({
        accountId: accountIds[0],
        tokenId: tokenIds[4], // Use fifth token to avoid conflicts
        balance: 1000,
        averageCostBasis: 50,
        lastUpdated: new Date(),
      });

      // Get holding by account and token
      const result = await caller.getByAccountAndToken({
        accountId: accountIds[0],
        tokenId: tokenIds[4],
      });

      expect(result.id).toBe(createResult.id);
      expect(result.accountId).toBe(accountIds[0]);
      expect(result.tokenId).toBe(tokenIds[4]);
      expect(result.balance).toBe(1000);
      expect(result.averageCostBasis).toBe(50);
    });

    it('should throw error when holding not found', async () => {
      const caller = holdingsRouter.createCaller({});

      await expect(
        caller.getByAccountAndToken({
          accountId: 'non-existent-account',
          tokenId: 'non-existent-token',
        })
      ).rejects.toThrow('Holding not found');
    });
  });

  describe('getById', () => {
    it('should return holding by ID', async () => {
      const caller = holdingsRouter.createCaller({});

      // Create a holding first
      const createResult = await caller.create({
        accountId: accountIds[0],
        tokenId: tokenIds[1], // Second token from seed data
        balance: 750,
        averageCostBasis: 1.1,
        lastUpdated: new Date(),
      });

      // Get it by ID
      const result = await caller.getById({ id: createResult.id });

      expect(result.id).toBe(createResult.id);
      expect(result.balance).toBe(750);
      expect(result.averageCostBasis).toBe(1.1);
    });

    it('should throw error for non-existent holding', async () => {
      const caller = holdingsRouter.createCaller({});

      await expect(caller.getById({ id: 'non-existent' })).rejects.toThrow('Holding not found');
    });
  });

  describe('create', () => {
    it('should create new holding with required fields', async () => {
      const caller = holdingsRouter.createCaller({});

      const input = {
        accountId: accountIds[0],
        tokenId: tokenIds[2], // Third token from seed data
        balance: 2000,
        lastUpdated: new Date('2023-06-01'),
      };

      const result = await caller.create(input);

      expect(result.accountId).toBe(input.accountId);
      expect(result.tokenId).toBe(input.tokenId);
      expect(result.balance).toBe(input.balance);
      expect(result.id).toBeDefined();
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.lastUpdated).toEqual(input.lastUpdated);
    });

    it('should create holding with optional averageCostBasis', async () => {
      const caller = holdingsRouter.createCaller({});

      const input = {
        accountId: accountIds[1],
        tokenId: tokenIds[3], // Fourth token from seed data
        balance: 0.5,
        averageCostBasis: 45000,
        lastUpdated: new Date(),
      };

      const result = await caller.create(input);

      expect(result.averageCostBasis).toBe(45000);
    });

    it('should allow negative balance for short positions', async () => {
      const caller = holdingsRouter.createCaller({});

      const input = {
        accountId: accountIds[0],
        tokenId: tokenIds[5], // Use sixth token to avoid conflicts
        balance: -100,
        lastUpdated: new Date(),
      };

      const result = await caller.create(input);

      expect(result.balance).toBe(-100);
    });

    it('should validate required fields', async () => {
      const caller = holdingsRouter.createCaller({});

      // Missing accountId should fail
      await expect(
        caller.create({
          tokenId: tokenIds[0],
          balance: 100,
          lastUpdated: new Date(),
        } as never)
      ).rejects.toThrow();

      // Missing tokenId should fail
      await expect(
        caller.create({
          accountId: accountIds[0],
          balance: 100,
          lastUpdated: new Date(),
        } as never)
      ).rejects.toThrow();

      // Missing balance should fail
      await expect(
        caller.create({
          accountId: accountIds[0],
          tokenId: tokenIds[0],
          lastUpdated: new Date(),
        } as never)
      ).rejects.toThrow();
    });
  });

  describe('update', () => {
    it('should update existing holding', async () => {
      const caller = holdingsRouter.createCaller({});

      // Create a holding first with non-conflicting combination
      // Use account 1 (Fidelity) with token 1 (BTC) - no conflict with seed data
      const created = await caller.create({
        accountId: accountIds[1], // Use second account (Fidelity)
        tokenId: tokenIds[1], // Use second token (BTC) - not in seed holdings
        balance: 100,
        lastUpdated: new Date(),
      });

      // Update it
      const updateData = {
        balance: 200,
        averageCostBasis: 15.5,
        lastUpdated: new Date('2023-07-01'),
      };

      const updated = await caller.update({
        id: created.id,
        data: updateData,
      });

      expect(updated.id).toBe(created.id);
      expect(updated.balance).toBe(200);
      expect(updated.averageCostBasis).toBe(15.5);
      expect(updated.lastUpdated).toEqual(updateData.lastUpdated);
    });

    it('should throw error for non-existent holding', async () => {
      const caller = holdingsRouter.createCaller({});

      await expect(
        caller.update({
          id: 'non-existent',
          data: { balance: 100 },
        })
      ).rejects.toThrow('Holding not found');
    });
  });

  describe('delete', () => {
    it('should delete holding', async () => {
      const caller = holdingsRouter.createCaller({});

      // Create a holding first with non-conflicting combination
      const created = await caller.create({
        accountId: accountIds[1], // Use second account
        tokenId: tokenIds[3], // Use fourth token
        balance: 250,
        lastUpdated: new Date(),
      });

      // Delete it
      const result = await caller.delete({ id: created.id });

      expect(result.success).toBe(true);
      expect(result.deleted.id).toBe(created.id);
    });

    it('should throw error for non-existent holding', async () => {
      const caller = holdingsRouter.createCaller({});

      await expect(caller.delete({ id: 'non-existent' })).rejects.toThrow('Holding not found');
    });

    it('should not return deleted holding in getAll', async () => {
      const caller = holdingsRouter.createCaller({});

      // Create and delete a holding with non-conflicting combination
      const created = await caller.create({
        accountId: accountIds[1],
        tokenId: tokenIds[4], // Use fifth token
        balance: 300,
        lastUpdated: new Date(),
      });

      await caller.delete({ id: created.id });

      // Should not appear in getAll results
      const allHoldings = await caller.getAll();
      const foundDeleted = allHoldings.find((h: DbHolding) => h.id === created.id);
      expect(foundDeleted).toBeUndefined();
    });
  });

  describe('edge cases and precision', () => {
    it('should handle very small balances', async () => {
      const caller = holdingsRouter.createCaller({});

      const result = await caller.create({
        accountId: accountIds[0],
        tokenId: tokenIds[3], // Fourth token with high precision
        balance: 0.00000001,
        lastUpdated: new Date(),
      });

      expect(result.balance).toBe(0.00000001);
    });

    it('should handle very large balances', async () => {
      const caller = holdingsRouter.createCaller({});

      const largeBalance = 999999999999.99;
      const result = await caller.create({
        accountId: accountIds[0], // Use first account (Chase)
        tokenId: tokenIds[1], // Use second token (BTC) - no conflict
        balance: largeBalance,
        lastUpdated: new Date(),
      });

      expect(result.balance).toBe(largeBalance);
    });

    it('should handle zero balance', async () => {
      const caller = holdingsRouter.createCaller({});

      const result = await caller.create({
        accountId: accountIds[1],
        tokenId: tokenIds[3], // Use different combination
        balance: 0,
        lastUpdated: new Date(),
      });

      expect(result.balance).toBe(0);
    });

    it('should update balance maintaining precision', async () => {
      const caller = holdingsRouter.createCaller({});

      // Create with initial balance
      const created = await caller.create({
        accountId: accountIds[0],
        tokenId: tokenIds[4], // Fifth token (ETH)
        balance: 1.23456789,
        lastUpdated: new Date(),
      });

      // Update with high precision value
      const updated = await caller.update({
        id: created.id,
        data: {
          balance: 2.987654321,
          lastUpdated: new Date(),
        },
      });

      expect(updated.balance).toBe(2.987654321);
    });
  });

  describe('updateBalance', () => {
    it('should update balance and cost basis', async () => {
      const caller = holdingsRouter.createCaller({});

      // Create holding with non-conflicting combination
      const created = await caller.create({
        accountId: accountIds[1],
        tokenId: tokenIds[4], // Use fifth token
        balance: 100,
        averageCostBasis: 10,
        lastUpdated: new Date(),
      });

      // Update balance and cost basis
      const updated = await caller.updateBalance({
        id: created.id,
        balance: 150,
        averageCostBasis: 12,
      });

      expect(updated.balance).toBe(150);
      expect(updated.averageCostBasis).toBe(12);
    });

    it('should update balance without changing cost basis', async () => {
      const caller = holdingsRouter.createCaller({});

      // Create holding with non-conflicting combination
      const created = await caller.create({
        accountId: accountIds[1],
        tokenId: tokenIds[5], // Use sixth token
        balance: 100,
        averageCostBasis: 10,
        lastUpdated: new Date(),
      });

      // Update only balance
      const updated = await caller.updateBalance({
        id: created.id,
        balance: 150,
      });

      expect(updated.balance).toBe(150);
      expect(updated.averageCostBasis).toBe(10); // Should remain unchanged
    });

    it('should throw error for non-existent holding', async () => {
      const caller = holdingsRouter.createCaller({});

      await expect(
        caller.updateBalance({
          id: 'non-existent-holding-id',
          balance: 100,
        })
      ).rejects.toThrow('Holding not found');
    });
  });

  describe('test utilities', () => {
    it('should reset data to sample holdings', async () => {
      // Reset should create holdings
      await clearTestData();
      await createTestData();

      const holdings = await getHoldings();
      expect(holdings.length).toBeGreaterThan(0);
    });

    it('should provide access to holdings array', async () => {
      const holdings = await getHoldings();
      expect(Array.isArray(holdings)).toBe(true);
    });
  });

  describe('business logic', () => {
    it('should allow multiple holdings of same token in different accounts', async () => {
      const caller = holdingsRouter.createCaller({});

      // Use a token that isn't already held by either account in seed data
      const holding1 = await caller.create({
        accountId: accountIds[0],
        tokenId: tokenIds[1], // Second token (EUR)
        balance: 1000,
        lastUpdated: new Date(),
      });

      const holding2 = await caller.create({
        accountId: accountIds[1],
        tokenId: tokenIds[1], // Same token, different account
        balance: 2000,
        lastUpdated: new Date(),
      });

      expect(holding1.id).not.toBe(holding2.id);
      expect(holding1.tokenId).toBe(holding2.tokenId);
      expect(holding1.accountId).not.toBe(holding2.accountId);
    });

    it('should handle cost basis calculations', async () => {
      const caller = holdingsRouter.createCaller({});

      // Create holding with cost basis
      const created = await caller.create({
        accountId: accountIds[0],
        tokenId: tokenIds[5], // Sixth token (AAPL if exists)
        balance: 100,
        averageCostBasis: 150.5,
        lastUpdated: new Date(),
      });

      // Update with new cost basis (e.g., after averaging down)
      const updated = await caller.update({
        id: created.id,
        data: {
          balance: 200, // doubled position
          averageCostBasis: 140.25, // averaged down
          lastUpdated: new Date(),
        },
      });

      expect(updated.balance).toBe(200);
      expect(updated.averageCostBasis).toBe(140.25);

      // Calculate total cost
      const totalCost = updated.balance * (updated.averageCostBasis || 0);
      expect(totalCost).toBe(28050); // 200 * 140.25
    });
  });
});
