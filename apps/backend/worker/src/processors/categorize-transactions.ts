import { withTransaction } from '@scani/db/transaction';
import { AiCategorySuggester, KindCategoryAssigner } from '@scani/domain/services';
import { CATEGORIZE_TRANSACTIONS_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:categorize-transactions');
// Nobody new starts after this, so the people already started finish inside
// the step's 30-minute timeout. The rest go first next hour (SC-1704).
const AI_STEP_BUDGET_MS = 20 * 60_000;

/**
 * Hourly categorizing. First every user's rows with no payee text, by their
 * transaction type, with no AI (SC-1720). Then AI category suggestions for
 * each person who turned them on (SC-1695). One failure is logged and the
 * rest still runs; whatever was missed is done on the next hour.
 */
@Service()
export class CategorizeTransactionsProcessor extends ScheduledJobProcessor {
  readonly descriptor = CATEGORIZE_TRANSACTIONS_SCHEDULE;

  protected now(): number {
    return Date.now();
  }

  protected async handle(): Promise<void> {
    try {
      const written = await withTransaction((tx) => Container.get(KindCategoryAssigner).apply(tx), {
        name: 'kind-categories',
        timeout: 120_000,
      });
      if (written > 0) logger.info({ written }, 'Categorized by transaction type');
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : error },
        'Categorizing by transaction type failed; the next hour retries'
      );
    }
    const suggester = Container.get(AiCategorySuggester);
    const started = this.now();
    const people = await suggester.optedInUsers();
    for (const [index, userId] of people.entries()) {
      if (this.now() - started >= AI_STEP_BUDGET_MS) {
        logger.info(
          { left: people.length - index },
          'AI category step out of time; the rest go first next hour'
        );
        break;
      }
      try {
        const run = await suggester.run(userId);
        if (run.asked > 0 || run.reused > 0) {
          logger.info(
            {
              userId,
              asked: run.asked,
              written: run.written,
              reused: run.reused,
              stopped: run.stopped,
            },
            'AI category suggestions written'
          );
        }
        // The hour's categorize share is spent: everyone after would only
        // fail their first call.
        if (run.stopped === 'budget') break;
      } catch (error) {
        logger.warn(
          { userId, error: error instanceof Error ? error.message : error },
          'AI category suggestions failed for one user; the next hour retries'
        );
      }
    }
  }
}
