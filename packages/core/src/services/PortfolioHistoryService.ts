import Decimal from 'decimal.js';
import { inArray } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { db } from '../database/connection';
import { tokens } from '../database/schema';
import { HoldingHistoryRepository } from '../repositories/HoldingHistoryRepository';
import { TokenPriceRepository } from '../repositories/TokenPriceRepository';
import { createComponentLogger } from '../utils/logger';
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

/**
 * Service to calculate portfolio history using holding history and price data
 */
@Service()
export class PortfolioHistoryService {
  private readonly logger = createComponentLogger('portfolio-history');
  private readonly holdingHistoryRepository = Container.get(HoldingHistoryRepository);
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);
  private readonly userContextService = Container.get(UserContextService);

  /**
   * Get portfolio history events (for the events list)
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
      // Get user's base currency
      const baseCurrency = await this.userContextService.getBaseCurrency(userId);

      // Set reasonable default date range if not provided (last 90 days)
      const startDate = options.startDate || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const endDate = options.endDate || new Date();

      // Get holding history with a large enough limit to fetch all events in the date range
      // This is necessary because we need to merge with price updates and then paginate
      const { items: holdingHistoryItems } =
        await this.holdingHistoryRepository.findByUserIdPaginated(userId, {
          limit: 10000,
          offset: 0,
          startDate,
          endDate,
        });

      // Get unique token IDs from holding history
      const tokenIds = [...new Set(holdingHistoryItems.map((item) => item.tokenId))];

      if (tokenIds.length === 0) {
        return { events: [], total: 0, hasMore: false };
      }

      // Get token info for all tokens
      const tokenInfo = await db
        .select({
          id: tokens.id,
          symbol: tokens.symbol,
          name: tokens.name,
        })
        .from(tokens)
        .where(inArray(tokens.id, tokenIds));

      const tokenMap = new Map(tokenInfo.map((t) => [t.id, t]));

      // Get price updates for the user's tokens
      const { items: priceUpdateItems } = await this.tokenPriceRepository.findPriceUpdatesPaginated(
        tokenIds,
        baseCurrency.id,
        {
          limit: 10000,
          offset: 0,
          startDate,
          endDate,
        }
      );

      // Fetch latest prices for all tokens (used as fallback)
      const latestPricesMap = await this.tokenPriceRepository.findLatestPricesForTokens(
        tokenIds,
        baseCurrency.id
      );

      // Build a map of holdings by tokenId for efficient lookup
      // Sort holdings by timestamp (ascending) for each token
      const holdingsByToken = new Map<string, typeof holdingHistoryItems>();
      for (const holding of holdingHistoryItems) {
        const holdings = holdingsByToken.get(holding.tokenId) || [];
        holdings.push(holding);
        holdingsByToken.set(holding.tokenId, holdings);
      }
      // Sort each token's holdings by timestamp
      for (const holdings of holdingsByToken.values()) {
        holdings.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      }

      // Build holding update events
      const holdingEvents: PortfolioHistoryEvent[] = [];
      for (const item of holdingHistoryItems) {
        const token = tokenMap.get(item.tokenId);
        if (!token) continue;

        // Use latest known price as fallback
        const latestPrice = latestPricesMap.get(item.tokenId);
        const priceValue = latestPrice ? new Decimal(latestPrice.price) : new Decimal(0);
        const balance = new Decimal(item.balance);
        const value = balance.times(priceValue);

        holdingEvents.push({
          timestamp: item.timestamp,
          eventType: 'holding_update',
          holdingId: item.holdingId,
          tokenId: item.tokenId,
          tokenSymbol: token.symbol,
          tokenName: token.name,
          balance: item.balance,
          price: priceValue.toString(),
          value: value.toString(),
          baseCurrencySymbol: baseCurrency.symbol,
        });
      }

      // Build price update events
      // Track timestamps to avoid duplicates with holding updates
      const holdingUpdateTimestamps = new Set(
        holdingHistoryItems.map((h) => `${h.tokenId}-${h.timestamp.getTime()}`)
      );

      const priceEvents: PortfolioHistoryEvent[] = [];
      for (const priceUpdate of priceUpdateItems) {
        const token = tokenMap.get(priceUpdate.tokenId);
        if (!token) continue;

        // Skip if there's a holding update at the exact same timestamp
        const timestampKey = `${priceUpdate.tokenId}-${priceUpdate.timestamp.getTime()}`;
        if (holdingUpdateTimestamps.has(timestampKey)) {
          continue;
        }

        // Find the most recent holding at or before this price update timestamp
        const tokenHoldings = holdingsByToken.get(priceUpdate.tokenId) || [];
        let mostRecentHolding = null;
        for (let i = tokenHoldings.length - 1; i >= 0; i--) {
          const holding = tokenHoldings[i];
          if (holding && holding.timestamp <= priceUpdate.timestamp) {
            mostRecentHolding = holding;
            break;
          }
        }

        // Skip if no holding exists at or before this price update
        if (!mostRecentHolding) continue;

        const balance = new Decimal(mostRecentHolding.balance);
        const priceValue = new Decimal(priceUpdate.price);
        const value = balance.times(priceValue);

        priceEvents.push({
          timestamp: priceUpdate.timestamp,
          eventType: 'price_update',
          tokenId: priceUpdate.tokenId,
          tokenSymbol: token.symbol,
          tokenName: token.name,
          balance: mostRecentHolding.balance,
          price: priceUpdate.price,
          value: value.toString(),
          baseCurrencySymbol: baseCurrency.symbol,
        });
      }

      // Merge and sort all events by timestamp (descending)
      const allEvents = [...holdingEvents, ...priceEvents].sort(
        (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
      );

      // Apply pagination
      const total = allEvents.length;
      const paginatedEvents = allEvents.slice(options.offset, options.offset + options.limit);
      const hasMore = options.offset + options.limit < total;

      return { events: paginatedEvents, total, hasMore };
    } catch (error) {
      this.logger.error({ error, userId }, 'Error getting history events');
      throw error;
    }
  }

  /**
   * Get portfolio history chart data (optimized for visualization)
   */
  async getHistoryChart(
    userId: string,
    startDate: Date,
    endDate: Date,
    maxPoints = 500
  ): Promise<PortfolioHistoryChartData[]> {
    try {
      // Get user's base currency
      const baseCurrency = await this.userContextService.getBaseCurrency(userId);

      // Get all unique timestamps from holding history in the date range
      const timestamps = await this.holdingHistoryRepository.findUniqueTimestampsByUserId(
        userId,
        startDate,
        endDate
      );

      // If we have too many points, sample them
      const sampledTimestamps =
        timestamps.length > maxPoints ? this.sampleTimestamps(timestamps, maxPoints) : timestamps;

      // Get all holdings history in one query for the date range
      const allHoldingsHistory = await this.holdingHistoryRepository.findByUserIdInDateRange(
        userId,
        startDate,
        endDate
      );

      // Get unique token IDs and fetch latest prices
      const tokenIds = [...new Set(allHoldingsHistory.map((h) => h.tokenId))];
      const latestPrices = await this.tokenPriceRepository.findLatestPricesForTokens(
        tokenIds,
        baseCurrency.id
      );
      const priceMap = new Map(
        Array.from(latestPrices).map(([tokenId, price]) => [tokenId, new Decimal(price.price)])
      );

      // For each timestamp, calculate total portfolio value
      const chartData: PortfolioHistoryChartData[] = [];

      for (const timestamp of sampledTimestamps) {
        // Get the most recent holding state for each holding at this timestamp
        // Build a map of latest holdings before this timestamp
        const holdingsMap = new Map<string, (typeof allHoldingsHistory)[0]>();

        for (const holding of allHoldingsHistory) {
          if (holding.timestamp <= timestamp) {
            const existing = holdingsMap.get(holding.holdingId);
            if (!existing || existing.timestamp < holding.timestamp) {
              holdingsMap.set(holding.holdingId, holding);
            }
          }
        }

        if (holdingsMap.size === 0) {
          continue;
        }

        // Calculate total value at this timestamp
        let totalValue = new Decimal(0);

        for (const holding of holdingsMap.values()) {
          const price = priceMap.get(holding.tokenId);
          if (price) {
            const balance = new Decimal(holding.balance);
            const value = balance.times(price);
            totalValue = totalValue.plus(value);
          }
        }

        chartData.push({
          timestamp,
          totalValue: totalValue.toString(),
          holdingsCount: holdingsMap.size,
        });
      }

      return chartData;
    } catch (error) {
      this.logger.error({ error, userId, startDate, endDate }, 'Error getting history chart');
      throw error;
    }
  }

  /**
   * Sample timestamps evenly to reduce number of data points
   */
  private sampleTimestamps(timestamps: Date[], maxPoints: number): Date[] {
    const step = Math.ceil(timestamps.length / maxPoints);
    const sampled: Date[] = [];

    for (let i = 0; i < timestamps.length; i += step) {
      const timestamp = timestamps[i];
      if (timestamp) {
        sampled.push(timestamp);
      }
    }

    // Always include the last timestamp
    const lastTimestamp = timestamps[timestamps.length - 1];
    if (lastTimestamp && sampled[sampled.length - 1] !== lastTimestamp) {
      sampled.push(lastTimestamp);
    }

    return sampled;
  }
}
