import { withTransaction } from '@scani/db/transaction';
import { TokenPriceRepository } from '@scani/domain/repositories';
import {
  TOKEN_PRICES_DOWNSAMPLE_SCHEDULE,
  TOKEN_PRICES_INTRADAY_RETENTION_DAYS,
} from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:token-prices-downsample');

// The first run collapses the whole intraday backlog (tens of thousands of
// rows), so the transaction needs far more than the 5s default. Steady-state
// runs only touch one newly-aged day and finish quickly.
const TX_TIMEOUT_MS = 120_000;

@Service()
export class TokenPricesDownsampleProcessor extends ScheduledJobProcessor {
  readonly descriptor = TOKEN_PRICES_DOWNSAMPLE_SCHEDULE;

  protected async handle(): Promise<void> {
    const startTime = Date.now();
    logger.info(
      { retentionDays: TOKEN_PRICES_INTRADAY_RETENTION_DAYS },
      '🕐 Starting token-price downsample'
    );
    try {
      const repo = Container.get(TokenPriceRepository);
      const { aggregated, deleted } = await withTransaction(
        (tx) => repo.downsampleIntradayToDaily(TOKEN_PRICES_INTRADAY_RETENTION_DAYS, tx),
        { name: 'token-prices-downsample', timeout: TX_TIMEOUT_MS }
      );
      logger.info(
        {
          aggregated,
          deleted,
          retentionDays: TOKEN_PRICES_INTRADAY_RETENTION_DAYS,
          totalMs: Date.now() - startTime,
        },
        '✅ Token-price downsample complete'
      );
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          totalMs: Date.now() - startTime,
        },
        '❌ Token-price downsample failed'
      );
      throw error;
    }
  }
}
