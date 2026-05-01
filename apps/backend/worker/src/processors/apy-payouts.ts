import { ApplyApyPayoutsUseCase } from '@scani/domain/use-cases';
import { APY_PAYOUTS_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:apy-payouts');

@Service()
export class ApyPayoutsProcessor extends ScheduledJobProcessor {
  readonly descriptor = APY_PAYOUTS_SCHEDULE;

  protected async handle(): Promise<void> {
    const startTime = Date.now();
    logger.info('Starting APY payouts run');
    try {
      const useCase = Container.get(ApplyApyPayoutsUseCase);
      const result = await useCase.execute();
      logger.info(
        {
          holdingsProcessed: result.holdingsProcessed,
          payoutsApplied: result.payoutsApplied,
          totalInterestApplied: result.totalInterestApplied,
          skipped: result.skipped,
          errorCount: result.errors.length,
          useCaseDurationMs: result.durationMs,
          totalDurationMs: Date.now() - startTime,
        },
        'APY payouts run completed'
      );
      if (result.errors.length > 0) {
        logger.warn(
          { errors: result.errors.map((e) => ({ holdingId: e.holdingId, error: e.error })) },
          'Some holdings failed during APY payouts'
        );
      }
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startTime,
        },
        'APY payouts run failed'
      );
    }
  }
}
