import { UpdateTokenPricesUseCase } from '@scani/domain/use-cases';
import { PRICING_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:pricing');

@Service()
export class PricingProcessor extends ScheduledJobProcessor {
  readonly descriptor = PRICING_SCHEDULE;

  protected async handle(): Promise<void> {
    const startTime = Date.now();
    logger.info('🕐 Starting pricing run');
    try {
      const useCase = Container.get(UpdateTokenPricesUseCase);
      const result = await useCase.execute('USD');
      logger.info(
        {
          tokensFound: result.tokensFound,
          tokensUpdated: result.tokensUpdated,
          tokensFailed: result.tokensFailed,
          errorCount: result.errors.length,
          useCaseDurationMs: result.durationMs,
          totalDurationMs: Date.now() - startTime,
        },
        '✅ Pricing run completed'
      );
      if (result.errors.length > 0) {
        logger.warn(
          { errors: result.errors.map((e) => ({ symbol: e.tokenSymbol, error: e.error })) },
          'Some tokens failed to update'
        );
      }
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startTime,
        },
        '❌ Pricing run failed'
      );
      throw error;
    }
  }
}
