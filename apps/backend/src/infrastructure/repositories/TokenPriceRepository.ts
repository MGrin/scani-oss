import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { Service } from 'typedi';
import type { NewTokenPrice, TokenPrice } from '../../domain/entities';
import * as schema from '../database/schema';
import { BaseRepository, type DatabaseTransaction } from './BaseRepository';

@Service()
export class TokenPriceRepository extends BaseRepository<TokenPrice, NewTokenPrice> {
  protected readonly table = schema.tokenPrices;
  protected readonly tableName = 'token_prices';

  async findLatestPrice(
    tokenId: string,
    baseTokenId: string,
    transaction?: DatabaseTransaction
  ): Promise<TokenPrice | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.tokenPrices)
        .where(
          and(
            eq(schema.tokenPrices.tokenId, tokenId),
            eq(schema.tokenPrices.baseTokenId, baseTokenId)
          )
        )
        .orderBy(desc(schema.tokenPrices.timestamp))
        .limit(1);

      return results[0] || null;
    } catch (error) {
      this.logger.error({ tokenId, baseTokenId, error }, 'Failed to find latest price');
      throw error;
    }
  }

  async findLatestPricesForTokens(
    tokenIds: string[],
    baseTokenId: string,
    transaction?: DatabaseTransaction
  ): Promise<Map<string, TokenPrice>> {
    try {
      if (tokenIds.length === 0) return new Map();

      const database = this.getDb(transaction);

      // Use a lateral join to get the latest price for each token
      const results = await database
        .select()
        .from(schema.tokenPrices)
        .where(
          and(
            inArray(schema.tokenPrices.tokenId, tokenIds),
            eq(schema.tokenPrices.baseTokenId, baseTokenId)
          )
        )
        .orderBy(desc(schema.tokenPrices.timestamp));

      // Group by tokenId and keep only the latest
      const priceMap = new Map<string, TokenPrice>();
      for (const price of results) {
        if (!priceMap.has(price.tokenId)) {
          priceMap.set(price.tokenId, price);
        }
      }

      return priceMap;
    } catch (error) {
      this.logger.error(
        { tokenIds, baseTokenId, error },
        'Failed to find latest prices for tokens'
      );
      throw error;
    }
  }

  async bulkUpsert(
    prices: NewTokenPrice[],
    transaction?: DatabaseTransaction
  ): Promise<TokenPrice[]> {
    try {
      if (prices.length === 0) return [];

      const database = this.getDb(transaction);

      // Insert with conflict handling
      const results = await database
        .insert(schema.tokenPrices)
        // biome-ignore lint/suspicious/noExplicitAny: Generic array type for batch insert with conflict resolution
        .values(prices as any[])
        .onConflictDoUpdate({
          target: [
            schema.tokenPrices.tokenId,
            schema.tokenPrices.baseTokenId,
            schema.tokenPrices.timestamp,
          ],
          set: {
            price: sql`EXCLUDED.price`,
            source: sql`EXCLUDED.source`,
          },
        })
        .returning();

      this.logger.debug({ count: results.length }, 'Bulk upserted token prices');
      return results;
    } catch (error) {
      this.logger.error({ count: prices.length, error }, 'Failed to bulk upsert prices');
      throw error;
    }
  }

  async findPriceAtTimestamp(
    tokenId: string,
    baseTokenId: string,
    timestamp: Date,
    windowMs: number,
    transaction?: DatabaseTransaction
  ): Promise<TokenPrice | null> {
    try {
      const database = this.getDb(transaction);
      const startWindow = new Date(timestamp.getTime() - windowMs);
      const endWindow = new Date(timestamp.getTime() + windowMs);

      // Convert timestamp to ISO string for proper SQL binding
      const timestampIso = timestamp.toISOString();

      const results = await database
        .select()
        .from(schema.tokenPrices)
        .where(
          and(
            eq(schema.tokenPrices.tokenId, tokenId),
            eq(schema.tokenPrices.baseTokenId, baseTokenId),
            gte(schema.tokenPrices.timestamp, startWindow),
            lte(schema.tokenPrices.timestamp, endWindow)
          )
        )
        .orderBy(
          sql`ABS(EXTRACT(EPOCH FROM (${schema.tokenPrices.timestamp} - ${timestampIso}::timestamptz)))`
        )
        .limit(1);

      return results[0] || null;
    } catch (error) {
      this.logger.error(
        { tokenId, baseTokenId, timestamp, windowMs, error },
        'Failed to find price at timestamp'
      );
      throw error;
    }
  }
}
