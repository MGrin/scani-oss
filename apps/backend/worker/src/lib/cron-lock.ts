import { withAdvisoryLock } from '@scani/db';
import { createComponentLogger } from '@scani/logging';

const logger = createComponentLogger('cron:lock');

/**
 * Worker-flavored wrapper around `@scani/db` advisory locks for cron-style
 * jobs. Adds the structured logs we want at the cron layer (acquire /
 * release / skipped) on top of the shared mutex primitive.
 *
 * Returns `{ ran: true, result }` on success and `{ ran: false }` when
 * another process holds the lock — cron jobs are idempotent by design,
 * so the next tick will pick the work up.
 */
export async function withJobLock<T>(
  jobName: string,
  fn: () => Promise<T>
): Promise<{ ran: true; result: T } | { ran: false }> {
  const outcome = await withAdvisoryLock(jobName, async () => {
    logger.info({ jobName }, '🔓 Acquired cron advisory lock');
    try {
      return await fn();
    } finally {
      logger.info({ jobName }, '🔓 Released cron advisory lock');
    }
  });
  if (!outcome.ran) {
    logger.warn({ jobName }, '🔒 Cron job skipped — another instance holds the advisory lock');
  }
  return outcome;
}
