/**
 * ApyPayoutsCronJob
 *
 * Cron job that runs daily to apply APY interest payouts.
 * Checks all holdings with active APY configurations and applies
 * due interest payments, with catch-up for missed days.
 *
 * Schedule: Daily at midnight UTC
 */

import { ApplyApyPayoutsUseCase } from '@scani/core/use-cases';
import { createComponentLogger } from '@scani/core/utils/logger';
import { Container } from 'typedi';

const logger = createComponentLogger('cron:apy-payouts');

/**
 * Execute the APY payouts cron job
 */
export async function executeApyPayoutsCronJob(): Promise<void> {
  const startTime = Date.now();
  logger.info('Starting APY payouts cron job');

  try {
    const useCase = Container.get(ApplyApyPayoutsUseCase);
    const result = await useCase.execute();

    const durationMs = Date.now() - startTime;

    logger.info(
      {
        holdingsProcessed: result.holdingsProcessed,
        payoutsApplied: result.payoutsApplied,
        totalInterestApplied: result.totalInterestApplied,
        skipped: result.skipped,
        errorCount: result.errors.length,
        useCaseDurationMs: result.durationMs,
        totalDurationMs: durationMs,
      },
      'APY payouts cron job completed successfully'
    );

    if (result.errors.length > 0) {
      logger.warn(
        {
          errors: result.errors.map((e) => ({
            holdingId: e.holdingId,
            error: e.error,
          })),
        },
        'Some holdings failed during APY payouts cron job'
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
      'APY payouts cron job failed'
    );
  }
}
