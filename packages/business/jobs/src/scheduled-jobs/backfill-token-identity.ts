import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// Heavy sweep (probes every TokenIdentityProvider against every active
// token). Weekly Sunday 02:00 UTC keeps it well off the nightly chain
// and out of weekday peak hours.
export const BACKFILL_TOKEN_IDENTITY_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.backfillTokenIdentity,
  cron: '0 2 * * 0',
  lockName: JOB_NAMES.backfillTokenIdentity,
};
