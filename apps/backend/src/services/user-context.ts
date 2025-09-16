import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/connection';
import * as schema from '../db/schema';

/**
 * Get user's base currency token information
 * @param baseCurrencyId The user's base currency token ID
 * @returns Base currency token with id, symbol, and name
 */
export async function getBaseCurrencyToken(baseCurrencyId: string) {
  const [baseCurrency] = await db
    .select({
      id: schema.tokens.id,
      symbol: schema.tokens.symbol,
      name: schema.tokens.name,
    })
    .from(schema.tokens)
    .where(eq(schema.tokens.id, baseCurrencyId))
    .limit(1);

  if (!baseCurrency) {
    throw new Error(`Base currency token not found for ID: ${baseCurrencyId}`);
  }

  return baseCurrency;
}

/**
 * Batch resolve multiple token symbols by their IDs
 * @param tokenIds Array of token IDs to resolve
 * @returns Map of token ID to token info
 */
export async function batchGetTokens(tokenIds: string[]) {
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

  // Return as a Map for O(1) lookup
  return new Map(tokens.map((token) => [token.id, token]));
}
