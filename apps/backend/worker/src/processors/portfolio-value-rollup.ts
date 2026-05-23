import { RollupPortfolioValueDailyUseCase } from '@scani/domain/use-cases';
import { PORTFOLIO_VALUE_ROLLUP_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:portfolio-value-rollup');

@Service()
export class PortfolioValueRollupProcessor extends ScheduledJobProcessor {
  readonly descriptor = PORTFOLIO_VALUE_ROLLUP_SCHEDULE;

  protected async handle(): Promise<void> {
    const startTime = Date.now();
    logger.info('🕐 Starting portfolio value rollup');
    try {
      const useCase = Container.get(RollupPortfolioValueDailyUseCase);
      const summary = await useCase.execute({ lookbackDays: 30 });
      logger.info(
        {
          usersProcessed: summary.usersProcessed,
          daysComputed: summary.daysComputed,
          errorCount: summary.errors.length,
          totalMs: Date.now() - startTime,
        },
        '✅ Portfolio value rollup complete'
      );
      if (summary.errors.length > 0) {
        logger.warn(
          { errors: summary.errors.slice(0, 10) },
          'Some users failed to roll up (showing first 10)'
        );
      }
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          totalMs: Date.now() - startTime,
        },
        '❌ Portfolio value rollup failed'
      );
      throw error;
    }
  }
}
