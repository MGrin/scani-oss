import { SendActivationNudgesUseCase } from '@scani/domain/use-cases';
import { ACTIVATION_NUDGE_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';
import { loadEnv, type WorkerEnv } from '../config/env';

const logger = createComponentLogger('processor:activation-nudge');

/**
 * The one reminder to an account with nothing added (SC-1503).
 *
 * Shipped OFF. The schedule is registered unconditionally, as `DemoResetProcessor`
 * is, so arming it is one env var rather than a deploy; until
 * `ACTIVATION_NUDGE_ENABLED=1` each run is a logged no-op. The first production
 * send waits on mgrin approving the copy and on the privacy page being live,
 * and `PRIVACY_URL` unset is a second, independent refusal.
 */
@Service()
export class ActivationNudgeProcessor extends ScheduledJobProcessor {
  readonly descriptor = ACTIVATION_NUDGE_SCHEDULE;

  /** The four variables this job reads; a seam so a test need not boot the worker's env. */
  protected readEnv(): Pick<
    WorkerEnv,
    'ACTIVATION_NUDGE_ENABLED' | 'FRONTEND_URL' | 'BACKEND_URL' | 'PRIVACY_URL'
  > {
    return loadEnv();
  }

  protected async handle(): Promise<void> {
    const env = this.readEnv();
    if (env.ACTIVATION_NUDGE_ENABLED !== '1') {
      logger.info({}, '⏭️  Activation nudge skipped: ACTIVATION_NUDGE_ENABLED is not 1');
      return;
    }
    const start = Date.now();
    try {
      const summary = await Container.get(SendActivationNudgesUseCase).execute({
        appUrl: env.FRONTEND_URL ?? '',
        unsubscribeBaseUrl: env.BACKEND_URL ?? '',
        privacyUrl: env.PRIVACY_URL ?? '',
      });
      logger.info({ ...summary, totalMs: Date.now() - start }, '✅ Activation nudge sweep');
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          totalMs: Date.now() - start,
        },
        '❌ Activation nudge sweep failed'
      );
      throw error;
    }
  }
}
