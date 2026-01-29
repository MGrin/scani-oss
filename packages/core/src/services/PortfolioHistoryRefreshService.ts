import { Service } from 'typedi';
import { createComponentLogger } from '../utils/logger';
import type { PortfolioHistoryService } from './PortfolioHistoryService';

/**
 * Background service to refresh portfolio history materialized views
 * Runs periodically to keep the views up-to-date with recent changes
 */
@Service()
export class PortfolioHistoryRefreshService {
  private readonly logger = createComponentLogger('portfolio-history-refresh');
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private isRefreshing = false;

  constructor(private readonly portfolioHistoryService: PortfolioHistoryService) {}

  /**
   * Start periodic refresh of materialized views
   * @param intervalMinutes - How often to refresh (default: 10 minutes)
   */
  start(intervalMinutes = 10): void {
    if (this.refreshInterval) {
      this.logger.warn('Refresh service already running');
      return;
    }

    const intervalMs = intervalMinutes * 60 * 1000;
    this.logger.info({ intervalMinutes }, 'Starting portfolio history refresh service');

    // Refresh immediately on start
    this.refresh().catch((error) => {
      this.logger.error({ error }, 'Error in initial refresh');
    });

    // Then schedule periodic refreshes
    this.refreshInterval = setInterval(() => {
      this.refresh().catch((error) => {
        this.logger.error({ error }, 'Error in scheduled refresh');
      });
    }, intervalMs);
  }

  /**
   * Stop the periodic refresh
   */
  stop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
      this.logger.info('Stopped portfolio history refresh service');
    }
  }

  /**
   * Manually trigger a refresh
   */
  async refresh(): Promise<void> {
    // Prevent concurrent refreshes
    if (this.isRefreshing) {
      this.logger.debug('Refresh already in progress, skipping');
      return;
    }

    try {
      this.isRefreshing = true;
      const startTime = Date.now();
      this.logger.info('Starting materialized views refresh');

      await this.portfolioHistoryService.refreshMaterializedViews();

      const duration = Date.now() - startTime;
      this.logger.info({ durationMs: duration }, 'Completed materialized views refresh');
    } catch (error) {
      this.logger.error({ error }, 'Failed to refresh materialized views');
      throw error;
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Check if a refresh is currently in progress
   */
  isRefreshInProgress(): boolean {
    return this.isRefreshing;
  }
}
