import Decimal from 'decimal.js';
import { sql } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { SCAM_PROBABILITY_THRESHOLD } from '../config/tokens';
import { db } from '../database/connection';
import { UserPortfolioEventRepository } from '../repositories/UserPortfolioEventRepository';
import { createComponentLogger } from '../utils/logger';
import { PortfolioValuationService } from './PortfolioValuationService';
import { UserContextService } from './UserContextService';

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

// Raw query result types
interface CountRow {
  total: string;
}

interface ChartRow {
  timestamp: Date;
  total_value: string;
  holdings_count: number;
}

/**
 * Service to fetch portfolio history data.
 *
 * Uses the user_portfolio_events table (pre-computed events) for efficient queries.
 * Falls back to the legacy holding_history + token_prices query if no events exist yet.
 *
 * Performance optimizations:
 * - Pre-computed events avoid expensive JOINs at query time
 * - Indexed by user_id, timestamp for fast pagination
 * - Additional indexes for filtering by holding, account, institution, token
 */
@Service()
export class PortfolioHistoryService {
  private readonly logger = createComponentLogger('portfolio-history');
  private readonly userContextService = Container.get(UserContextService);
  private readonly portfolioValuationService = Container.get(PortfolioValuationService);
  private readonly userPortfolioEventRepository = Container.get(UserPortfolioEventRepository);

  /**
   * Get portfolio history events (for the events list)
   *
   * Returns both balance changes (holding_update) and price changes (price_update).
   * Events are ordered by timestamp descending (most recent first).
   *
   * Uses the pre-computed user_portfolio_events table for efficient queries.
   * Falls back to the legacy query if no events exist in the new table.
   */
  async getHistoryEvents(
    userId: string,
    options: {
      limit: number;
      offset: number;
      startDate?: Date;
      endDate?: Date;
    }
  ): Promise<{
    events: PortfolioHistoryEvent[];
    total: number;
    hasMore: boolean;
  }> {
    const { limit, offset, startDate, endDate } = options;

    this.logger.debug({ userId, ...options }, 'Fetching portfolio history events');

    // Get user's base currency
    const baseCurrency = await this.userContextService.getBaseCurrency(userId);

    // Try to use the new user_portfolio_events table first
    const result = await this.userPortfolioEventRepository.findByUserIdPaginated(userId, {
      limit,
      offset,
      filters: {
        startDate,
        endDate,
      },
    });

    // If we have events in the new table, use them
    if (result.total > 0) {
      this.logger.debug(
        {
          userId,
          eventCount: result.items.length,
          total: result.total,
          hasMore: result.hasMore,
        },
        'Portfolio history events fetched from user_portfolio_events table'
      );

      return {
        events: result.items.map((event) => ({
          timestamp: event.timestamp,
          eventType: event.eventType as 'holding_update' | 'price_update',
          holdingId: event.holdingId || undefined,
          tokenId: event.tokenId,
          tokenSymbol: event.tokenSymbol,
          tokenName: event.tokenName,
          balance: event.balance,
          price: event.price,
          value: event.value,
          baseCurrencySymbol: baseCurrency.symbol,
        })),
        total: result.total,
        hasMore: result.hasMore,
      };
    }

    // Fallback to legacy query if no events exist in the new table yet
    this.logger.debug({ userId }, 'Falling back to legacy holding_history query');
    return this.getHistoryEventsLegacy(userId, options, baseCurrency);
  }

