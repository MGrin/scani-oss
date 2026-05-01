import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { BackfillHistoricalPricesUseCase } from '@scani/domain/use-cases';
import { HISTORICAL_PRICE_BACKFILL_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:historical-price-backfill');

@Service()
export class HistoricalPriceBackfillProcessor extends ScheduledJobProcessor {
  readonly descriptor = HISTORICAL_PRICE_BACKFILL_SCHEDULE;

  protected async handle(): Promise<void> {
    const startTime = Date.now();
    logger.info('🕐 Starting historical price backfill');
    try {
      // USD is the canonical quote for the backfill graph's hub. Every
      // supported historical provider returns in USD natively; display
      // bases derive via the fiat rows backfilled by the forex job.
      const usdRow = await db
        .select({ id: schema.tokens.id })
        .from(schema.tokens)
        .where(eq(schema.tokens.symbol, 'USD'))
        .limit(1);
      const usdTokenId = usdRow[0]?.id;
      if (!usdTokenId) {
        logger.warn('No USD token in database; skipping historical price backfill');
        return;
      }
      const useCase = Container.get(BackfillHistoricalPricesUseCase);
      const summary = await useCase.execute({ usdTokenId });
      logger.info(
        {
          attempted: summary.attempted,
          inserted: summary.inserted,
          alreadyHad: summary.alreadyHad,
          providerMissing: summary.providerMissing,
          totalMs: Date.now() - startTime,
        },
        '✅ Historical price backfill complete'
      );
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          totalMs: Date.now() - startTime,
        },
        '❌ Historical price backfill failed'
      );
      throw error;
    }
  }
}
