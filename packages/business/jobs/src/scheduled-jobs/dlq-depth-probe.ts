import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// DLQ-depth observability sweeper. Every 15 minutes the worker reads the
// `scani-dlq` queue's pending count, emits structured logs, and (when
// the depth crosses a threshold) escalates to Sentry. Without this,
// terminal failures pile up silently — the existing 14-day age cap on
// DLQ entries means a steady drip can accumulate thousands of entries
// before anyone notices in the admin UI. The advisory lock keeps two
// machines from double-firing the Sentry alert when both run a probe at
// the same minute (the depth read itself is idempotent and cheap, but
// the alert event isn't) — and it's exactly why this probe is on the
// shared quarter-hour cadence: the PG advisory lock wakes Neon, so all
// frequent jobs fire together and the DB sleeps in between.
export const DLQ_DEPTH_PROBE_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.dlqDepthProbe,
  cron: '*/15 * * * *',
  lockName: JOB_NAMES.dlqDepthProbe,
};
