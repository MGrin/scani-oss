import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/connection';
import * as schema from '../db/schema';

/**
 * Enhanced user context service with batch operations
 * Replaces the simple user-context.ts with performance optimizations
 * NO in-memory caching to avoid stale data issues
 */
export class UserContextService {
  /**
   * Get user's base currency token with optimized query
   * Replaces repeated queries in PortfolioValuationService
   */
  async getBaseCurrency(userId: string): Promise<Token> {
    // Fetch user and base currency in a single optimized query
    const [userWithBaseCurrency] = await db
      .select({
        userId: schema.users.id,
        baseCurrencyId: schema.tokens.id,
        baseCurrencySymbol: schema.tokens.symbol,
        baseCurrencyName: schema.tokens.name,
      })
      .from(schema.users)
      .innerJoin(schema.tokens, eq(schema.users.baseCurrencyId, schema.tokens.id))
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!userWithBaseCurrency) {
      throw new Error(`User ${userId} not found or has no base currency set`);
    }

    return {
      id: userWithBaseCurrency.baseCurrencyId,
      symbol: userWithBaseCurrency.baseCurrencySymbol,
      name: userWithBaseCurrency.baseCurrencyName,
    };
  }

  /**
   * Get transaction type by code
   * Eliminates repeated transaction type lookups across services
   */
  async getTransactionType(code: string): Promise<TransactionType> {
    const [transactionType] = await db
      .select()
      .from(schema.transactionTypes)
      .where(eq(schema.transactionTypes.code, code))
      .limit(1);

    if (!transactionType) {
      throw new Error(`Transaction type '${code}' not found`);
    }

    return transactionType;
  }

  /**
   * Batch get base currencies for multiple users
   * Optimizes portfolio operations across multiple users
   */
  async batchGetBaseCurrencies(userIds: string[]): Promise<Map<string, Token>> {
    if (userIds.length === 0) return new Map();

    const usersWithBaseCurrencies = await db
      .select({
        userId: schema.users.id,
        baseCurrencyId: schema.tokens.id,
        baseCurrencySymbol: schema.tokens.symbol,
        baseCurrencyName: schema.tokens.name,
      })
      .from(schema.users)
      .innerJoin(schema.tokens, eq(schema.users.baseCurrencyId, schema.tokens.id))
      .where(
        userIds.length === 1 ? eq(schema.users.id, userIds[0]!) : inArray(schema.users.id, userIds)
      );

    const result = new Map<string, Token>();
    for (const userWithBaseCurrency of usersWithBaseCurrencies) {
      const token = {
        id: userWithBaseCurrency.baseCurrencyId,
        symbol: userWithBaseCurrency.baseCurrencySymbol,
        name: userWithBaseCurrency.baseCurrencyName,
      };

      result.set(userWithBaseCurrency.userId, token);
    }

    return result;
  }

  /**
   * Batch resolve multiple token symbols by their IDs
   * Enhanced version of the original batchGetTokens
   */
  async batchGetTokens(tokenIds: string[]): Promise<Map<string, Token>> {
    if (tokenIds.length === 0) return new Map();

    const tokens = await db
      .select({
        id: schema.tokens.id,
        symbol: schema.tokens.symbol,
        name: schema.tokens.name,
      })
      .from(schema.tokens)
      .where(
        tokenIds.length === 1
          ? eq(schema.tokens.id, tokenIds[0]!)
          : inArray(schema.tokens.id, tokenIds)
      );

    return new Map(tokens.map((token) => [token.id, token]));
  }

  /**
   * Batch get transaction types for multiple codes
   * Optimizes operations that need multiple transaction types
   */
  async batchGetTransactionTypes(codes: string[]): Promise<Map<string, TransactionType>> {
    if (codes.length === 0) return new Map();

    const transactionTypes = await db
      .select()
      .from(schema.transactionTypes)
      .where(
        codes.length === 1
          ? eq(schema.transactionTypes.code, codes[0]!)
          : inArray(schema.transactionTypes.code, codes)
      );

    return new Map(transactionTypes.map((type) => [type.code, type]));
  }
}

// Types for better type safety
export interface Token {
  id: string;
  symbol: string;
  name: string;
}

export interface TransactionType {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

// Singleton instance
export const userContextService = new UserContextService();
