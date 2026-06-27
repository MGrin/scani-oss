import { InstitutionRepository } from '@scani/domain/repositories';
import { STALE_SYNC_PROBE_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { captureException } from '@scani/logging/sentry';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';
import { loadEnv } from '../config/env';

const logger = createComponentLogger('processor:stale-sync-probe');

@Service()
export class StaleSyncProbeProcessor extends ScheduledJobProcessor {
  readonly descriptor = STALE_SYNC_PROBE_SCHEDULE;

  protected async handle(): Promise<void> {
    const repo = Container.get(InstitutionRepository);
    const hours = loadEnv().STALE_SYNC_THRESHOLD_HOURS;
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

    const targets = await repo.findStaleSyncTargets(cutoff);
    logger.info({ count: targets.length, thresholdHours: hours }, 'Stale-sync probed');

    if (targets.length > 0) {
      const names = targets.map((t) => `${t.institutionName}(${t.kind})`).join(', ');
      const err = new Error(
        `${targets.length} integration(s) not syncing past ${hours}h: ${names}. ` +
          'Check credentials/provider for each.'
      );
      logger.error({ count: targets.length, names }, '🚨 Stale integrations detected');
      captureException(err, {
        component: 'worker',
        kind: 'stale-sync-alert',
        count: String(targets.length),
      });
    }
  }
}
