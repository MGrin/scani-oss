import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// Hourly safety net: detects active, credentialed integrations that have
// silently stopped syncing (stale lastSync) or never produced an account,
// and escalates to Sentry. Mirrors dlq-depth-probe. The advisory lock
// keeps two machines from double-firing the Sentry alert.
export const STALE_SYNC_PROBE_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.staleSyncProbe,
  cron: '0 * * * *',
  lockName: JOB_NAMES.staleSyncProbe,
};
