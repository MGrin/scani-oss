import { eq } from 'drizzle-orm';
import { Service } from 'typedi';
import { db } from '../../infrastructure/database/connection';
import * as schema from '../../infrastructure/database/schema';

// Types for better type safety
export interface Token {
  id: string;
  symbol: string;
  name: string;
}

@Service()
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
}
