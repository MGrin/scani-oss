/**
 * PricingCronJob
 *
 * Cron job that runs every 30 minutes to update token prices.
 * Updates only token prices that are attached to at least 1 holding.
 *
 * Schedule: Every 30 minutes at :00 and :30
 */

import { UpdateTokenPricesUseCase } from '@scani/core/use-cases';
import { createComponentLogger } from '@scani/core/utils/logger';
import { Container } from 'typedi';

const logger = createComponentLogger('cron:pricing');

/**
 * Execute the pricing cron job
 */
export async function executePricingCronJob(): Promise<void> {
  const startTime = Date.now();
  logger.info('🕐 Starting pricing cron job');

  try {
    const updateTokenPricesUseCase = Container.get(UpdateTokenPricesUseCase);
    const result = await updateTokenPricesUseCase.execute('USD');

    const durationMs = Date.now() - startTime;

    logger.info(
      {
        tokensFound: result.tokensFound,
        tokensUpdated: result.tokensUpdated,
        tokensFailed: result.tokensFailed,
        errorCount: result.errors.length,
        useCaseDurationMs: result.durationMs,
        totalDurationMs: durationMs,
      },
      '✅ Pricing cron job completed successfully'
    );

    // Log errors if any
    if (result.errors.length > 0) {
      logger.warn(
        {
          errors: result.errors.map((e) => ({
            symbol: e.tokenSymbol,
            error: e.error,
          })),
        },
        'Some tokens failed to update during pricing cron job'
      );
    }
  } catch (error) {
    const durationMs = Date.now() - startTime;
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        durationMs,
      },
      '❌ Pricing cron job failed'
    );
    // Don't throw - let the cron job continue on next schedule
  }
}
