import { SendWeeklyDigestsUseCase } from '@scani/domain/use-cases';
import { WEEKLY_DIGEST_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';
import { loadEnv } from '../config/env';

const logger = createComponentLogger('processor:weekly-digest');

/**
 * The Monday-morning digest (SC-460) — the first email this worker sends.
 *
 * The two public URLs are read HERE and passed down rather than read inside
 * the use case, because an app owns its own env: `@scani/domain` is imported
 * by the api and the data-provider too, and a service that reached for
 * `process.env.FRONTEND_URL` would silently pick up a different answer in each
 * of them.
 *
 * The descriptor's `lockName` makes two overlapping fires no-op rather than
 * race. It does not make a RETRY safe — see `DIGEST_COOLDOWN_MS`.
 */
@Service()
export class WeeklyDigestProcessor extends ScheduledJobProcessor {
  readonly descriptor = WEEKLY_DIGEST_SCHEDULE;

  protected async handle(): Promise<void> {
    const start = Date.now();
    const env = loadEnv();
    try {
      const summary = await Container.get(SendWeeklyDigestsUseCase).execute({
        appUrl: env.FRONTEND_URL ?? '',
        unsubscribeBaseUrl: env.BACKEND_URL ?? '',
      });
      // Every counter separately, and logged even when all are zero: "0 sent"
      // is produced by a deployment with no URLs, by a userbase with nothing
      // in it, and by a nightly rollup that has stopped running, and those
      // three need different people to do different things.
      logger.info({ ...summary, totalMs: Date.now() - start }, '✅ Weekly digest sweep');
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          totalMs: Date.now() - start,
        },
        '❌ Weekly digest sweep failed'
      );
      throw error;
    }
  }
}
