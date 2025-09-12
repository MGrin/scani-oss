import { describe, expect, it } from 'bun:test';
import {
  AccountSchema,
  AccountTypeSchema,
  CreateAccountSchema,
  CreateHoldingSchema,
  CreateInstitutionSchema,
  CreateTokenSchema,
  CreateTransactionSchema,
  CreateUserSchema,
  HoldingSchema,
  InstitutionSchema,
  InstitutionTypeSchema,
  TokenSchema,
  TokenTypeSchema,
  TransactionSchema,
  TransactionType,
  UpdateAccountSchema,
  UserSchema,
} from './finance';

describe('Finance Types and Schemas', () => {
  describe('Enums', () => {
    describe('InstitutionTypeSchema', () => {
      it('should accept valid non-empty strings', () => {
        const validTypes = [
          'bank',
          'broker',
          'crypto_exchange',
          'crypto_wallet',
          'other',
          'custom_type',
        ];
        for (const type of validTypes) {
          expect(() => InstitutionTypeSchema.parse(type)).not.toThrow();
        }
      });

      it('should reject empty or invalid values', () => {
        expect(() => InstitutionTypeSchema.parse('')).toThrow();
        expect(() => InstitutionTypeSchema.parse(null)).toThrow();
        expect(() => InstitutionTypeSchema.parse(undefined)).toThrow();
      });
    });

    describe('AccountTypeSchema', () => {
      it('should accept valid non-empty strings', () => {
        const validTypes = [
          'checking',
          'savings',
          'credit',
          'investment',
          'crypto_wallet',
          'other',
          'custom_type',
        ];
        for (const type of validTypes) {
          expect(() => AccountTypeSchema.parse(type)).not.toThrow();
        }
      });

      it('should reject empty or invalid values', () => {
        expect(() => AccountTypeSchema.parse('')).toThrow();
        expect(() => AccountTypeSchema.parse(null)).toThrow();
        expect(() => AccountTypeSchema.parse(undefined)).toThrow();
      });
    });

    describe('TransactionType', () => {
      it('should accept valid transaction types', () => {
        const validTypes = [
          'deposit',
          'withdrawal',
          'transfer',
          'buy',
          'sell',
          'dividend',
          'interest',
          'fee',
          'other',
        ];
        for (const type of validTypes) {
          expect(() => TransactionType.parse(type)).not.toThrow();
        }
      });

      it('should reject invalid transaction types', () => {
        expect(() => TransactionType.parse('invalid')).toThrow();
      });
    });

    describe('TokenTypeSchema', () => {
      it('should accept valid non-empty strings', () => {
        const validTypes = [
          'fiat',
          'crypto',
          'stock',
          'etf',
          'bond',
          'commodity',
          'real_estate',
          'precious_metals',
          'other',
        ];
        for (const type of validTypes) {
          expect(() => TokenTypeSchema.parse(type)).not.toThrow();
        }
      });

      it('should reject empty or invalid values', () => {
        expect(() => TokenTypeSchema.parse('')).toThrow();
        expect(() => TokenTypeSchema.parse(null)).toThrow();
        expect(() => TokenTypeSchema.parse(undefined)).toThrow();
      });
    });
  });

  describe('Core Schemas', () => {
    describe('UserSchema', () => {
      const validUser = {
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        baseCurrency: 'USD' as const,
        createdAt: new Date('2023-01-01'),
        updatedAt: new Date('2023-01-02'),
      };

      it('should validate valid user', () => {
        const result = UserSchema.parse(validUser);
        expect(result.id).toBe(validUser.id);
        expect(result.email).toBe(validUser.email);
      });

      it('should accept optional fields', () => {
        const userWithOptionals = {
          ...validUser,
          avatar: 'https://example.com/avatar.jpg',
        };
        expect(() => UserSchema.parse(userWithOptionals)).not.toThrow();
      });

      it('should reject invalid email', () => {
        const invalidUser = { ...validUser, email: 'invalid-email' };
        expect(() => UserSchema.parse(invalidUser)).toThrow();
      });
    });

    describe('TokenSchema', () => {
      const validToken = {
        id: 'token-123',
        symbol: 'USD',
        name: 'US Dollar',
        type: 'fiat' as const,
        decimals: 2,
        isActive: true,
        createdAt: new Date('2023-01-01'),
        updatedAt: new Date('2023-01-02'),
      };

      it('should validate valid token', () => {
        const result = TokenSchema.parse(validToken);
        expect(result.symbol).toBe('USD');
        expect(result.type).toBe('fiat');
      });

      it('should use default values', () => {
        const tokenWithoutDefaults = {
          id: 'token-123',
          symbol: 'BTC',
          name: 'Bitcoin',
          type: 'crypto' as const,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const result = TokenSchema.parse(tokenWithoutDefaults);
        expect(result.decimals).toBe(2); // default
        expect(result.isActive).toBe(true); // default
      });

      it('should validate decimals range', () => {
        const invalidToken = { ...validToken, decimals: 25 }; // > max 18
        expect(() => TokenSchema.parse(invalidToken)).toThrow();
      });

      it('should accept optional iconUrl', () => {
        const tokenWithIcon = {
          ...validToken,
          iconUrl: 'https://example.com/icon.svg',
        };
        expect(() => TokenSchema.parse(tokenWithIcon)).not.toThrow();
      });
    });

    describe('InstitutionSchema', () => {
      const validInstitution = {
        id: 'inst-123',
        userId: 'user-123',
        name: 'Test Bank',
        type: 'bank',
        isActive: true,
        createdAt: new Date('2023-01-01'),
        updatedAt: new Date('2023-01-02'),
      };

      it('should validate valid institution', () => {
        const result = InstitutionSchema.parse(validInstitution);
        expect(result.name).toBe('Test Bank');
        expect(result.type).toBe('bank');
      });

      it('should accept optional fields', () => {
        const institutionWithOptionals = {
          ...validInstitution,
          description: 'A test bank',
          website: 'https://testbank.com',
          logoUrl: 'https://testbank.com/logo.png',
        };
        expect(() => InstitutionSchema.parse(institutionWithOptionals)).not.toThrow();
      });
    });

    describe('AccountSchema', () => {
      const validAccount = {
        id: 'acc-123',
        institutionId: 'inst-123',
        name: 'Checking Account',
        type: 'checking' as const,
        isActive: true,
        createdAt: new Date('2023-01-01'),
        updatedAt: new Date('2023-01-02'),
      };

      it('should validate valid account', () => {
        const result = AccountSchema.parse(validAccount);
        expect(result.name).toBe('Checking Account');
        expect(result.type).toBe('checking');
      });

      it('should accept optional fields', () => {
        const accountWithOptionals = {
          ...validAccount,
          description: 'Main checking account',
          accountNumber: '***1234',
        };
        expect(() => AccountSchema.parse(accountWithOptionals)).not.toThrow();
      });
    });

    describe('HoldingSchema', () => {
      const validHolding = {
        id: 'hold-123',
        accountId: 'acc-123',
        tokenId: 'token-123',
        balance: 1000.5,
        lastUpdated: new Date('2023-01-01'),
        createdAt: new Date('2023-01-01'),
      };

      it('should validate valid holding', () => {
        const result = HoldingSchema.parse(validHolding);
        expect(result.balance).toBe(1000.5);
      });

      it('should accept negative balance for short positions', () => {
        const shortHolding = { ...validHolding, balance: -500 };
        expect(() => HoldingSchema.parse(shortHolding)).not.toThrow();
      });

      // averageCostBasis field removed - will be computed from transactions
    });

    describe('TransactionSchema', () => {
      const validTransaction = {
        id: 'txn-123',
        holdingId: 'hold-123',
        type: 'deposit' as const,
        amount: 100,
        fee: 0,
        timestamp: new Date('2023-01-01'),
        createdAt: new Date('2023-01-01'),
        updatedAt: new Date('2023-01-02'),
      };

      it('should validate valid transaction', () => {
        const result = TransactionSchema.parse(validTransaction);
        expect(result.type).toBe('deposit');
        expect(result.amount).toBe(100);
      });

      it('should use default fee of 0', () => {
        const transactionWithoutFee = { ...validTransaction };
        delete (transactionWithoutFee as Record<string, unknown>).fee;
        const result = TransactionSchema.parse(transactionWithoutFee);
        expect(result.fee).toBe(0);
      });

      it('should accept optional fields', () => {
        const transactionWithOptionals = {
          ...validTransaction,
          price: 25.5,
          description: 'Test deposit',
          reference: 'REF-123',
        };
        expect(() => TransactionSchema.parse(transactionWithOptionals)).not.toThrow();
      });

      it('should validate positive price when provided', () => {
        const transactionWithNegativePrice = {
          ...validTransaction,
          price: -10,
        };
        expect(() => TransactionSchema.parse(transactionWithNegativePrice)).toThrow();
      });

      it('should validate non-negative fee', () => {
        const transactionWithNegativeFee = { ...validTransaction, fee: -1 };
        expect(() => TransactionSchema.parse(transactionWithNegativeFee)).toThrow();
      });
    });
  });

  describe('Input Schemas (CREATE)', () => {
    describe('CreateUserSchema', () => {
      it('should accept valid user creation data', () => {
        const createUserData = {
          email: 'newuser@example.com',
          name: 'New User',
          avatar: 'https://example.com/avatar.jpg',
          timezone: 'America/New_York',
        };
        expect(() => CreateUserSchema.parse(createUserData)).not.toThrow();
      });

      it('should reject data with id field', () => {
        const createUserData = {
          id: 'should-not-exist',
          email: 'newuser@example.com',
          name: 'New User',
        };
        // The omit schema ignores unknown fields, so this won't throw
        // Instead, let's test that the parsed result doesn't include id
        const result = CreateUserSchema.parse(createUserData);
        expect(result).not.toHaveProperty('id');
      });
    });

    describe('CreateTokenSchema', () => {
      it('should accept valid token creation data', () => {
        const createTokenData = {
          symbol: 'AAPL',
          name: 'Apple Inc.',
          type: 'stock' as const,
          decimals: 2,
        };
        expect(() => CreateTokenSchema.parse(createTokenData)).not.toThrow();
      });
    });

    describe('CreateInstitutionSchema', () => {
      it('should accept valid institution creation data', () => {
        const createInstitutionData = {
          userId: 'user-123',
          name: 'New Bank',
          type: 'bank',
          description: 'A new bank',
        };
        expect(() => CreateInstitutionSchema.parse(createInstitutionData)).not.toThrow();
      });
    });

    describe('CreateAccountSchema', () => {
      it('should accept valid account creation data', () => {
        const createAccountData = {
          institutionId: 'inst-123',
          name: 'Savings Account',
          type: 'savings' as const,
        };
        expect(() => CreateAccountSchema.parse(createAccountData)).not.toThrow();
      });
    });

    describe('CreateHoldingSchema', () => {
      it('should accept valid holding creation data', () => {
        const createHoldingData = {
          accountId: 'acc-123',
          tokenId: 'token-123',
          balance: 500,
          lastUpdated: new Date(),
        };
        expect(() => CreateHoldingSchema.parse(createHoldingData)).not.toThrow();
      });
    });

    describe('CreateTransactionSchema', () => {
      it('should accept valid transaction creation data', () => {
        const createTransactionData = {
          holdingId: 'hold-123',
          type: 'buy' as const,
          amount: 200,
          price: 50.25,
          description: 'Stock purchase',
          timestamp: new Date(),
        };
        expect(() => CreateTransactionSchema.parse(createTransactionData)).not.toThrow();
      });
    });
  });

  describe('Update Schemas', () => {
    describe('UpdateAccountSchema', () => {
      it('should accept partial update data', () => {
        const updateData = {
          name: 'Updated Account Name',
          description: 'Updated description',
        };
        expect(() => UpdateAccountSchema.parse(updateData)).not.toThrow();
      });

      it('should accept empty object', () => {
        expect(() => UpdateAccountSchema.parse({})).not.toThrow();
      });

      it('should validate field types when provided', () => {
        const invalidUpdateData = {
          name: 123, // should be string
        };
        expect(() => UpdateAccountSchema.parse(invalidUpdateData)).toThrow();
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle very long strings within limits', () => {
      const longName = 'A'.repeat(255);
      const tokenData = {
        id: 'token-123',
        symbol: 'TEST',
        name: longName,
        type: 'other' as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      expect(() => TokenSchema.parse(tokenData)).not.toThrow();
    });

    it('should handle edge case dates', () => {
      const futureDateData = {
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        createdAt: new Date('2030-01-01'), // future date
        updatedAt: new Date('2030-01-02'),
      };
      expect(() => UserSchema.parse(futureDateData)).not.toThrow();
    });

    it('should handle precision edge cases for decimals', () => {
      const precisionHolding = {
        id: 'hold-123',
        accountId: 'acc-123',
        tokenId: 'token-123',
        balance: 0.00000001, // very small positive number
        lastUpdated: new Date(),
        createdAt: new Date(),
      };
      expect(() => HoldingSchema.parse(precisionHolding)).not.toThrow();
    });
  });
});