  /**
   * Legacy method using the expensive UNION query (fallback while new table is being populated)
   */
  private async getHistoryEventsLegacy(
    userId: string,
    options: {
      limit: number;
      offset: number;
      startDate?: Date;
      endDate?: Date;
    },
    baseCurrency: { id: string; symbol: string }
  ): Promise<{
    events: PortfolioHistoryEvent[];
    total: number;
    hasMore: boolean;
  }> {
    const { limit, offset, startDate, endDate } = options;

    // Convert dates to ISO strings for PostgreSQL compatibility
    const startDateStr = startDate?.toISOString();
    const endDateStr = endDate?.toISOString();

    // Query that combines BOTH holding updates AND price updates
    // The UNION merges both event types, then we sort and paginate
    const combinedEventsQuery = sql`
      WITH user_token_ids AS (
        -- Get all token IDs from user's active, visible, non-scam holdings
        SELECT DISTINCT h.token_id
        FROM holdings h
        INNER JOIN tokens t ON t.id = h.token_id
        WHERE h.user_id = ${userId}
          AND h.is_hidden = false
          AND h.is_active = true
          AND t.is_scam_probability < ${SCAM_PROBABILITY_THRESHOLD}
      ),
      holding_events AS (
        -- Balance change events from holding_history
        SELECT 
          hh.timestamp,
          'holding_update' as event_type,
          hh.holding_id,
          hh.token_id,
          t.symbol as token_symbol,
          t.name as token_name,
          hh.balance,
          COALESCE(
            (SELECT tp.price 
             FROM token_prices tp 
             WHERE tp.token_id = hh.token_id 
               AND tp.base_token_id = ${baseCurrency.id}
               AND tp.timestamp <= hh.timestamp
             ORDER BY tp.timestamp DESC 
             LIMIT 1),
            CASE WHEN hh.token_id = ${baseCurrency.id} THEN '1' ELSE '0' END
          ) as price
        FROM holding_history hh
        INNER JOIN holdings h ON h.id = hh.holding_id
        INNER JOIN tokens t ON t.id = hh.token_id
        WHERE hh.user_id = ${userId}
          AND h.is_hidden = false
          AND h.is_active = true
          AND t.is_scam_probability < ${SCAM_PROBABILITY_THRESHOLD}
          ${startDateStr ? sql`AND hh.timestamp >= ${startDateStr}::timestamptz` : sql``}
          ${endDateStr ? sql`AND hh.timestamp <= ${endDateStr}::timestamptz` : sql``}
      ),
      price_events AS (
        -- Price change events from token_prices (for user's tokens only)
        SELECT 
          tp.timestamp,
          'price_update' as event_type,
          NULL::uuid as holding_id,
          tp.token_id,
          t.symbol as token_symbol,
          t.name as token_name,
          -- Get the balance at the time of the price update
          COALESCE(
            (SELECT hh.balance 
             FROM holding_history hh
             INNER JOIN holdings h ON h.id = hh.holding_id
             WHERE hh.token_id = tp.token_id 
               AND hh.user_id = ${userId}
               AND h.is_hidden = false
               AND h.is_active = true
               AND hh.timestamp <= tp.timestamp
             ORDER BY hh.timestamp DESC 
             LIMIT 1),
            '0'
          ) as balance,
          tp.price
        FROM token_prices tp
        INNER JOIN user_token_ids ut ON ut.token_id = tp.token_id
        INNER JOIN tokens t ON t.id = tp.token_id
        WHERE tp.base_token_id = ${baseCurrency.id}
          ${startDateStr ? sql`AND tp.timestamp >= ${startDateStr}::timestamptz` : sql``}
          ${endDateStr ? sql`AND tp.timestamp <= ${endDateStr}::timestamptz` : sql``}
      ),
      all_events AS (
        SELECT * FROM holding_events
        UNION ALL
        SELECT * FROM price_events
      )
      SELECT 
        timestamp,
        event_type,
        holding_id,
        token_id,
        token_symbol,
        token_name,
        balance,
        price,
        (balance::numeric * price::numeric)::text as value
      FROM all_events
      ORDER BY timestamp DESC
      LIMIT ${limit + 1}
      OFFSET ${offset}
    `;

    // biome-ignore lint/suspicious/noExplicitAny: Raw SQL query result type
    const results = (await db.execute(combinedEventsQuery)) as any;
    const rows = (results.rows || results) as Array<{
      timestamp: Date;
      event_type: string;
      holding_id: string | null;
      token_id: string;
      token_symbol: string;
      token_name: string;
      balance: string;
      price: string;
      value: string;
    }>;

    // Check if there are more results
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit);

