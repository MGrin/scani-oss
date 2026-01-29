import { Service } from 'typedi';
import { createComponentLogger } from '../utils/logger';
// biome-ignore lint/style/useImportType: TypeDI requires the actual class for dependency injection, not just the type
import { PortfolioHistoryService } from './PortfolioHistoryService';

/**
 * Background service to refresh portfolio history materialized views
 * Runs periodically to keep the views up-to-date with recent changes
 */
@Service()
export class PortfolioHistoryRefreshService {
  private readonly logger = createComponentLogger('portfolio-history-refresh');
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private isRefreshing = false;
  private isInitialRefresh = true;
  private intervalMinutes = 10;

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

    this.intervalMinutes = intervalMinutes;
    const intervalMs = intervalMinutes * 60 * 1000;
    this.logger.info({ intervalMinutes }, 'Starting portfolio history refresh service');

    // Start the first refresh asynchronously to avoid blocking startup
    // The initial refresh may take 5-10 minutes with large datasets
    this.refreshAsync();

    // Schedule periodic refreshes
    this.refreshInterval = setInterval(() => {
      this.refreshAsync();
    }, intervalMs);

    this.logger.info('🔄 Portfolio history refresh service started');
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
   * Trigger a refresh asynchronously (non-blocking)
   * This allows the service to start without waiting for the initial refresh
   */
  private refreshAsync(): void {
    // Don't start another refresh if one is already running
    if (this.isRefreshing) {
      this.logger.debug('Refresh already in progress, skipping');
      return;
    }

    // Log appropriate message for initial vs subsequent refreshes
    if (this.isInitialRefresh) {
      this.logger.info(
        'Starting initial materialized views refresh (this may take 5-10 minutes with large datasets)'
      );
    }

    // Execute refresh in background without blocking
    this.refresh()
      .then(() => {
        if (this.isInitialRefresh) {
          this.isInitialRefresh = false;
          this.logger.info(
            { intervalMinutes: this.intervalMinutes },
            'Initial refresh completed - subsequent refreshes will run at the configured interval'
          );
        }
      })
      .catch((error) => {
        const message = this.isInitialRefresh
          ? 'Error in initial refresh'
          : 'Error in scheduled refresh';
        this.logger.error({ error }, message);

        // Mark initial refresh as failed so we can retry on next interval
        if (this.isInitialRefresh) {
          this.logger.warn('Initial refresh failed - will retry on next interval');
        }
      });
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
