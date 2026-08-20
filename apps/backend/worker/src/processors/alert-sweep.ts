import { SendIntegrationAlertsUseCase } from '@scani/domain/use-cases';
import { ALERT_SWEEP_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';
import { loadEnv } from '../config/env';

const logger = createComponentLogger('processor:alert-sweep');

/**
 * The daily alert sweep (SC-459) — the first thing this product says to a user
 * that a user did not ask for.
 *
 * One rule today: an integration they connected has stopped syncing, which
 * `stale-sync-probe` has been reporting to Sentry every hour for months while
 * the person whose figures are wrong was told nothing. A second rule is a new
 * use case called from `handle` and a new `rule` string in `alert_deliveries`;
 * nothing here has to change shape for it.
 *
 * The two public URLs are read HERE and passed down rather than inside the use
 * case, for the reason `WeeklyDigestProcessor` states: an app owns its own env,
 * and `@scani/domain` is imported by the api and data-provider too.
 */
@Service()
export class AlertSweepProcessor extends ScheduledJobProcessor {
  readonly descriptor = ALERT_SWEEP_SCHEDULE;

  protected async handle(): Promise<void> {
    const start = Date.now();
    const env = loadEnv();
    try {
      const integrations = await Container.get(SendIntegrationAlertsUseCase).execute({
        appUrl: env.FRONTEND_URL ?? '',
        unsubscribeBaseUrl: env.BACKEND_URL ?? '',
        staleAfterHours: env.ALERT_STALE_SYNC_HOURS,
      });
      // Every counter separately, and logged even when all are zero. "0 sent"
      // is produced by a deployment with no URLs, by a userbase whose
      // integrations are all healthy, and by one where every affected account
      // has already been told — and those three need different people to do
      // different things.
      logger.info(
        { rule: 'integration-stale', ...integrations, totalMs: Date.now() - start },
        '✅ Alert sweep'
      );
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          totalMs: Date.now() - start,
        },
        '❌ Alert sweep failed'
      );
      throw error;
    }
  }
}
