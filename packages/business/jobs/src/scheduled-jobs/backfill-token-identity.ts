import type { ScheduledJobStepDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// Heavy sweep (probes every TokenIdentityProvider against every active
// token). A Sunday-only step of the `nightly` group, early in the chain and
// out of weekday peak hours (SC-1688).
export const BACKFILL_TOKEN_IDENTITY_SCHEDULE: ScheduledJobStepDescriptor = {
  name: JOB_NAMES.backfillTokenIdentity,
  lockName: JOB_NAMES.backfillTokenIdentity,
};
