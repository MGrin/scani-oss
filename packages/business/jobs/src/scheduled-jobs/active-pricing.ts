import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// The crypto open apps show, every 15 minutes (SC-1602). A minute after the
// quarter-hour probes, so it lands in a burst that already woke the database
// without adding a fifth job to theirs.
export const ACTIVE_PRICING_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.activePricing,
  cron: '3-59/15 * * * *',
  lockName: JOB_NAMES.activePricing,
};
