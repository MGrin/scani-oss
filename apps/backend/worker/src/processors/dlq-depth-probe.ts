import { DLQ_DEPTH_PROBE_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { captureException } from '@scani/logging/sentry';
import { ScheduledJobProcessor, WorkerClient } from '@scani/queue';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:dlq-depth-probe');

// Above this depth we surface a Sentry event so on-call gets paged. The
// floor (default 50) is overridable via env so OSS / dev can tune it
// without a code change.
const DEFAULT_ALERT_THRESHOLD = 50;

function getAlertThreshold(): number {
  const raw = process.env.DLQ_ALERT_THRESHOLD;
  if (!raw) return DEFAULT_ALERT_THRESHOLD;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ALERT_THRESHOLD;
}

@Service()
export class DlqDepthProbeProcessor extends ScheduledJobProcessor {
  readonly descriptor = DLQ_DEPTH_PROBE_SCHEDULE;

  protected async handle(): Promise<void> {
    const workerClient = Container.get(WorkerClient);
    const depth = await workerClient.getDlqDepth();
    const threshold = getAlertThreshold();

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
