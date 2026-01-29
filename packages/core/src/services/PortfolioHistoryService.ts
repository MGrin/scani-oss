import { sql } from 'drizzle-orm';
import { Service } from 'typedi';
import { db } from '../database/connection';
import { createComponentLogger } from '../utils/logger';

export interface PortfolioHistoryEvent {
  timestamp: Date;
  eventType: 'holding_update' | 'price_update';
  holdingId?: string;
  tokenId: string;
  tokenSymbol: string;
  tokenName: string;
  balance: string;
  price: string;
  value: string;
  baseCurrencySymbol: string;
}

export interface PortfolioHistoryChartData {
  timestamp: Date;
  totalValue: string;
  holdingsCount: number;
}

/**
 * Optimized service to fetch portfolio history using materialized views
 * This eliminates expensive in-memory joins and calculations
 */
@Service()
export class PortfolioHistoryService {
  private readonly logger = createComponentLogger('portfolio-history');

  /**
   * Get portfolio history events (for the events list)
   * Optimized to use materialized view instead of in-memory joins
   */
  async getHistoryEvents(
    userId: string,
    options: {
      limit: number;
      offset: number;
      startDate?: Date;
      endDate?: Date;
    }
  ): Promise<{ events: PortfolioHistoryEvent[]; total: number; hasMore: boolean }> {
    try {
      // Set reasonable default date range if not provided (last 90 days)
      const startDate = options.startDate || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const endDate = options.endDate || new Date();

      // Build WHERE conditions
      const conditions = [
        sql`user_id = ${userId}`,
        sql`timestamp >= ${startDate.toISOString()}`,
        sql`timestamp <= ${endDate.toISOString()}`,
      ];
      const whereClause = sql.join(conditions, sql` AND `);

      // Get total count efficiently
      const totalResult = await db.execute(sql`
        SELECT COUNT(*) as count
        FROM portfolio_history_events
        WHERE ${whereClause}
      `);
      // Type assertion for database results
      const totalRows = totalResult as unknown as { rows: Array<{ count: number }> };
      const total = Number(totalRows.rows[0]?.count ?? 0);

      // Get paginated events from materialized view
      const result = await db.execute(sql`
        SELECT 
          timestamp,
          event_type,
          holding_id,
          token_id,
          token_symbol,
          token_name,
          balance,
          price,
          value,
          base_currency_symbol
        FROM portfolio_history_events
        WHERE ${whereClause}
        ORDER BY timestamp DESC
        LIMIT ${options.limit}
        OFFSET ${options.offset}
      `);

      // Type assertion for database results
      interface EventRow {
        timestamp: string;
        event_type: 'holding_update' | 'price_update';
        holding_id: string | null;
        token_id: string;
        token_symbol: string;
        token_name: string;
        balance: string;
        price: string;
        value: string;
        base_currency_symbol: string;
      }
      const eventRows = result as unknown as { rows: EventRow[] };

      // Map database results to PortfolioHistoryEvent interface
      const events: PortfolioHistoryEvent[] = eventRows.rows.map((row) => ({
        timestamp: new Date(row.timestamp),
        eventType: row.event_type,
        holdingId: row.holding_id || undefined,
        tokenId: row.token_id,
        tokenSymbol: row.token_symbol,
        tokenName: row.token_name,
        balance: row.balance,
        price: row.price,
        value: row.value,
        baseCurrencySymbol: row.base_currency_symbol,
      }));

      const hasMore = options.offset + options.limit < total;

      return { events, total, hasMore };
    } catch (error) {
      this.logger.error({ error, userId }, 'Error getting history events');
      throw error;
    }
  }

  /**
   * Get portfolio history chart data (optimized for visualization)
   * Uses materialized view to eliminate expensive in-memory aggregations
   */
  async getHistoryChart(
    userId: string,
    startDate: Date,
    endDate: Date,
    maxPoints = 500
  ): Promise<PortfolioHistoryChartData[]> {
    try {
      // Query the pre-computed chart data from materialized view
      const result = await db.execute(sql`
        SELECT 
          timestamp,
          total_value,
          holdings_count
        FROM portfolio_history_chart_data
        WHERE user_id = ${userId}
          AND timestamp >= ${startDate.toISOString()}
          AND timestamp <= ${endDate.toISOString()}
        ORDER BY timestamp ASC
      `);

      // Type assertion for database results
      interface ChartRow {
        timestamp: string;
        total_value: string;
        holdings_count: number;
      }
      const chartRows = result as unknown as { rows: ChartRow[] };

      const allData = chartRows.rows.map((row) => ({
        timestamp: new Date(row.timestamp),
        totalValue: row.total_value,
        holdingsCount: row.holdings_count,
      }));

      // If we have too many points, sample them
      if (allData.length > maxPoints) {
        return this.sampleChartData(allData, maxPoints);
      }

      return allData;
    } catch (error) {
      this.logger.error({ error, userId, startDate, endDate }, 'Error getting history chart');
      throw error;
    }
  }

  /**
   * Sample chart data evenly to reduce number of data points
   */
  private sampleChartData(
    data: PortfolioHistoryChartData[],
    maxPoints: number
  ): PortfolioHistoryChartData[] {
    const step = Math.ceil(data.length / maxPoints);
    const sampled: PortfolioHistoryChartData[] = [];

    for (let i = 0; i < data.length; i += step) {
      const item = data[i];
      if (item) {
        sampled.push(item);
      }
    }

    // Always include the last data point
    const lastItem = data[data.length - 1];
    if (lastItem && sampled[sampled.length - 1] !== lastItem) {
      sampled.push(lastItem);
    }

    return sampled;
  }

  /**
   * Refresh materialized views
   * Should be called periodically (e.g., every 5-15 minutes) or after bulk updates
   */
  async refreshMaterializedViews(): Promise<void> {
    try {
      this.logger.info('Refreshing portfolio history materialized views');
      await db.execute(sql`SELECT refresh_portfolio_history_views()`);
      this.logger.info('Successfully refreshed portfolio history materialized views');
    } catch (error) {
      this.logger.error({ error }, 'Error refreshing materialized views');
      throw error;
    }
  }
}