    // Get total count for pagination (count both event types)
    const countQuery = sql`
      WITH user_token_ids AS (
        SELECT DISTINCT h.token_id
        FROM holdings h
        INNER JOIN tokens t ON t.id = h.token_id
        WHERE h.user_id = ${userId}
          AND h.is_hidden = false
          AND h.is_active = true
          AND t.is_scam_probability < ${SCAM_PROBABILITY_THRESHOLD}
      ),
      holding_count AS (
        SELECT COUNT(*) as cnt
        FROM holding_history hh
        INNER JOIN holdings h ON h.id = hh.holding_id
        INNER JOIN tokens t ON t.id = hh.token_id
        WHERE hh.user_id = ${userId}
          AND h.is_hidden = false
          AND h.is_active = true
          AND t.is_scam_probability < ${SCAM_PROBABILITY_THRESHOLD}
          ${startDateStr ? sql`AND hh.timestamp >= ${startDateStr}::timestamptz` : sql``}
          ${endDateStr ? sql`AND hh.timestamp <= ${endDateStr}::timestamptz` : sql``}
      ),
      price_count AS (
        SELECT COUNT(*) as cnt
        FROM token_prices tp
        INNER JOIN user_token_ids ut ON ut.token_id = tp.token_id
        WHERE tp.base_token_id = ${baseCurrency.id}
          ${startDateStr ? sql`AND tp.timestamp >= ${startDateStr}::timestamptz` : sql``}
          ${endDateStr ? sql`AND tp.timestamp <= ${endDateStr}::timestamptz` : sql``}
      )
      SELECT (SELECT cnt FROM holding_count) + (SELECT cnt FROM price_count) as total
    `;

    // biome-ignore lint/suspicious/noExplicitAny: Raw SQL query result type
    const countResult = (await db.execute(countQuery)) as any;
    const countRows = (countResult.rows || countResult) as CountRow[];
    const total = Number(countRows[0]?.total || 0);

    this.logger.debug(
      { userId, eventCount: events.length, total, hasMore },
      'Portfolio history events fetched (legacy holding + price updates)'
    );

