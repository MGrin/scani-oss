import { db } from '@scani/db/connection';
import { jobHeartbeats } from '@scani/db/schema';
import {
  HEARTBEAT_DAILY_DEADLINE_UTC_HOUR,
  HEARTBEAT_TOLERANCE_MS,
  JOB_HEARTBEAT_PROBE_SCHEDULE,
  missedDailyDeadline,
} from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { captureException } from '@scani/logging/sentry';
import { ScheduledJobProcessor } from '@scani/queue';
import { inArray } from 'drizzle-orm';
import { Service } from 'typedi';

const logger = createComponentLogger('processor:job-heartbeat-probe');

@Service()
export class JobHeartbeatProbeProcessor extends ScheduledJobProcessor {
  readonly descriptor = JOB_HEARTBEAT_PROBE_SCHEDULE;

  protected async handle(): Promise<void> {
    const monitored = Object.keys(HEARTBEAT_TOLERANCE_MS);
    const withDeadline = Object.keys(HEARTBEAT_DAILY_DEADLINE_UTC_HOUR);
    const rows = await db
      .select({
        jobName: jobHeartbeats.jobName,
        lastSuccessAt: jobHeartbeats.lastSuccessAt,
        lastError: jobHeartbeats.lastError,
      })
      .from(jobHeartbeats)
      .where(inArray(jobHeartbeats.jobName, [...monitored, ...withDeadline]));

    const seenAt = new Map<string, Date | null>();
    const errors = new Map<string, string | null>();
    for (const row of rows) {
      seenAt.set(row.jobName, row.lastSuccessAt);
      errors.set(row.jobName, row.lastError);
    }

    const now = Date.now();
    const stale: Array<{ name: string; ageMs: number; tolerance: number }> = [];
    const missing: string[] = [];

    for (const [name, tolerance] of Object.entries(HEARTBEAT_TOLERANCE_MS)) {
      const lastSuccess = seenAt.get(name) ?? null;
      if (!lastSuccess) {
        // Either we've never recorded a heartbeat (fresh deploy of a
        // new job) or this row was reset. Don't fire on the first run
        // — wait until we have at least one historical success to
        // measure against. The boundary case (job hasn't fired in
        // weeks AND never wrote a heartbeat) is rare and surfaces via
        // BullMQ's own scheduler logs.
        continue;
      }
      const ageMs = now - lastSuccess.getTime();
      if (ageMs > tolerance) {
        stale.push({ name, ageMs, tolerance });
      }
    }

    // Jobs declared in tolerance but with no heartbeat row at all
    // after first BullMQ-driven boot: surface separately so the
    // operator can decide if the job is misregistered or merely
    // dormant.
    for (const name of monitored) {
      if (!seenAt.has(name)) {
        missing.push(name);
      }
    }

    // Same first-run rule as above: no heartbeat yet is not a missed deadline.
    const late = Object.entries(HEARTBEAT_DAILY_DEADLINE_UTC_HOUR).filter(([name, hour]) => {
      const lastSuccess = seenAt.get(name) ?? null;
      return lastSuccess !== null && missedDailyDeadline(lastSuccess, new Date(now), hour);
    });
    for (const [name, hour] of late) {
      const lastErr = errors.get(name) ?? null;
      const lastSuccess = seenAt.get(name) as Date;
      const err = new Error(
        `scheduled job '${name}' has not completed today by ${String(hour).padStart(2, '0')}:00 UTC ` +
          `(last success ${lastSuccess.toISOString()})${lastErr ? ` — last error: ${lastErr}` : ''}`
      );
      logger.error(
        { jobName: name, deadlineUtcHour: hour, lastError: lastErr },
        '🚨 Daily deadline missed'
      );
      captureException(err, {
        component: 'worker',
        kind: 'job-deadline-missed',
        jobName: name,
        deadlineUtcHour: String(hour),
      });
    }

    logger.info(
      {
        monitored: monitored.length,
        late: late.length,
        seen: rows.length,
        stale: stale.length,
        missing: missing.length,
      },
      'Job heartbeat probe ran'
    );

    if (stale.length === 0) return;

    for (const entry of stale) {
      const lastErr = errors.get(entry.name) ?? null;
      const err = new Error(
        `scheduled job '${entry.name}' has not reported success for ${formatMs(entry.ageMs)} ` +
          `(tolerance: ${formatMs(entry.tolerance)})${lastErr ? ` — last error: ${lastErr}` : ''}`
      );
      logger.error(
        {
          jobName: entry.name,
          ageMs: entry.ageMs,
          toleranceMs: entry.tolerance,
          lastError: lastErr,
        },
        '🚨 Scheduled job heartbeat overdue'
      );
      captureException(err, {
        component: 'worker',
        kind: 'job-heartbeat-stale',
        jobName: entry.name,
        ageMs: String(entry.ageMs),
        toleranceMs: String(entry.tolerance),
      });
    }
  }
}

function formatMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 24 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))}h`;
  return `${Math.round(ms / (24 * 60 * 60_000))}d`;
}
