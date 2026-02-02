import { Service } from 'typedi';
import { createComponentLogger } from '../utils/logger';

/**
 * Background service for portfolio history materialized views
 *
 * NOTE: This service is now a no-op stub. The materialized views have been
 * removed due to performance issues with the current database instance size.
 *
 * The holding_history table and trigger are still active and collecting data,
 * so historical data is being preserved for future use.
 *
 * This stub is kept to avoid breaking any code that references it.
 */
@Service()
export class PortfolioHistoryRefreshService {
  private readonly logger = createComponentLogger('portfolio-history-refresh');

  /**
   * No-op: Start would have refreshed materialized views
   */
  start(_intervalMinutes = 10): void {
    this.logger.info(
      'Portfolio history refresh service is disabled - materialized views have been removed'
    );
  }

  /**
   * No-op: Stop periodic refresh
   */
  stop(): void {
    this.logger.debug('Portfolio history refresh service stop called (no-op)');
  }

  /**
   * No-op: Would have triggered a refresh
   */
  async refresh(): Promise<void> {
    this.logger.debug('Portfolio history refresh called (no-op - views removed)');
  }

  /**
   * Always returns false since no refresh can be in progress
   */
  isRefreshInProgress(): boolean {
    return false;
  }
}
