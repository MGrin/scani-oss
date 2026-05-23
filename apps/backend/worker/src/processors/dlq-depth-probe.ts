import { DLQ_DEPTH_PROBE_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { captureException } from '@scani/logging/sentry';
import { ScheduledJobProcessor, WorkerClient } from '@scani/queue';
import { Container, Service } from 'typedi';
import { loadEnv } from '../config/env';

const logger = createComponentLogger('processor:dlq-depth-probe');

@Service()
export class DlqDepthProbeProcessor extends ScheduledJobProcessor {
  readonly descriptor = DLQ_DEPTH_PROBE_SCHEDULE;

  protected async handle(): Promise<void> {
    const workerClient = Container.get(WorkerClient);
    const depth = await workerClient.getDlqDepth();
    // Validated + parsed at boot — see apps/backend/worker/src/config/env.ts.
    const threshold = loadEnv().DLQ_ALERT_THRESHOLD;

    // Always emit a structured log so the existing pino-based dashboards
    // can graph the trend even when we're below the alert threshold.
    logger.info({ depth, threshold }, 'DLQ depth probed');

    if (depth >= threshold) {
      const err = new Error(
        `DLQ depth ${depth} crossed alert threshold ${threshold}. ` +
          'Inspect failed jobs in admin/services/bullmq and decide retry vs purge.'
      );
      logger.error({ depth, threshold }, '🚨 DLQ depth crossed alert threshold');
      captureException(err, {
        component: 'worker',
        kind: 'dlq-depth-alert',
        depth: String(depth),
        threshold: String(threshold),
      });
    }
  }
}
