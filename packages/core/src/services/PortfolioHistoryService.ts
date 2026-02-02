import { Service } from 'typedi';
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
 * Service to fetch portfolio history
 *
 * NOTE: The materialized views have been removed due to performance issues
 * with the current database instance size. This service now returns empty
 * placeholder data until an alternative implementation is developed.
 *
 * The holding_history table and trigger are still active and collecting data,
 * so historical data is being preserved for future use.
 */
@Service()
export class PortfolioHistoryService {
  private readonly logger = createComponentLogger('portfolio-history');

  /**
   * Get portfolio history events (for the events list)
   *
   * NOTE: Returns empty data - materialized views have been removed
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
    this.logger.debug(
      { userId, ...options },
      'Portfolio history events requested - returning empty data (materialized views removed)'
    );

    // Return empty placeholder data
    return {
      events: [],
      total: 0,
      hasMore: false,
    };
  }

  /**
   * Get portfolio history chart data (optimized for visualization)
   *
   * NOTE: Returns empty data - materialized views have been removed
   */
  async getHistoryChart(
    userId: string,
    startDate: Date,
    endDate: Date,
    maxPoints = 500
  ): Promise<PortfolioHistoryChartData[]> {
    this.logger.debug(
      { userId, startDate, endDate, maxPoints },
      'Portfolio history chart requested - returning empty data (materialized views removed)'
    );

    // Return empty placeholder data
    return [];
  }
}
