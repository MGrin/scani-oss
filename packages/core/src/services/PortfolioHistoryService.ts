import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
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

      // Get holding history with pagination
      const { items: historyItems, total } =
        await this.holdingHistoryRepository.findByUserIdPaginated(userId, options);

      if (historyItems.length === 0) {
        return { events: [], total: 0, hasMore: false };
      }

      // Get all unique token IDs from the history
      const tokenIds = [...new Set(historyItems.map((item) => item.tokenId))];

      // Get token info for all tokens
      const { db } = await import('../database/connection');
      const { tokens } = await import('../database/schema');
      const { inArray } = await import('drizzle-orm');

      const tokenInfo = await db
        .select({
          id: tokens.id,
          symbol: tokens.symbol,
          name: tokens.name,
        })
        .from(tokens)
        .where(inArray(tokens.id, tokenIds));

      const tokenMap = new Map(tokenInfo.map((t) => [t.id, t]));

      // Build a map of prices by fetching all at once using latest prices
      // For events list, we use the most recent price before each timestamp
      const priceMap = new Map<string, string>();

      // Get unique token IDs and fetch latest prices for each
      const latestPrices = await this.tokenPriceRepository.findLatestPricesForTokens(
        tokenIds,
        baseCurrency.id
      );

      for (const [tokenId, price] of latestPrices) {
        priceMap.set(tokenId, price.price);
      }

      // For each history item, build the event
      const events: PortfolioHistoryEvent[] = historyItems
        .map((item): PortfolioHistoryEvent | null => {
          const token = tokenMap.get(item.tokenId);
          if (!token) return null;

          const priceValue = priceMap.has(item.tokenId)
            ? new Decimal(priceMap.get(item.tokenId)!)
            : new Decimal(0);
          const balance = new Decimal(item.balance);
          const value = balance.times(priceValue);

          return {
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
          };
        })
        .filter((e): e is PortfolioHistoryEvent => e !== null);

      const hasMore = options.offset + options.limit < total;

      return { events, total, hasMore };
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
