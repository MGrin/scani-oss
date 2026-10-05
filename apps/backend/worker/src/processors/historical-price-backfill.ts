import { PriceHubResolver } from '@scani/domain/services';
import {
  BackfillBenchmarkPricesUseCase,
  BackfillHistoricalPricesUseCase,
} from '@scani/domain/use-cases';
import { HISTORICAL_PRICE_BACKFILL_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

@Service()
export class HistoricalPriceBackfillProcessor extends ScheduledJobProcessor {
  readonly descriptor = HISTORICAL_PRICE_BACKFILL_SCHEDULE;
  private readonly logger = createComponentLogger('processor:historical-price-backfill');

  protected async handle(): Promise<void> {
    const startTime = Date.now();
    this.logger.info('🕐 Starting historical price backfill');
    try {
      // USD is the canonical quote for the backfill graph's hub. Every
      // supported historical provider returns in USD natively; display
      // bases derive via the fiat rows backfilled by the forex job.
      const usdTokenId = await Container.get(PriceHubResolver).usdTokenId();
      const useCase = Container.get(BackfillHistoricalPricesUseCase);
      const summary = await useCase.execute({ usdTokenId });
      this.logger.info(
        {
          attempted: summary.attempted,
          inserted: summary.inserted,
          alreadyHad: summary.alreadyHad,
          providerMissing: summary.providerMissing,
          droppedDays: summary.droppedDays,
          droppedBars: summary.droppedBars,
          totalMs: Date.now() - startTime,
        },
        '✅ Historical price backfill complete'
      );
      await this.backfillBenchmarks(usdTokenId);
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          totalMs: Date.now() - startTime,
        },
        '❌ Historical price backfill failed'
      );
      throw error;
    }
  }

  /**
   * The returns card's comparison lines (SC-464). Logged and swallowed: a
   * benchmark nobody holds must never be the reason a holding goes unpriced.
   */
  private async backfillBenchmarks(usdTokenId: string): Promise<void> {
    try {
      await Container.get(BackfillBenchmarkPricesUseCase).execute({ usdTokenId });
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        '❌ Benchmark price backfill failed'
      );
    }
  }
}
