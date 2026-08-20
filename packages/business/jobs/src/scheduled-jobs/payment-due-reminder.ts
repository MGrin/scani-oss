import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// One push a day, at ~17:00 in the user's OWN local time, summarising the
// payments due on their local tomorrow (SC-226).
//
// **Hourly, not daily, and that is the whole design.** A single daily fire
// happens at one UTC hour, and one UTC hour is a different clock time in every
// zone — 17:00 UTC is 01:00 in Singapore. So the job wakes each hour and
// selects the users for whom it is currently 17:00 locally. Each user is
// therefore reminded exactly once a day, by their own clock, and the job does
// nothing at all for the other 23 fires of theirs.
//
// Minute 5 rather than 0: the quarter-hour-aligned probes already cluster on
// :00/:15/:30/:45 so their advisory locks batch into one wake and Neon can
// scale to zero between them. This reads payments and pushes, has no reason to
// contend with them, and five minutes past the hour is still "around 5PM".
//
// The advisory lock is what makes a retry safe: being told twice that $500 is
// due tomorrow is worse than being told once, because the second one teaches
// you to distrust the first.
export const PAYMENT_DUE_REMINDER_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.paymentDueReminder,
  cron: '5 * * * *',
  lockName: JOB_NAMES.paymentDueReminder,
};
