import { beforeEach, describe, expect, test } from 'bun:test';
import { clearTestData } from '../db/test-utils';
import { router } from '../trpc';
import { tokensRouter } from './tokens';

const appRouter = router({ tokens: tokensRouter });

describe('tokens router', () => {
  beforeEach(async () => {
    await clearTestData();
  });

  describe('getAll', () => {
    test('should return empty array when no tokens exist', async () => {
      const caller = appRouter.createCaller({});
      const result = await caller.tokens.getAll();
      expect(result).toEqual([]);
    });

    test('should return all active tokens sorted by symbol', async () => {
      const caller = appRouter.createCaller({});

      // Create tokens in reverse alphabetical order to test sorting
      await caller.tokens.create({
        symbol: 'USD',
        name: 'US Dollar',
        type: 'fiat',
        decimals: 2,
      });

      await caller.tokens.create({
        symbol: 'BTC',
        name: 'Bitcoin',
        type: 'crypto',
        decimals: 8,
      });

      const result = await caller.tokens.getAll();
      expect(result).toHaveLength(2);
      expect(result[0]?.symbol).toBe('BTC'); // Should be sorted alphabetically
      expect(result[1]?.symbol).toBe('USD');
    });

    test('should not return inactive tokens', async () => {
      const caller = appRouter.createCaller({});

      const token = await caller.tokens.create({
        symbol: 'TEST',
        name: 'Test Token',
        type: 'crypto',
        decimals: 18,
      });

      // Soft delete the token
      await caller.tokens.delete({ id: token.id });

      const result = await caller.tokens.getAll();
      expect(result).toEqual([]);
    });
  });

  describe('getByType', () => {
    test('should return tokens of specific type', async () => {
      const caller = appRouter.createCaller({});

      await caller.tokens.create({
        symbol: 'USD',
        name: 'US Dollar',
        type: 'fiat',
        decimals: 2,
      });

      await caller.tokens.create({
        symbol: 'BTC',
        name: 'Bitcoin',
        type: 'crypto',
        decimals: 8,
      });

      const result = await caller.tokens.getByType({ type: 'fiat' });
      expect(result).toHaveLength(1);
      expect(result[0]?.type).toBe('fiat');
      expect(result[0]?.symbol).toBe('USD');
    });
  });

  describe('getById', () => {
    test('should return token by id', async () => {
      const caller = appRouter.createCaller({});

      const token = await caller.tokens.create({
        symbol: 'BTC',
        name: 'Bitcoin',
        type: 'crypto',
        decimals: 8,
      });

      const result = await caller.tokens.getById({ id: token.id });
      expect(result.id).toBe(token.id);
      expect(result.symbol).toBe('BTC');
      expect(result.name).toBe('Bitcoin');
    });

    test('should throw error when token not found', async () => {
      const caller = appRouter.createCaller({});

      await expect(caller.tokens.getById({ id: 'non-existent' })).rejects.toThrow(
        'Token not found'
      );
    });
  });

  describe('getBySymbol', () => {
    test('should return token by symbol', async () => {
      const caller = appRouter.createCaller({});

      const token = await caller.tokens.create({
        symbol: 'BTC',
        name: 'Bitcoin',
        type: 'crypto',
        decimals: 8,
      });

      const result = await caller.tokens.getBySymbol({ symbol: 'btc' }); // Test case insensitive
      expect(result.id).toBe(token.id);
      expect(result.symbol).toBe('BTC');
    });

    test('should throw error when token not found', async () => {
      const caller = appRouter.createCaller({});

      await expect(caller.tokens.getBySymbol({ symbol: 'NONEXISTENT' })).rejects.toThrow(
        'Token not found'
      );
    });
  });

  describe('create', () => {
    test('should create token with valid data', async () => {
      const caller = appRouter.createCaller({});

      const tokenData = {
        symbol: 'btc',
        name: 'Bitcoin',
        type: 'crypto' as const,
        decimals: 8,
      };

      const result = await caller.tokens.create(tokenData);

      expect(result.symbol).toBe('BTC'); // Should be uppercased
      expect(result.name).toBe(tokenData.name);
      expect(result.type).toBe(tokenData.type);
      expect(result.decimals).toBe(tokenData.decimals);
      expect(result.id).toBeDefined();
      expect(result.isActive).toBe(true);
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.updatedAt).toBeInstanceOf(Date);
    });

    test('should create token with all optional fields', async () => {
      const caller = appRouter.createCaller({});

      const tokenData = {
        symbol: 'BTC',
        name: 'Bitcoin',
        type: 'crypto' as const,
        decimals: 8,
        iconUrl: 'https://example.com/btc.png',
        isActive: false,
      };

      const result = await caller.tokens.create(tokenData);

      expect(result.iconUrl).toBe(tokenData.iconUrl);
      expect(result.isActive).toBe(tokenData.isActive);
    });

    test('should throw error for duplicate symbol', async () => {
      const caller = appRouter.createCaller({});

      const tokenData = {
        symbol: 'BTC',
        name: 'Bitcoin',
        type: 'crypto' as const,
        decimals: 8,
      };

      await caller.tokens.create(tokenData);

      await expect(caller.tokens.create(tokenData)).rejects.toThrow(
        'Token with this symbol already exists'
      );
    });
  });

  describe('update', () => {
    test('should update token with valid data', async () => {
      const caller = appRouter.createCaller({});

      const token = await caller.tokens.create({
        symbol: 'BTC',
        name: 'Bitcoin',
        type: 'crypto',
        decimals: 8,
      });

      const updateData = {
        name: 'Bitcoin Updated',
        iconUrl: 'https://example.com/btc-updated.png',
      };

      const result = await caller.tokens.update({
        id: token.id,
        data: updateData,
      });

      expect(result.id).toBe(token.id);
      expect(result.name).toBe('Bitcoin Updated');
      expect(result.iconUrl).toBe('https://example.com/btc-updated.png');
      expect(result.symbol).toBe(token.symbol); // Should remain unchanged
      expect(result.updatedAt).toBeInstanceOf(Date);
      expect(result.updatedAt.getTime()).toBeGreaterThanOrEqual(token.updatedAt.getTime());
    });

    test('should update symbol and uppercase it', async () => {
      const caller = appRouter.createCaller({});

      const token = await caller.tokens.create({
        symbol: 'OLD',
        name: 'Old Token',
        type: 'crypto',
        decimals: 8,
      });

      const result = await caller.tokens.update({
        id: token.id,
        data: { symbol: 'new' },
      });

      expect(result.symbol).toBe('NEW');
    });

    test('should throw error when token not found', async () => {
      const caller = appRouter.createCaller({});

      await expect(
        caller.tokens.update({
          id: 'non-existent',
          data: { name: 'New Name' },
        })
      ).rejects.toThrow('Token not found');
    });

    test('should throw error for duplicate symbol on update', async () => {
      const caller = appRouter.createCaller({});

      await caller.tokens.create({
        symbol: 'BTC',
        name: 'Bitcoin',
        type: 'crypto',
        decimals: 8,
      });

      const token2 = await caller.tokens.create({
        symbol: 'ETH',
        name: 'Ethereum',
        type: 'crypto',
        decimals: 18,
      });

      await expect(
        caller.tokens.update({
          id: token2.id,
          data: { symbol: 'BTC' },
        })
      ).rejects.toThrow('Token with this symbol already exists');
    });
  });

  describe('delete', () => {
    test('should soft delete token', async () => {
      const caller = appRouter.createCaller({});

      const token = await caller.tokens.create({
        symbol: 'BTC',
        name: 'Bitcoin',
        type: 'crypto',
        decimals: 8,
      });

      const result = await caller.tokens.delete({ id: token.id });

      expect(result.success).toBe(true);
      expect(result.deleted.id).toBe(token.id);
      expect(result.deleted.isActive).toBe(false);

      // Verify token is not returned in getAll (soft deleted)
      const allTokens = await caller.tokens.getAll();
      expect(allTokens).toHaveLength(0);

      // But should still be found by ID if we query directly
      const deletedToken = await caller.tokens.getById({ id: token.id });
      expect(deletedToken.isActive).toBe(false);
    });

    test('should throw error when token not found', async () => {
      const caller = appRouter.createCaller({});

      await expect(caller.tokens.delete({ id: 'non-existent' })).rejects.toThrow('Token not found');
    });
  });
});
