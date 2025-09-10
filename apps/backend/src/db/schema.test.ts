import { describe, expect, it } from 'bun:test';
import * as schema from './schema';

describe('Database Schema', () => {
  describe('Table Definitions', () => {
    it('should export all table schemas', () => {
      expect(schema.users).toBeDefined();
      expect(schema.institutions).toBeDefined();
      expect(schema.tokens).toBeDefined();
      expect(schema.accounts).toBeDefined();
      expect(schema.holdings).toBeDefined();
      expect(schema.tokenPrices).toBeDefined();
      expect(schema.transactions).toBeDefined();
    });
  });

  describe('Relations', () => {
    it('should export all relation definitions', () => {
      expect(schema.usersRelations).toBeDefined();
      expect(schema.institutionsRelations).toBeDefined();
      expect(schema.accountsRelations).toBeDefined();
      expect(schema.tokensRelations).toBeDefined();
      expect(schema.holdingsRelations).toBeDefined();
      expect(schema.tokenPricesRelations).toBeDefined();
      expect(schema.transactionsRelations).toBeDefined();
    });

    it('should have correct relation structure', () => {
      // Relations in Drizzle are objects, not functions
      expect(typeof schema.usersRelations).toBe('object');
      expect(typeof schema.institutionsRelations).toBe('object');
      expect(typeof schema.accountsRelations).toBe('object');
      expect(typeof schema.tokensRelations).toBe('object');
      expect(typeof schema.holdingsRelations).toBe('object');
      expect(typeof schema.tokenPricesRelations).toBe('object');
      expect(typeof schema.transactionsRelations).toBe('object');
    });
  });

  describe('Type Exports', () => {
    it('should export all TypeScript types', () => {
      // Test that types are accessible (TypeScript compile-time check)
      const typeTests = {
        User: {} as schema.User,
        NewUser: {} as schema.NewUser,
        Institution: {} as schema.Institution,
        NewInstitution: {} as schema.NewInstitution,
        Token: {} as schema.Token,
        NewToken: {} as schema.NewToken,
        Account: {} as schema.Account,
        NewAccount: {} as schema.NewAccount,
        Holding: {} as schema.Holding,
        NewHolding: {} as schema.NewHolding,
        TokenPrice: {} as schema.TokenPrice,
        NewTokenPrice: {} as schema.NewTokenPrice,
        Transaction: {} as schema.Transaction,
        NewTransaction: {} as schema.NewTransaction,
      };

      // If this compiles, the types exist
      expect(typeTests).toBeDefined();
    });
  });

  describe('Table Structure', () => {
    it('should have users table defined', () => {
      expect(schema.users).toBeDefined();
      // Tables are symbols in Drizzle, just check they exist
      expect(schema.users).toBeTruthy();
    });

    it('should have tokens table defined', () => {
      expect(schema.tokens).toBeDefined();
      expect(schema.tokens).toBeTruthy();
    });

    it('should have institutions table defined', () => {
      expect(schema.institutions).toBeDefined();
      expect(schema.institutions).toBeTruthy();
    });

    it('should have accounts table defined', () => {
      expect(schema.accounts).toBeDefined();
      expect(schema.accounts).toBeTruthy();
    });

    it('should have holdings table defined', () => {
      expect(schema.holdings).toBeDefined();
      expect(schema.holdings).toBeTruthy();
    });

    it('should have transactions table defined', () => {
      expect(schema.transactions).toBeDefined();
      expect(schema.transactions).toBeTruthy();
    });

    it('should have tokenPrices table defined', () => {
      expect(schema.tokenPrices).toBeDefined();
      expect(schema.tokenPrices).toBeTruthy();
    });
  });
});
