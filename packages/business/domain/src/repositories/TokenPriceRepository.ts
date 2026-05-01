import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { NewTokenPrice, TokenPrice, TokenPriceGranularity } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, asc, desc, eq, gte, inArray, like, lte, sql } from 'drizzle-orm';
import { Service } from 'typedi';

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

      // Fetch all matching prices and group by tokenId in memory
      // While not as optimal as DISTINCT ON, this works reliably with Drizzle's type mapping
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

      // Group by tokenId and keep only the latest (first occurrence due to DESC order)
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

  /**
   * Return the latest manual price per tokenId regardless of baseTokenId.
   * Used by pricing cache fallback: if a custom token was priced in EUR
   * and a user queries with base=USD, the strict baseTokenId match fails.
   * This lookup retrieves whichever base the manual price was recorded
   * under, so the caller can convert to the requested currency.
   */
  async findLatestManualPricesForTokensAnyBase(
    tokenIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<Map<string, TokenPrice>> {
    try {
      if (tokenIds.length === 0) return new Map();

      const database = this.getDb(transaction);

      const results = await database
        .select()
        .from(schema.tokenPrices)
        .where(
          and(
            inArray(schema.tokenPrices.tokenId, tokenIds),
            like(schema.tokenPrices.source, 'manual%')
          )
        )
        .orderBy(desc(schema.tokenPrices.timestamp));

      const priceMap = new Map<string, TokenPrice>();
      for (const price of results) {
        if (!priceMap.has(price.tokenId)) {
          priceMap.set(price.tokenId, price);
        }
      }

      return priceMap;
    } catch (error) {
      this.logger.error(
        { tokenIds, error },
        'Failed to find latest manual prices for tokens (any base)'
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

      // Insert with conflict handling. Migration 0053 widened the
      // unique key to include `granularity`; include it here so existing
      // call-sites (still passing 3 columns) align with the new schema.
      const results = await database
        .insert(schema.tokenPrices)
        // biome-ignore lint/suspicious/noExplicitAny: Generic array type for batch insert with conflict resolution
        .values(prices as any[])
        .onConflictDoUpdate({
          target: [
            schema.tokenPrices.tokenId,
            schema.tokenPrices.baseTokenId,
            schema.tokenPrices.timestamp,
            schema.tokenPrices.granularity,
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

      // Convert timestamp to ISO string for raw SQL template
      // Note: Drizzle ORM's gte/lte functions handle Date objects correctly,
      // but raw SQL templates need explicit conversion to avoid Date.toString() serialization
      const timestampIso = timestamp.toISOString();

      const results = await database
        .select()
        .from(schema.tokenPrices)
        .where(
          and(
            eq(schema.tokenPrices.tokenId, tokenId),
            eq(schema.tokenPrices.baseTokenId, baseTokenId),
            // Date objects work correctly in Drizzle's comparison functions
            gte(schema.tokenPrices.timestamp, startWindow),
            lte(schema.tokenPrices.timestamp, endWindow)
          )
        )
        .orderBy(
          // Raw SQL requires explicit ISO string and timestamptz cast
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

  /**
   * Find the closest price at or before a specific timestamp
   * Used for historical portfolio valuation
   */
  async findClosestPrice(
    tokenId: string,
    baseTokenId: string,
    timestamp: Date,
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
            eq(schema.tokenPrices.baseTokenId, baseTokenId),
            lte(schema.tokenPrices.timestamp, timestamp)
          )
        )
        .orderBy(desc(schema.tokenPrices.timestamp))
        .limit(1);

      return results[0] || null;
    } catch (error) {
      this.logger.error({ tokenId, baseTokenId, timestamp, error }, 'Failed to find closest price');
      throw error;
    }
  }

  /**
   * Find price updates for specific tokens within a date range with pagination
   * Used for portfolio history events
   */
  async findPriceUpdatesPaginated(
    tokenIds: string[],
    baseTokenId: string,
    options: {
      limit: number;
      offset: number;
      startDate?: Date;
      endDate?: Date;
    },
    transaction?: DatabaseTransaction
  ): Promise<{ items: TokenPrice[]; total: number }> {
    try {
      if (tokenIds.length === 0) {
        return { items: [], total: 0 };
      }

      const database = this.getDb(transaction);
      const conditions = [
        inArray(schema.tokenPrices.tokenId, tokenIds),
        eq(schema.tokenPrices.baseTokenId, baseTokenId),
      ];

      if (options.startDate) {
        conditions.push(gte(schema.tokenPrices.timestamp, options.startDate));
      }
      if (options.endDate) {
        conditions.push(lte(schema.tokenPrices.timestamp, options.endDate));
      }

      const whereClause = and(...conditions);

      // Get total count
      const countResult = await database
        .select({ count: sql<number>`count(*)` })
        .from(schema.tokenPrices)
        .where(whereClause);

      const count = countResult[0]?.count ?? 0;

      // Get paginated items
      const items = await database
        .select()
        .from(schema.tokenPrices)
        .where(whereClause)
        .orderBy(desc(schema.tokenPrices.timestamp))
        .limit(options.limit)
        .offset(options.offset);

      return {
        items,
        total: Number(count),
      };
    } catch (error) {
      this.logger.error(
        { tokenIds, baseTokenId, options, error },
        'Failed to find price updates paginated'
      );
      throw error;
    }
  }

  // Find the closest price at or before `timestamp`, preferring rows of
  // a specific granularity. Used by PriceGraphService to bias toward
  // 'tx-exact' when pricing a known trade, or 'daily' when rendering a
  // chart, while still allowing fallthrough to other granularities when
  // the preferred one is missing.
  async findClosestPriceByGranularity(
    tokenId: string,
    baseTokenId: string,
    timestamp: Date,
    preferGranularity: TokenPriceGranularity | null,
    transaction?: DatabaseTransaction
  ): Promise<TokenPrice | null> {
    try {
      const database = this.getDb(transaction);

      if (preferGranularity) {
        const preferred = await database
          .select()
          .from(schema.tokenPrices)
          .where(
            and(
              eq(schema.tokenPrices.tokenId, tokenId),
              eq(schema.tokenPrices.baseTokenId, baseTokenId),
              eq(schema.tokenPrices.granularity, preferGranularity),
              lte(schema.tokenPrices.timestamp, timestamp)
            )
          )
          .orderBy(desc(schema.tokenPrices.timestamp))
          .limit(1);

        if (preferred[0]) return preferred[0];
      }

      // Fall through to any granularity.
      const results = await database
        .select()
        .from(schema.tokenPrices)
        .where(
          and(
            eq(schema.tokenPrices.tokenId, tokenId),
            eq(schema.tokenPrices.baseTokenId, baseTokenId),
            lte(schema.tokenPrices.timestamp, timestamp)
          )
        )
        .orderBy(desc(schema.tokenPrices.timestamp))
        .limit(1);
      return results[0] ?? null;
    } catch (error) {
      this.logger.error(
        { tokenId, baseTokenId, timestamp, preferGranularity, error },
        'Failed to find closest price by granularity'
      );
      throw error;
    }
  }

  // Bulk insert daily-close backfill rows. Matches `bulkUpsert` but sets
  // granularity='daily' on every row. Used by HistoricalPriceBackfillService.
  async bulkUpsertDailyBackfill(
    prices: NewTokenPrice[],
    transaction?: DatabaseTransaction
  ): Promise<TokenPrice[]> {
    try {
      if (prices.length === 0) return [];
      const database = this.getDb(transaction);
      const rows = prices.map((p) => ({ ...p, granularity: 'daily' as const }));

      const results = await database
        .insert(schema.tokenPrices)
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle array insert type
        .values(rows as any[])
        .onConflictDoUpdate({
          target: [
            schema.tokenPrices.tokenId,
            schema.tokenPrices.baseTokenId,
            schema.tokenPrices.timestamp,
            schema.tokenPrices.granularity,
          ],
          set: {
            price: sql`EXCLUDED.price`,
            source: sql`EXCLUDED.source`,
          },
        })
        .returning();
      this.logger.debug({ count: results.length }, 'Bulk upserted daily-backfill token prices');
      return results;
    } catch (error) {
      this.logger.error(
        { count: prices.length, error: error instanceof Error ? error.message : error },
        'Failed to bulk upsert daily-backfill prices'
      );
      throw error;
    }
  }

  // List distinct (token_id, base_token_id) pairs that exist in the
  // price table — used by ForexBackfillCronJob / PriceGraphService to
  // enumerate available edges in the price graph.
  async listKnownPairs(
    transaction?: DatabaseTransaction
  ): Promise<Array<{ tokenId: string; baseTokenId: string }>> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .selectDistinct({
          tokenId: schema.tokenPrices.tokenId,
          baseTokenId: schema.tokenPrices.baseTokenId,
        })
        .from(schema.tokenPrices);
      return results;
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : error },
        'Failed to list known token price pairs'
      );
      throw error;
    }
  }

  // Find the earliest daily-close price for a token. Used by backfill to
  // know how far back our coverage goes without hitting the provider.
  async findEarliestDailyAt(
    tokenId: string,
    baseTokenId: string,
    transaction?: DatabaseTransaction
  ): Promise<Date | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({ t: schema.tokenPrices.timestamp })
        .from(schema.tokenPrices)
        .where(
          and(
            eq(schema.tokenPrices.tokenId, tokenId),
            eq(schema.tokenPrices.baseTokenId, baseTokenId),
            eq(schema.tokenPrices.granularity, 'daily')
          )
        )
        .orderBy(asc(schema.tokenPrices.timestamp))
        .limit(1);
      return results[0]?.t ? new Date(results[0].t) : null;
    } catch (error) {
      this.logger.error(
        { tokenId, baseTokenId, error: error instanceof Error ? error.message : error },
        'Failed to find earliest daily price'
      );
      throw error;
    }
  }
}
