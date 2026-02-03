import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { Service } from 'typedi';
import type { NewUserPortfolioEvent, UserPortfolioEvent } from '../database/schema';
import { userPortfolioEvents } from '../database/schema';
import { BaseRepository, type DatabaseTransaction } from './BaseRepository';

export interface UserPortfolioEventFilters {
  holdingId?: string;
  accountId?: string;
  institutionId?: string;
  tokenId?: string;
  eventType?: 'holding_create' | 'holding_update' | 'holding_delete' | 'price_update';
  source?: string;
  startDate?: Date;
  endDate?: Date;
}

@Service()
export class UserPortfolioEventRepository extends BaseRepository<
  UserPortfolioEvent,
  NewUserPortfolioEvent
> {
  protected readonly table = userPortfolioEvents;
  protected readonly tableName = 'user_portfolio_events';

  /**
   * Get paginated portfolio events for a user with optional filters
   */
  async findByUserIdPaginated(
    userId: string,
    options: {
      limit: number;
      offset: number;
      filters?: UserPortfolioEventFilters;
    },
    transaction?: DatabaseTransaction
  ): Promise<{ items: UserPortfolioEvent[]; total: number; hasMore: boolean }> {
    const database = this.getDb(transaction);
    const conditions = [eq(userPortfolioEvents.userId, userId)];

    // Apply filters
    if (options.filters) {
      const { holdingId, accountId, institutionId, tokenId, eventType, startDate, endDate } =
        options.filters;

      if (holdingId) {
        conditions.push(eq(userPortfolioEvents.holdingId, holdingId));
      }
      if (accountId) {
        conditions.push(eq(userPortfolioEvents.accountId, accountId));
      }
      if (institutionId) {
        conditions.push(eq(userPortfolioEvents.institutionId, institutionId));
      }
      if (tokenId) {
        conditions.push(eq(userPortfolioEvents.tokenId, tokenId));
      }
      if (eventType) {
        conditions.push(eq(userPortfolioEvents.eventType, eventType));
      }
      if (startDate) {
        conditions.push(gte(userPortfolioEvents.timestamp, startDate));
      }
      if (endDate) {
        conditions.push(lte(userPortfolioEvents.timestamp, endDate));
      }
    }

    const whereClause = and(...conditions);

    // Get total count
    const countResult = await database
      .select({ count: sql<number>`count(*)` })
      .from(userPortfolioEvents)
      .where(whereClause);

    const total = Number(countResult[0]?.count ?? 0);

    // Get paginated items (fetch one extra to check if there are more)
    const items = await database
      .select()
      .from(userPortfolioEvents)
      .where(whereClause)
      .orderBy(desc(userPortfolioEvents.timestamp))
      .limit(options.limit + 1)
      .offset(options.offset);

    const hasMore = items.length > options.limit;
    const resultItems = items.slice(0, options.limit) as UserPortfolioEvent[];

    return {
      items: resultItems,
      total,
      hasMore,
    };
  }

  /**
   * Get all portfolio events for a user within a date range (for chart data)
   */
  async findByUserIdInDateRange(
    userId: string,
    startDate: Date,
    endDate: Date,
    baseCurrencyId: string,
    transaction?: DatabaseTransaction
  ): Promise<UserPortfolioEvent[]> {
    const database = this.getDb(transaction);

    const items = await database
      .select()
      .from(userPortfolioEvents)
      .where(
        and(
          eq(userPortfolioEvents.userId, userId),
          eq(userPortfolioEvents.baseCurrencyId, baseCurrencyId),
          gte(userPortfolioEvents.timestamp, startDate),
          lte(userPortfolioEvents.timestamp, endDate)
        )
      )
      .orderBy(userPortfolioEvents.timestamp);

    return items as UserPortfolioEvent[];
  }

  /**
   * Create multiple portfolio events in a batch (for efficiency)
   */
  async createMany(
    events: NewUserPortfolioEvent[],
    transaction?: DatabaseTransaction
  ): Promise<UserPortfolioEvent[]> {
    if (events.length === 0) {
      return [];
    }

    try {
      const database = this.getDb(transaction);
      const results = await database.insert(userPortfolioEvents).values(events).returning();
      return results as UserPortfolioEvent[];
    } catch (error) {
      this.logger.error({ error, count: events.length }, 'Failed to create portfolio events batch');
      throw error;
    }
  }

  /**
   * Find users who have active holdings for a specific token
   * Used when creating price_update events
   */
  async findUserHoldingsForToken(
    tokenId: string,
    _baseCurrencyId: string,
    transaction?: DatabaseTransaction
  ): Promise<
    Array<{
      userId: string;
      holdingId: string;
      accountId: string;
      institutionId: string | null;
      balance: string;
      tokenSymbol: string;
      tokenName: string;
    }>
  > {
    const database = this.getDb(transaction);

    // Define the row type for the query result
    type HoldingRow = {
      user_id: string;
      holding_id: string;
      account_id: string;
      institution_id: string | null;
      balance: string;
      token_symbol: string;
      token_name: string;
      [key: string]: unknown;
    };

    // Query active holdings for this token with user and account info
    // Note: postgres-js returns results directly as an array, not { rows: [...] }
    const results = await database.execute<HoldingRow>(sql`
      SELECT 
        h.user_id,
        h.id as holding_id,
        h.account_id,
        a.institution_id,
        h.balance,
        t.symbol as token_symbol,
        t.name as token_name
      FROM holdings h
      JOIN accounts a ON a.id = h.account_id
      JOIN tokens t ON t.id = h.token_id
      WHERE h.token_id = ${tokenId}
        AND h.is_active = true
        AND h.is_hidden = false
        AND t.is_scam_probability < 0.45
    `);

    // postgres-js returns the array directly, not { rows: [...] }
    const rows = Array.isArray(results) ? results : [];

    return rows.map((row: HoldingRow) => ({
      userId: row.user_id,
      holdingId: row.holding_id,
      accountId: row.account_id,
      institutionId: row.institution_id,
      balance: row.balance,
      tokenSymbol: row.token_symbol,
      tokenName: row.token_name,
    }));
  }

  /**
   * Delete all events for a user (for cleanup/testing)
   */
  async deleteByUserId(userId: string, transaction?: DatabaseTransaction): Promise<number> {
    const database = this.getDb(transaction);

    const result = await database
      .delete(userPortfolioEvents)
      .where(eq(userPortfolioEvents.userId, userId))
      .returning({ id: userPortfolioEvents.id });

    return result.length;
  }

  /**
   * Delete events for specific holdings (when holdings are deleted)
   */
  async deleteByHoldingIds(
    holdingIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<number> {
    if (holdingIds.length === 0) return 0;

    const database = this.getDb(transaction);

    const result = await database
      .delete(userPortfolioEvents)
      .where(inArray(userPortfolioEvents.holdingId, holdingIds))
      .returning({ id: userPortfolioEvents.id });

    return result.length;
  }
}