    return {
      events: events.map((row) => ({
        timestamp: row.timestamp,
        eventType: row.event_type as 'holding_update' | 'price_update',
        holdingId: row.holding_id || undefined,
        tokenId: row.token_id,
        tokenSymbol: row.token_symbol,
        tokenName: row.token_name,
        balance: row.balance,
        price: row.price,
        value: row.value,
        baseCurrencySymbol: baseCurrency.symbol,
      })),
      total,
      hasMore,
    };
  }

  /**
   * Convert resolution to PostgreSQL interval string
   */
  private getIntervalForResolution(
    resolution: 'best' | 'hourly' | 'daily' | 'weekly' | 'monthly'
  ): string {
    switch (resolution) {
      case 'best':
        return '1 minute'; // Will use actual event timestamps
      case 'hourly':
        return '1 hour';
      case 'daily':
        return '1 day';
      case 'weekly':
        return '1 week';
      case 'monthly':
        return '1 month';
      default:
        return '1 day';
    }
  }

  /**
   * Get portfolio history chart data (optimized for visualization)
   *
   * Supports multiple resolutions:
   * - 'best': Returns actual event timestamps (no bucketing)
   * - 'hourly': Buckets data by hour
   * - 'daily': Buckets data by day
   * - 'weekly': Buckets data by week
   * - 'monthly': Buckets data by month
   *
   * For 'best' resolution, returns portfolio value at each actual event time.
   * For other resolutions, generates time buckets and calculates portfolio value at each bucket.
   */
  async getHistoryChart(
    userId: string,
    startDate: Date,
    endDate: Date,
    resolution: 'best' | 'hourly' | 'daily' | 'weekly' | 'monthly' = 'daily'
  ): Promise<PortfolioHistoryChartData[]> {
    this.logger.debug(
      { userId, startDate, endDate, resolution },
      'Fetching portfolio history chart data'
    );

    // Get user's base currency
    const baseCurrency = await this.userContextService.getBaseCurrency(userId);

    if (resolution === 'best') {
      // For 'best' resolution, calculate portfolio value at each actual event timestamp
      return this.getChartDataAtEventTimes(userId, startDate, endDate, baseCurrency);
    }

    // For bucketed resolutions, use time series generation
    const interval = this.getIntervalForResolution(resolution);
    const truncUnit =
      resolution === 'hourly'
        ? 'hour'
        : resolution === 'weekly'
          ? 'week'
          : resolution === 'monthly'
            ? 'month'
            : 'day';

    // Convert dates to ISO strings for PostgreSQL compatibility
    const startDateStr = startDate.toISOString();
    const endDateStr = endDate.toISOString();

    const chartQuery = sql`
      WITH time_buckets AS (
        SELECT generate_series(
          date_trunc(${truncUnit}, ${startDateStr}::timestamptz),
          ${endDateStr}::timestamptz,
          ${interval}::interval
        ) as bucket_time
      ),
      current_holdings AS (
        SELECT h.id as holding_id, h.token_id, t.symbol
        FROM holdings h
        JOIN tokens t ON h.token_id = t.id
        WHERE h.user_id = ${userId}
          AND h.is_hidden = false
          AND h.is_active = true
          AND t.is_scam_probability < ${SCAM_PROBABILITY_THRESHOLD}
      ),
      holding_snapshots AS (
        SELECT 
          tb.bucket_time,
          ch.holding_id,
          ch.token_id,
          bal.balance
        FROM time_buckets tb
        CROSS JOIN current_holdings ch
        LEFT JOIN LATERAL (
          SELECT balance::numeric
          FROM holding_history hh
          WHERE hh.holding_id = ch.holding_id
            AND hh.timestamp <= tb.bucket_time
          ORDER BY hh.timestamp DESC
          LIMIT 1
        ) bal ON true
        WHERE bal.balance IS NOT NULL
      ),
      priced_holdings AS (
        SELECT 
          hs.bucket_time,
          hs.holding_id,
          hs.token_id,
          hs.balance,
          COALESCE(
            tp.price::numeric,
            CASE WHEN hs.token_id = ${baseCurrency.id} THEN 1 ELSE 0 END
          ) as price,
          (hs.balance * COALESCE(
            tp.price::numeric,
            CASE WHEN hs.token_id = ${baseCurrency.id} THEN 1 ELSE 0 END
          )) as value
        FROM holding_snapshots hs
        LEFT JOIN LATERAL (
          SELECT price
          FROM token_prices
          WHERE token_id = hs.token_id
            AND base_token_id = ${baseCurrency.id}
            AND timestamp <= hs.bucket_time
          ORDER BY timestamp DESC
          LIMIT 1
        ) tp ON true
      )
      SELECT 
        bucket_time as timestamp,
        SUM(value)::text as total_value,
        COUNT(*)::int as holdings_count
      FROM priced_holdings
      GROUP BY bucket_time
      ORDER BY bucket_time
    `;

    // biome-ignore lint/suspicious/noExplicitAny: Raw SQL query result type
    const results = (await db.execute(chartQuery)) as any;
    const rows = (results.rows || results) as ChartRow[];

    const chartData: PortfolioHistoryChartData[] = rows.map((row) => ({
      timestamp: row.timestamp,
      totalValue: new Decimal(row.total_value || '0').toFixed(2),
      holdingsCount: row.holdings_count,
    }));

    // If endDate is close to now (within 1 day), append current portfolio value
    // This ensures the chart ends at the exact current value (matching dashboard)
    const now = new Date();
    const oneDayMs = 24 * 60 * 60 * 1000;
    if (endDate.getTime() >= now.getTime() - oneDayMs) {
      const currentValue = await this.portfolioValuationService.getUserPortfolioValue(
        userId,
        baseCurrency.id
      );

      // Only append if the current time is after the last data point
      const lastDataPoint = chartData[chartData.length - 1];
      if (lastDataPoint) {
        if (now.getTime() > new Date(lastDataPoint.timestamp).getTime()) {
          chartData.push({
            timestamp: now,
            totalValue: new Decimal(currentValue.totalValue).toFixed(2),
            holdingsCount: currentValue.holdings.length,
          });
        }
      } else {
        // No historical data, just show current value
        chartData.push({
          timestamp: now,
          totalValue: new Decimal(currentValue.totalValue).toFixed(2),
          holdingsCount: currentValue.holdings.length,
        });
      }
    }

    this.logger.debug(
      { userId, pointCount: chartData.length, resolution },
      'Portfolio history chart data fetched'
    );

    return chartData;
  }

  /**
   * Get chart data at actual event timestamps (for 'best' resolution)
   *
   * This calculates the full portfolio value at each distinct event timestamp,
   * giving the most accurate representation of portfolio changes.
   */
  private async getChartDataAtEventTimes(
    userId: string,
    startDate: Date,
    endDate: Date,
    baseCurrency: { id: string; symbol: string; name: string }
  ): Promise<PortfolioHistoryChartData[]> {
    // Convert dates to ISO strings for PostgreSQL compatibility
    const startDateStr = startDate.toISOString();
    const endDateStr = endDate.toISOString();

    // Get all distinct event timestamps for this user in the date range
    const chartQuery = sql`
      WITH event_times AS (
        SELECT DISTINCT hh.timestamp as event_time
        FROM holding_history hh
        INNER JOIN holdings h ON h.id = hh.holding_id
        WHERE hh.user_id = ${userId}
          AND hh.timestamp >= ${startDateStr}::timestamptz
          AND hh.timestamp <= ${endDateStr}::timestamptz
          AND h.is_hidden = false
          AND h.is_active = true
        ORDER BY hh.timestamp
      ),
      current_holdings AS (
        SELECT h.id as holding_id, h.token_id, t.symbol
        FROM holdings h
        JOIN tokens t ON h.token_id = t.id
        WHERE h.user_id = ${userId}
          AND h.is_hidden = false
          AND h.is_active = true
          AND t.is_scam_probability < ${SCAM_PROBABILITY_THRESHOLD}
      ),
      holding_snapshots AS (
        SELECT 
          et.event_time,
          ch.holding_id,
          ch.token_id,
          bal.balance
        FROM event_times et
        CROSS JOIN current_holdings ch
        LEFT JOIN LATERAL (
          SELECT balance::numeric
          FROM holding_history hh
          WHERE hh.holding_id = ch.holding_id
            AND hh.timestamp <= et.event_time
          ORDER BY hh.timestamp DESC
          LIMIT 1
        ) bal ON true
        WHERE bal.balance IS NOT NULL
      ),
      priced_holdings AS (
        SELECT 
          hs.event_time,
          hs.holding_id,
          hs.token_id,
          hs.balance,
          COALESCE(
            tp.price::numeric,
            CASE WHEN hs.token_id = ${baseCurrency.id} THEN 1 ELSE 0 END
          ) as price,
          (hs.balance * COALESCE(
            tp.price::numeric,
            CASE WHEN hs.token_id = ${baseCurrency.id} THEN 1 ELSE 0 END
          )) as value
        FROM holding_snapshots hs
        LEFT JOIN LATERAL (
          SELECT price
          FROM token_prices
          WHERE token_id = hs.token_id
            AND base_token_id = ${baseCurrency.id}
            AND timestamp <= hs.event_time
          ORDER BY timestamp DESC
          LIMIT 1
        ) tp ON true
      )
      SELECT 
        event_time as timestamp,
        SUM(value)::text as total_value,
        COUNT(*)::int as holdings_count
      FROM priced_holdings
      GROUP BY event_time
      ORDER BY event_time
    `;

    // biome-ignore lint/suspicious/noExplicitAny: Raw SQL query result type
    const results = (await db.execute(chartQuery)) as any;
    const rows = (results.rows || results) as ChartRow[];

    const chartData: PortfolioHistoryChartData[] = rows.map((row) => ({
      timestamp: row.timestamp,
      totalValue: new Decimal(row.total_value || '0').toFixed(2),
      holdingsCount: row.holdings_count,
    }));

    // If endDate is close to now (within 1 day), append current portfolio value
    // This ensures the chart ends at the exact current value (matching dashboard)
    const now = new Date();
    const oneDayMs = 24 * 60 * 60 * 1000;
    if (endDate.getTime() >= now.getTime() - oneDayMs) {
      const currentValue = await this.portfolioValuationService.getUserPortfolioValue(
        userId,
        baseCurrency.id
      );

      // Only append if the current time is after the last data point
      const lastDataPoint = chartData[chartData.length - 1];
      if (lastDataPoint) {
        if (now.getTime() > new Date(lastDataPoint.timestamp).getTime()) {
          chartData.push({
            timestamp: now,
            totalValue: new Decimal(currentValue.totalValue).toFixed(2),
            holdingsCount: currentValue.holdings.length,
          });
        }
      } else {
        // No historical data, just show current value
        chartData.push({
          timestamp: now,
          totalValue: new Decimal(currentValue.totalValue).toFixed(2),
          holdingsCount: currentValue.holdings.length,
        });
      }
    }

    this.logger.debug(
      { userId, pointCount: chartData.length, resolution: 'best' },
      'Portfolio history chart data fetched (best resolution)'
    );

    return chartData;
  }
}
