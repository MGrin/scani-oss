import { beforeEach, describe, expect, it } from 'bun:test';
import type { Account } from '@scani/shared/types';
import { eq } from 'drizzle-orm';
import { db } from '../db/connection';
import type { Account as DbAccount } from '../db/schema';
import * as schema from '../db/schema';
import { clearTestData, createTestData } from '../db/test-utils';
import { accountsRouter } from './accounts';

// Type assertion for test operations (development/test environment uses SQLite)
const routerDb = db as ReturnType<typeof import('drizzle-orm/bun-sqlite').drizzle>;

// Set test database path
process.env.DB_PATH = './data/test.db';

// Test utility functions
const getAccounts = async () => {
  return await routerDb.select().from(schema.accounts);
};

const getInstitutions = async () => {
  return await routerDb.select().from(schema.institutions);
};

// Mock data for tests
const _mockInstitution = {
  id: 'mock-inst-1',
  userId: 'user-1',
  name: 'Test Bank',
  type: 'bank' as const,
  isActive: true,
  createdAt: new Date('2023-01-01'),
  updatedAt: new Date('2023-01-01'),
};

const _mockAccount: Account = {
  id: 'acc-1',
  institutionId: 'mock-inst-1',
  name: 'Test Checking',
  type: 'checking',
  description: 'Test account',
  isActive: true,
  createdAt: new Date('2023-01-01'),
  updatedAt: new Date('2023-01-01'),
};

