import { beforeEach, describe, expect, test } from 'bun:test';
import { UpdateUserSchema } from '@scani/shared/types';
import { clearTestData } from '../db/test-utils';
import { router } from '../trpc';
import { usersRouter } from './users';

const appRouter = router({ users: usersRouter });

describe('users router', () => {
  beforeEach(async () => {
    await clearTestData();
  });

  describe('getAll', () => {
    test('should return empty array when no users exist', async () => {
      const caller = appRouter.createCaller({});
      const result = await caller.users.getAll();
      expect(result).toEqual([]);
    });

    test('should return all users', async () => {
      const caller = appRouter.createCaller({});

      // Create two users
      const user1 = await caller.users.create({
        name: 'Alice',
        email: 'alice@example.com',
      });

      const user2 = await caller.users.create({
        name: 'Bob',
        email: 'bob@example.com',
      });

      const result = await caller.users.getAll();
      expect(result).toHaveLength(2);
      expect(result.find((u) => u.id === user1.id)).toBeDefined();
      expect(result.find((u) => u.id === user2.id)).toBeDefined();
    });
  });

  describe('getById', () => {
    test('should return user by id', async () => {
      const caller = appRouter.createCaller({});

      const user = await caller.users.create({
        name: 'Alice',
        email: 'alice@example.com',
      });

      const result = await caller.users.getById({ id: user.id });
      expect(result.id).toBe(user.id);
      expect(result.name).toBe('Alice');
      expect(result.email).toBe('alice@example.com');
    });

    test('should throw error when user not found', async () => {
      const caller = appRouter.createCaller({});

      await expect(caller.users.getById({ id: 'non-existent' })).rejects.toThrow('User not found');
    });
  });

  describe('create', () => {
    test('should create user with valid data', async () => {
      const caller = appRouter.createCaller({});

      const userData = {
        name: 'Alice',
        email: 'alice@example.com',
      };

      const result = await caller.users.create(userData);

      expect(result.name).toBe(userData.name);
      expect(result.email).toBe(userData.email);
      expect(result.id).toBeDefined();
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.updatedAt).toBeInstanceOf(Date);
    });

    test('should create user with all optional fields', async () => {
      const caller = appRouter.createCaller({});

      const userData = {
        name: 'Bob Smith',
        email: 'bob@example.com',
        avatar: 'https://example.com/avatar.jpg',
        baseCurrency: 'EUR' as const,
      };

      const result = await caller.users.create(userData);

      expect(result.id).toBeDefined();
      expect(result.name).toBe(userData.name);
      expect(result.email).toBe(userData.email);
      expect(result.avatar).toBe(userData.avatar);
      expect(result.baseCurrency).toBe(userData.baseCurrency);
    });

    test('should throw error for duplicate email', async () => {
      const caller = appRouter.createCaller({});

      const userData = {
        name: 'Alice',
        email: 'alice@example.com',
      };

      await caller.users.create(userData);

      await expect(caller.users.create(userData)).rejects.toThrow(
        'User with this email already exists'
      );
    });
  });

  describe('update', () => {
    test('should update user with valid data', async () => {
      const caller = appRouter.createCaller({});

      const user = await caller.users.create({
        name: 'Alice',
        email: 'alice@example.com',
      });

      const updateData = {
        name: 'Alice Updated',
        baseCurrency: 'EUR' as const,
      };

      const result = await caller.users.update({
        id: user.id,
        data: updateData,
      });

      expect(result.id).toBe(user.id);
      expect(result.name).toBe('Alice Updated');
      expect(result.baseCurrency).toBe('EUR');
      expect(result.email).toBe(user.email); // Should remain unchanged
      expect(result.updatedAt).toBeInstanceOf(Date);
      expect(result.updatedAt.getTime()).toBeGreaterThanOrEqual(user.updatedAt.getTime());
    });

    test('should throw error when user not found', async () => {
      const caller = appRouter.createCaller({});

      await expect(
        caller.users.update({
          id: 'non-existent',
          data: { name: 'New Name' },
        })
      ).rejects.toThrow('User not found');
    });

    test('should not allow email to be updated', async () => {
      const caller = appRouter.createCaller({});

      const user = await caller.users.create({
        name: 'Alice',
        email: 'alice@example.com',
      });

      // Attempt to update with email field should be prevented by schema validation
      // The UpdateUserSchema should not include email field
      const updateData = {
        name: 'Alice Updated',
        // email: 'new-email@example.com', // This should not be allowed by the schema
      };

      const result = await caller.users.update({
        id: user.id,
        data: updateData,
      });

      // Email should remain unchanged
      expect(result.email).toBe('alice@example.com');
      expect(result.name).toBe('Alice Updated');
    });

    test('should validate that UpdateUserSchema only allows updatable fields', () => {
      // This test verifies that the schema only allows name, avatar, and baseCurrency
      const updateDataWithDisallowedFields = {
        name: 'Updated Name',
        avatar: 'https://example.com/new-avatar.jpg',
        baseCurrency: 'EUR' as const,
        email: 'new@example.com', // This should be stripped/ignored
        id: 'fake-id', // This should be stripped/ignored
        createdAt: new Date(), // This should be stripped/ignored
        updatedAt: new Date(), // This should be stripped/ignored
      };

      // Parse the data and verify only allowed fields are included
      const parsedData = UpdateUserSchema.parse(updateDataWithDisallowedFields);

      expect(parsedData).toHaveProperty('name', 'Updated Name');
      expect(parsedData).toHaveProperty('avatar', 'https://example.com/new-avatar.jpg');
      expect(parsedData).toHaveProperty('baseCurrency', 'EUR');

      // These fields should not be present in the parsed data
      expect(parsedData).not.toHaveProperty('email');
      expect(parsedData).not.toHaveProperty('id');
      expect(parsedData).not.toHaveProperty('createdAt');
      expect(parsedData).not.toHaveProperty('updatedAt');
    });
  });

  describe('delete', () => {
    test('should delete user', async () => {
      const caller = appRouter.createCaller({});

      const user = await caller.users.create({
        name: 'Alice',
        email: 'alice@example.com',
      });

      const result = await caller.users.delete({ id: user.id });

      expect(result.success).toBe(true);
      expect(result.deleted.id).toBe(user.id);

      // Verify user is deleted
      await expect(caller.users.getById({ id: user.id })).rejects.toThrow('User not found');
    });

    test('should throw error when user not found', async () => {
      const caller = appRouter.createCaller({});

      await expect(caller.users.delete({ id: 'non-existent' })).rejects.toThrow('User not found');
    });
  });

  describe('getSupportedCurrencies', () => {
    test('should return list of supported currencies', async () => {
      const caller = appRouter.createCaller({});

      const result = await caller.users.getSupportedCurrencies();

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);

      // Check that each currency has the required properties
      result.forEach((currency) => {
        expect(currency).toHaveProperty('code');
        expect(currency).toHaveProperty('name');
        expect(currency).toHaveProperty('symbol');
        expect(typeof currency.code).toBe('string');
        expect(typeof currency.name).toBe('string');
        expect(typeof currency.symbol).toBe('string');
      });

      // Check that USD is included
      const usd = result.find((c) => c.code === 'USD');
      expect(usd).toBeDefined();
      expect(usd?.name).toBe('US Dollar');
      expect(usd?.symbol).toBe('$');

      // Check that currencies are sorted by name
      for (let i = 1; i < result.length; i++) {
        expect(result[i].name.localeCompare(result[i - 1].name)).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
