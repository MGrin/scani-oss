import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { Service } from 'typedi';
import type { HoldingHistory } from '../database/schema';
import { holdingHistory } from '../database/schema';
import { BaseRepository, type DatabaseTransaction } from './BaseRepository';

@Service()
export class HoldingHistoryRepository extends BaseRepository<HoldingHistory> {
  protected readonly table = holdingHistory;
  protected readonly tableName = 'holding_history';

  /**
   * Get paginated holding history for a user
   */
  async findByUserIdPaginated(
    userId: string,
    options: {
      limit: number;
      offset: number;
      startDate?: Date;
      endDate?: Date;
    },
    transaction?: DatabaseTransaction
  ): Promise<{ items: HoldingHistory[]; total: number }> {
    const database = this.getDb(transaction);
    const conditions = [eq(holdingHistory.userId, userId)];

    if (options.startDate) {
      conditions.push(gte(holdingHistory.timestamp, options.startDate));
    }
    if (options.endDate) {
      conditions.push(lte(holdingHistory.timestamp, options.endDate));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await database
      .select({ count: sql<number>`count(*)` })
      .from(holdingHistory)
      .where(whereClause);

    const count = countResult[0]?.count ?? 0;

    // Get paginated items
    const items = await database
      .select()
      .from(holdingHistory)
      .where(whereClause)
      .orderBy(desc(holdingHistory.timestamp))
      .limit(options.limit)
      .offset(options.offset);

    return {
      items: items as HoldingHistory[],
      total: Number(count),
    };
  }

  /**
   * Get all holding history for a user within a date range (for chart data)
   */
  async findByUserIdInDateRange(
    userId: string,
    startDate: Date,
    endDate: Date,
    transaction?: DatabaseTransaction
  ): Promise<HoldingHistory[]> {
    const database = this.getDb(transaction);

    const items = await database
      .select()
      .from(holdingHistory)
      .where(
        and(
          eq(holdingHistory.userId, userId),
          gte(holdingHistory.timestamp, startDate),
          lte(holdingHistory.timestamp, endDate)
        )
      )
      .orderBy(holdingHistory.timestamp);

    return items as HoldingHistory[];
  }

  /**
   * Get the most recent history entry for each holding at or before a specific timestamp
   */
  async findLatestByUserIdBeforeTimestamp(
    userId: string,
    timestamp: Date,
    transaction?: DatabaseTransaction
  ): Promise<HoldingHistory[]> {
    const database = this.getDb(transaction);

    // Use DISTINCT ON to get the latest record for each holding_id before the timestamp
    const items = await database.execute<HoldingHistory>(sql`
      SELECT DISTINCT ON (holding_id) *
      FROM ${holdingHistory}
      WHERE ${holdingHistory.userId} = ${userId}
        AND ${holdingHistory.timestamp} <= ${timestamp}
      ORDER BY holding_id, timestamp DESC
    `);

    return items.rows as HoldingHistory[];
  }

  /**
   * Get unique timestamps where holding history exists for a user
   */
  async findUniqueTimestampsByUserId(
    userId: string,
    startDate: Date,
    endDate: Date,
    transaction?: DatabaseTransaction
  ): Promise<Date[]> {
    const database = this.getDb(transaction);

    const results = await database
      .selectDistinct({ timestamp: holdingHistory.timestamp })
      .from(holdingHistory)
      .where(
        and(
          eq(holdingHistory.userId, userId),
          gte(holdingHistory.timestamp, startDate),
          lte(holdingHistory.timestamp, endDate)
        )
      )
      .orderBy(holdingHistory.timestamp);

    return results.map((r) => r.timestamp);
  }
}