describe('Accounts Router', () => {
  let testInstitutionId: string;
  let testInstitutionId2: string;

  beforeEach(async () => {
    // Clear data between tests for isolation and seed test data
    await clearTestData();
    await createTestData();

    // Get institution IDs from seeded data
    const institutions = await getInstitutions();
    if (institutions.length < 2) {
      throw new Error(`Expected at least 2 institutions in test data, got ${institutions.length}`);
    }
    testInstitutionId = institutions[0].id;
    testInstitutionId2 = institutions[1].id;
  });

  describe('getAll', () => {
    it('should return all active accounts', async () => {
      const caller = accountsRouter.createCaller({});
      const result = await caller.getAll();

      expect(Array.isArray(result)).toBe(true);
      // Should only return active accounts
      result.forEach((account: DbAccount) => {
        expect(account.isActive).toBe(true);
      });
    });

    it('should return accounts sorted by name', async () => {
      const caller = accountsRouter.createCaller({});
      const result = await caller.getAll();

      if (result.length > 1) {
        for (let i = 1; i < result.length; i++) {
          expect(result[i]).toBeDefined();
          expect(result[i - 1]).toBeDefined();
          if (result[i] && result[i - 1]) {
            expect(result[i].name >= result[i - 1].name).toBe(true);
          }
        }
      }
    });
  });

  describe('getById', () => {
    it('should return account by ID', async () => {
      const caller = accountsRouter.createCaller({});

      // First create an account
      const createResult = await caller.create({
        institutionId: testInstitutionId,
        name: 'Test Account',
        type: 'checking',
        description: 'Test description',
      });

      expect(createResult).toBeDefined();
      if (!createResult) throw new Error('Failed to create account for test');

      // Then get it by ID
      const result = await caller.getById({ id: createResult.id });

      expect(result.id).toBe(createResult.id);
      expect(result.name).toBe('Test Account');
      expect(result.type).toBe('checking');
    });

    it('should throw error for non-existent account', async () => {
      const caller = accountsRouter.createCaller({});

      await expect(caller.getById({ id: 'non-existent' })).rejects.toThrow('Account not found');
    });
  });

  describe('create', () => {
    it('should create new account with required fields', async () => {
      const caller = accountsRouter.createCaller({});

      const input = {
        institutionId: testInstitutionId,
        name: 'New Account',
        type: 'savings' as const,
      };

      const result = await caller.create(input);

      expect(result).toBeDefined();
      expect(result?.institutionId).toBe(input.institutionId);
      expect(result?.name).toBe(input.name);
      expect(result?.type).toBe(input.type);
      expect(result?.isActive).toBe(true); // default value
      expect(result?.id).toBeDefined();
      expect(result?.createdAt).toBeInstanceOf(Date);
      expect(result?.updatedAt).toBeInstanceOf(Date);
    });

    it('should create account with optional fields', async () => {
      const caller = accountsRouter.createCaller({});

      const input = {
        institutionId: testInstitutionId,
        name: 'Detailed Account',
        type: 'investment' as const,
        description: 'Investment account for retirement',
        accountNumber: '***1234',
      };

      const result = await caller.create(input);

      expect(result).toBeDefined();
      expect(result?.description).toBe(input.description);
      expect(result?.accountNumber).toBe(input.accountNumber);
    });

    it('should validate account type', async () => {
      const caller = accountsRouter.createCaller({});

      const input = {
        institutionId: testInstitutionId,
        name: 'Invalid Account',
        type: 'invalid_type' as never,
      };

      await expect(caller.create(input)).rejects.toThrow();
    });

    it('should prevent creating accounts with duplicate names in same institution', async () => {
      const caller = accountsRouter.createCaller({});

      // Create first account
      const firstAccount = await caller.create({
        institutionId: testInstitutionId,
        name: 'Duplicate Test Account',
        type: 'checking',
      });

      expect(firstAccount).toBeDefined();

      // Try to create account with same name in same institution
      await expect(
        caller.create({
          institutionId: testInstitutionId,
          name: 'Duplicate Test Account',
          type: 'savings',
        })
      ).rejects.toThrow('An account with this name already exists in this institution');
    });

    it('should allow creating accounts with same name in different institutions', async () => {
      const caller = accountsRouter.createCaller({});

      // Create first account in inst-1
      const firstAccount = await caller.create({
        institutionId: testInstitutionId,
        name: 'Same Name Different Institution',
        type: 'checking',
      });

      expect(firstAccount).toBeDefined();

      // Create account with same name in different institution
      const secondAccount = await caller.create({
        institutionId: testInstitutionId2,
        name: 'Same Name Different Institution',
        type: 'savings',
      });

      expect(secondAccount).toBeDefined();
      if (secondAccount) {
        expect(secondAccount.name).toBe('Same Name Different Institution');
        expect(secondAccount.institutionId).toBe(testInstitutionId2);
      }
    });

    it('should trim account name and validate uniqueness on trimmed version', async () => {
      const caller = accountsRouter.createCaller({});

      // Create first account
      await caller.create({
        institutionId: testInstitutionId,
        name: 'Trimmed Account',
        type: 'checking',
      });

      // Try to create account with same name but with spaces
      await expect(
        caller.create({
          institutionId: testInstitutionId,
          name: '  Trimmed Account  ',
          type: 'savings',
        })
      ).rejects.toThrow('An account with this name already exists in this institution');
    });

    it('should require required fields', async () => {
      const caller = accountsRouter.createCaller({});

      // Missing name
      await expect(
        caller.create({
          institutionId: testInstitutionId,
          type: 'checking' as const,
        } as never)
      ).rejects.toThrow();

      // Missing institutionId
      await expect(
        caller.create({
          name: 'Test Account',
          type: 'checking' as const,
        } as never)
      ).rejects.toThrow();

      // Missing type
      await expect(
        caller.create({
          institutionId: testInstitutionId,
          name: 'Test Account',
        } as never)
      ).rejects.toThrow();
    });
  });

  describe('update', () => {
    it('should update existing account', async () => {
      const caller = accountsRouter.createCaller({});

      // Create account first
      const created = await caller.create({
        institutionId: testInstitutionId,
        name: 'Original Name',
        type: 'checking',
      });

      expect(created).toBeDefined();
      if (!created) throw new Error('Failed to create account');

      // Update it
      const updateData = {
        name: 'Updated Name',
        description: 'Updated description',
      };

      const result = await caller.update({
        id: created.id,
        data: updateData,
      });

      expect(result.name).toBe('Updated Name');
      expect(result.description).toBe('Updated description');
      expect(result.id).toBe(created.id);
      expect(result.type).toBe('checking'); // unchanged
      expect(result.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
    });

    it('should throw error for non-existent account', async () => {
      const caller = accountsRouter.createCaller({});

      await expect(
        caller.update({
          id: 'non-existent',
          data: { name: 'New Name' },
        })
      ).rejects.toThrow('Account not found');
    });

    it('should validate update data types', async () => {
      const caller = accountsRouter.createCaller({});

      // Create account first
      const created = await caller.create({
        institutionId: testInstitutionId,
        name: 'Test Account',
        type: 'checking',
      });

      expect(created).toBeDefined();
      if (!created) throw new Error('Failed to create account');

      // Try to update with invalid type
      await expect(
        caller.update({
          id: created.id,
          data: { type: 'invalid_type' as never },
        })
      ).rejects.toThrow();
    });

    it('should prevent updating to duplicate name in same institution', async () => {
      const caller = accountsRouter.createCaller({});

      // Create two accounts
      const account1 = await caller.create({
        institutionId: testInstitutionId,
        name: 'Account One',
        type: 'checking',
      });

      const account2 = await caller.create({
        institutionId: testInstitutionId,
        name: 'Account Two',
        type: 'savings',
      });

      expect(account1).toBeDefined();
      expect(account2).toBeDefined();
      if (!account1 || !account2) throw new Error('Failed to create accounts for test');

      // Try to update account2 to have same name as account1
      await expect(
        caller.update({
          id: account2.id,
          data: { name: 'Account One' },
        })
      ).rejects.toThrow('An account with this name already exists in this institution');
    });

    it('should allow updating to same name in different institution', async () => {
      const caller = accountsRouter.createCaller({});

      // Create account in inst-1
      await caller.create({
        institutionId: testInstitutionId,
        name: 'Same Name Update Test',
        type: 'checking',
      });

      // Create account in inst-2
      const account2 = await caller.create({
        institutionId: testInstitutionId2,
        name: 'Different Name',
        type: 'savings',
      });

      expect(account2).toBeDefined();
      if (!account2) throw new Error('Failed to create account for test');

      // Update account2 to have same name as account in inst-1 (should work)
      const updated = await caller.update({
        id: account2.id,
        data: { name: 'Same Name Update Test' },
      });

      expect(updated.name).toBe('Same Name Update Test');
      expect(updated.institutionId).toBe(testInstitutionId2);
    });

    it('should allow updating account to keep the same name', async () => {
      const caller = accountsRouter.createCaller({});

      // Create account
      const account = await caller.create({
        institutionId: testInstitutionId,
        name: 'Keep Same Name',
        type: 'checking',
      });

      expect(account).toBeDefined();
      if (!account) throw new Error('Failed to create account for test');

      // Update account with same name but different description
      const updated = await caller.update({
        id: account.id,
        data: {
          name: 'Keep Same Name',
          description: 'Updated description',
        },
      });

      expect(updated.name).toBe('Keep Same Name');
      expect(updated.description).toBe('Updated description');
    });
  });

  describe('delete', () => {
    it('should hard delete account and cascade to holdings and transactions', async () => {
      const caller = accountsRouter.createCaller({});

      // Create account first
      const created = await caller.create({
        institutionId: testInstitutionId,
        name: 'To Delete',
        type: 'checking',
      });

      expect(created).toBeDefined();
      if (!created) throw new Error('Failed to create account');
      expect(created.isActive).toBe(true);

      // Delete it
      const result = await caller.delete({ id: created.id });

      expect(result.success).toBe(true);
      expect(result.deleted.id).toBe(created.id);
      expect(result.cascadeInfo).toBeDefined();
      expect(typeof result.cascadeInfo.holdingsDeleted).toBe('number');
      expect(typeof result.cascadeInfo.transactionsDeleted).toBe('number');

      // Verify account is completely removed from database
      await expect(caller.getById({ id: created.id })).rejects.toThrow('Account not found');
    });

    it('should throw error for non-existent account', async () => {
      const caller = accountsRouter.createCaller({});

      await expect(caller.delete({ id: 'non-existent' })).rejects.toThrow('Account not found');
    });

    it('should not return deleted accounts in getAll', async () => {
      const caller = accountsRouter.createCaller({});

      // Create and then delete an account
      const created = await caller.create({
        institutionId: testInstitutionId,
        name: 'Will Delete',
        type: 'checking',
      });

      expect(created).toBeDefined();
      if (!created) throw new Error('Failed to create account for test');

      await caller.delete({ id: created.id });

      // Should not appear in getAll results (because it's hard deleted)
      const allAccounts = await caller.getAll();
      const foundDeleted = allAccounts.find((acc: DbAccount) => acc.id === created.id);
      expect(foundDeleted).toBeUndefined();
    });

    it('should delete account with linked holdings (cascade delete)', async () => {
      const caller = accountsRouter.createCaller({});

      // Create an account
      const account = await caller.create({
        institutionId: testInstitutionId,
        name: 'Account with Holdings',
        type: 'checking',
      });

      expect(account).toBeDefined();
      if (!account) throw new Error('Failed to create account for test');

      // Get a token ID from the seeded data
      const tokens = await routerDb.select().from(schema.tokens).limit(1);
      expect(tokens.length).toBeGreaterThan(0);
      const tokenId = tokens[0].id;

      // Create a holding for this account
      const holdingData = {
        id: 'holding-test-1',
        accountId: account.id,
        tokenId: tokenId,
        balance: 1000,
        lastUpdated: new Date(),
        createdAt: new Date(),
      };

      // Insert holding directly into DB
      await routerDb.insert(schema.holdings).values(holdingData);

      // Delete account should succeed and cascade to holdings
      const result = await caller.delete({ id: account.id });

      expect(result.success).toBe(true);
      expect(result.deleted.id).toBe(account.id);
      expect(result.cascadeInfo.holdingsDeleted).toBe(1);

      // Verify both account and holdings are deleted
      await expect(caller.getById({ id: account.id })).rejects.toThrow('Account not found');

      const remainingHoldings = await routerDb
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.accountId, account.id));
      expect(remainingHoldings).toHaveLength(0);
    });

    it('should delete account without holdings', async () => {
      const caller = accountsRouter.createCaller({});

      // Create an account without any holdings
      const account = await caller.create({
        institutionId: testInstitutionId,
        name: 'Account without Holdings',
        type: 'checking',
      });

      expect(account).toBeDefined();
      if (!account) throw new Error('Failed to create account for test');

      // Delete should succeed
      const result = await caller.delete({ id: account.id });

      expect(result.success).toBe(true);
      expect(result.deleted.id).toBe(account.id);
      expect(result.cascadeInfo.holdingsDeleted).toBe(0);
      expect(result.cascadeInfo.transactionsDeleted).toBe(0);

      // Verify account is completely removed
      await expect(caller.getById({ id: account.id })).rejects.toThrow('Account not found');
    });
  });

  describe('getByInstitutionId', () => {
    it('should return accounts for specific institution', async () => {
      const caller = accountsRouter.createCaller({});

      // Create accounts for different institutions
      const _account1 = await caller.create({
        institutionId: testInstitutionId,
        name: 'Test Checking Account',
        type: 'checking',
      });

      const _account2 = await caller.create({
        institutionId: testInstitutionId,
        name: 'Test Savings Account',
        type: 'savings',
      });

      const _account3 = await caller.create({
        institutionId: testInstitutionId2,
        name: 'Test Investment Account',
        type: 'investment',
      });

      // Get accounts for testInstitutionId
      const result = await caller.getByInstitutionId({
        institutionId: testInstitutionId,
      });

      // Should include 2 newly created accounts + any seeded accounts for this institution
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result.every((acc: DbAccount) => acc.institutionId === testInstitutionId)).toBe(true);
      expect(result.every((acc: DbAccount) => acc.isActive)).toBe(true);

      // Check that our newly created test accounts are included
      const testAccounts = result.filter(
        (acc: DbAccount) =>
          acc.name === 'Test Checking Account' || acc.name === 'Test Savings Account'
      );
      expect(testAccounts).toHaveLength(2);
    });

    it('should return empty array for non-existent institution', async () => {
      const caller = accountsRouter.createCaller({});

      const result = await caller.getByInstitutionId({
        institutionId: 'non-existent',
      });

      expect(result).toHaveLength(0);
    });
  });

  describe('checkNameUniqueness', () => {
    it('should return true for unique account name', async () => {
      const caller = accountsRouter.createCaller({});

      const result = await caller.checkNameUniqueness({
        name: 'Unique Account Name',
        institutionId: testInstitutionId,
      });

      expect(result.isUnique).toBe(true);
    });

    it('should return false for duplicate account name in same institution', async () => {
      const caller = accountsRouter.createCaller({});

      // Create an account first
      const created = await caller.create({
        institutionId: testInstitutionId,
        name: 'Duplicate Name',
        type: 'checking',
      });

      expect(created).toBeDefined();

      // Check if same name is unique
      const result = await caller.checkNameUniqueness({
        name: 'Duplicate Name',
        institutionId: testInstitutionId,
      });

      expect(result.isUnique).toBe(false);
    });

    it('should return true for duplicate account name in different institution', async () => {
      const caller = accountsRouter.createCaller({});

      // Create an account first
      await caller.create({
        institutionId: testInstitutionId,
        name: 'Same Name',
        type: 'checking',
      });

      // Check if same name is unique in different institution
      const result = await caller.checkNameUniqueness({
        name: 'Same Name',
        institutionId: testInstitutionId2,
      });

      expect(result.isUnique).toBe(true);
    });

    it('should return true when excluding the same account ID (edit mode)', async () => {
      const caller = accountsRouter.createCaller({});

      // Create an account first
      const created = await caller.create({
        institutionId: testInstitutionId,
        name: 'Edit Mode Test',
        type: 'checking',
      });

      expect(created).toBeDefined();
      if (!created) throw new Error('Failed to create account for test');

      // Check if same name is unique when excluding the same account
      const result = await caller.checkNameUniqueness({
        name: 'Edit Mode Test',
        institutionId: testInstitutionId,
        excludeId: created.id,
      });

      expect(result.isUnique).toBe(true);
    });

    it('should be case-insensitive', async () => {
      const caller = accountsRouter.createCaller({});

      // Create an account with lowercase name
      await caller.create({
        institutionId: testInstitutionId,
        name: 'lowercase account',
        type: 'checking',
      });

      // Check if uppercase version is unique
      const result = await caller.checkNameUniqueness({
        name: 'LOWERCASE ACCOUNT',
        institutionId: testInstitutionId,
      });

      expect(result.isUnique).toBe(false);
    });

    it('should ignore inactive accounts', async () => {
      const caller = accountsRouter.createCaller({});

      // Create and then delete an account (soft delete)
      const created = await caller.create({
        institutionId: testInstitutionId,
        name: 'Deleted Account',
        type: 'checking',
      });

      expect(created).toBeDefined();
      if (!created) throw new Error('Failed to create account for test');

      await caller.delete({ id: created.id });

      // Check if name is now unique again
      const result = await caller.checkNameUniqueness({
        name: 'Deleted Account',
        institutionId: testInstitutionId,
      });

      expect(result.isUnique).toBe(true);
    });
  });

  describe('getByType', () => {
    it('should return accounts of specific type', async () => {
      const caller = accountsRouter.createCaller({});

      // Create different types of accounts
      await caller.create({
        institutionId: testInstitutionId,
        name: 'Checking 1',
        type: 'checking',
      });

      await caller.create({
        institutionId: testInstitutionId,
        name: 'Checking 2',
        type: 'checking',
      });

      await caller.create({
        institutionId: testInstitutionId,
        name: 'Savings Account',
        type: 'savings',
      });

      // Get only checking accounts
      const result = await caller.getByType({ type: 'checking' });

      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result.every((acc: DbAccount) => acc.type === 'checking')).toBe(true);
      expect(result.every((acc: DbAccount) => acc.isActive)).toBe(true);

      // Check that our created accounts are in the results
      const checking1 = result.find((acc: DbAccount) => acc.name === 'Checking 1');
      const checking2 = result.find((acc: DbAccount) => acc.name === 'Checking 2');
      expect(checking1).toBeDefined();
      expect(checking2).toBeDefined();
    });

    it('should filter by both type and institutionId when provided', async () => {
      const caller = accountsRouter.createCaller({});

      // Create accounts for different institutions and types
      await caller.create({
        institutionId: testInstitutionId,
        name: 'Test Checking 1',
        type: 'checking',
      });

      await caller.create({
        institutionId: testInstitutionId2,
        name: 'Test Checking 2',
        type: 'checking',
      });

      await caller.create({
        institutionId: testInstitutionId,
        name: 'Test Savings 1',
        type: 'savings',
      });

      // Get checking accounts for testInstitutionId only
      const result = await caller.getByType({
        type: 'checking',
        institutionId: testInstitutionId,
      });

      // Should include our test account + any seeded checking accounts for this institution
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result.every((acc: DbAccount) => acc.type === 'checking')).toBe(true);
      expect(result.every((acc: DbAccount) => acc.institutionId === testInstitutionId)).toBe(true);

      // Verify our test account is included
      const testAccount = result.find((acc: DbAccount) => acc.name === 'Test Checking 1');
      expect(testAccount).toBeDefined();
    });

    it('should return empty array for non-existent type', async () => {
      const caller = accountsRouter.createCaller({});

      const result = await caller.getByType({ type: 'credit' }); // Use a type not in seed data

      expect(result).toHaveLength(0);
    });
  });

  describe('test utilities', () => {
    it('should reset data to sample accounts', async () => {
      // Clear data first
      await clearTestData();
      let accounts = await getAccounts();
      expect(accounts).toHaveLength(0);

      // Reset data should create sample accounts
      await clearTestData();
      await createTestData();
      accounts = await getAccounts();
    });
  });

  describe('field validation', () => {
    it('should validate account name length (max 100 characters)', async () => {
      const caller = accountsRouter.createCaller({});

      // Valid name at max length
      const validName = 'A'.repeat(100);
      const validResult = await caller.create({
        institutionId: testInstitutionId,
        name: validName,
        type: 'checking',
      });

      expect(validResult).toBeDefined();
      if (validResult) {
        expect(validResult.name).toBe(validName);
      }

      // Invalid name over max length
      const invalidName = 'A'.repeat(101);
      await expect(
        caller.create({
          institutionId: testInstitutionId,
          name: invalidName,
          type: 'savings',
        })
      ).rejects.toThrow();
    });

    it('should validate account number length (max 50 characters)', async () => {
      const caller = accountsRouter.createCaller({});

      // Valid account number at max length
      const validAccountNumber = '1'.repeat(50);
      const validResult = await caller.create({
        institutionId: testInstitutionId,
        name: 'Valid Account Number Test',
        type: 'checking',
        accountNumber: validAccountNumber,
      });

      expect(validResult).toBeDefined();
      if (validResult) {
        expect(validResult.accountNumber).toBe(validAccountNumber);
      }

      // Invalid account number over max length
      const invalidAccountNumber = '1'.repeat(51);
      await expect(
        caller.create({
          institutionId: testInstitutionId,
          name: 'Invalid Account Number Test',
          type: 'savings',
          accountNumber: invalidAccountNumber,
        })
      ).rejects.toThrow();
    });

    it('should validate description length (max 500 characters)', async () => {
      const caller = accountsRouter.createCaller({});

      // Valid description at max length
      const validDescription = 'A'.repeat(500);
      const validResult = await caller.create({
        institutionId: testInstitutionId,
        name: 'Valid Description Test',
        type: 'checking',
        description: validDescription,
      });

      expect(validResult).toBeDefined();
      if (validResult) {
        expect(validResult.description).toBe(validDescription);
      }

      // Invalid description over max length
      const invalidDescription = 'A'.repeat(501);
      await expect(
        caller.create({
          institutionId: testInstitutionId,
          name: 'Invalid Description Test',
          type: 'savings',
          description: invalidDescription,
        })
      ).rejects.toThrow();
    });

    it('should validate account name characters (only allowed characters)', async () => {
      const caller = accountsRouter.createCaller({});

      // Valid characters
      const validNames = [
        'Simple Account',
        'Account-with_dashes.and_underscores',
        "John's Savings (Primary)",
        'Account & Company',
        'Test123 Account',
      ];

      for (const validName of validNames) {
        const result = await caller.create({
          institutionId: testInstitutionId,
          name: validName,
          type: 'checking',
        });
        expect(result).toBeDefined();
        if (result) {
          expect(result.name).toBe(validName);
        }
      }

      // Invalid characters
      const invalidNames = [
        'Account@invalid',
        'Account#hashtag',
        'Account$money',
        'Account%percent',
        'Account^caret',
        'Account*star',
        'Account+plus',
        'Account=equals',
        'Account[bracket]',
        'Account{brace}',
        'Account|pipe',
        'Account\\backslash',
        'Account/slash',
        'Account<less>',
        'Account?question',
      ];

      for (const invalidName of invalidNames) {
        await expect(
          caller.create({
            institutionId: testInstitutionId,
            name: invalidName,
            type: 'checking',
          })
        ).rejects.toThrow();
      }
    });

    it('should validate account number format (masked format)', async () => {
      const caller = accountsRouter.createCaller({});

      // Valid account number formats
      const validResult = await caller.create({
        institutionId: testInstitutionId,
        name: 'Valid Account Number Test',
        type: 'checking',
        accountNumber: '****1234',
      });
      expect(validResult).toBeDefined();
      if (validResult) {
        expect(validResult.accountNumber).toBe('****1234');
      }

      // Empty account number should be valid
      const emptyResult = await caller.create({
        institutionId: testInstitutionId,
        name: 'Empty Account Number Test',
        type: 'savings',
        accountNumber: '',
      });
      expect(emptyResult).toBeDefined();

      // Invalid account number format (containing special characters not allowed)
      await expect(
        caller.create({
          institutionId: testInstitutionId,
          name: 'Invalid Account Number Test',
          type: 'checking',
          accountNumber: 'account@invalid.com',
        })
      ).rejects.toThrow('Account number format invalid');
    });

    it('should trim whitespace from fields', async () => {
      const caller = accountsRouter.createCaller({});

      const result = await caller.create({
        institutionId: testInstitutionId,
        name: '  Trimmed Account Name  ',
        type: 'checking',
        description: '  Trimmed Description  ',
        accountNumber: '  ****1234  ',
      });

      expect(result).toBeDefined();
      if (result) {
        expect(result.name).toBe('Trimmed Account Name');
        expect(result.description).toBe('Trimmed Description');
        expect(result.accountNumber).toBe('****1234');
      }
    });
  });

  describe('edge cases', () => {
    it('should handle empty strings gracefully', async () => {
      const caller = accountsRouter.createCaller({});

      await expect(
        caller.create({
          institutionId: '',
          name: '',
          type: 'checking',
        })
      ).rejects.toThrow();
    });

    it('should reject very long account names (over 100 chars)', async () => {
      const caller = accountsRouter.createCaller({});

      const longName = 'A'.repeat(101); // Over the 100 char limit

      await expect(
        caller.create({
          institutionId: testInstitutionId,
          name: longName,
          type: 'checking',
        })
      ).rejects.toThrow();
    });

    it('should handle allowed special characters in account names', async () => {
      const caller = accountsRouter.createCaller({});

      const specialName = "My Account - (Savings) & Joe's Fund";

      const result = await caller.create({
        institutionId: testInstitutionId,
        name: specialName,
        type: 'checking',
      });

      expect(result).toBeDefined();
      if (result) {
        expect(result.name).toBe(specialName);
      }
    });

    it('should reject invalid characters in account names', async () => {
      const caller = accountsRouter.createCaller({});

      const invalidName = 'Account with @#$%^* invalid chars';

      await expect(
        caller.create({
          institutionId: testInstitutionId,
          name: invalidName,
          type: 'checking',
        })
      ).rejects.toThrow();
    });
  });
});
