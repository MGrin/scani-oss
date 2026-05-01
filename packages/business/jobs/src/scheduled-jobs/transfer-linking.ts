import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// Independent of the price chain — runs at 5 AM so the linker sees a
// fresh ledger including overnight imports.
export const TRANSFER_LINKING_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.transferLinking,
  cron: '0 5 * * *',
  lockName: JOB_NAMES.transferLinking,
};
