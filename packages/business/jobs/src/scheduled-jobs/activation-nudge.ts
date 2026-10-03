import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// The one reminder to an account that has added nothing (SC-1503), daily at
// 10:00 UTC: an hour after the alert sweep, so the two never share a wake.
// The lock stops two overlapping fires; `users.activation_nudge_sent_at` is
// what makes a retry safe (see `SendActivationNudgesUseCase`).
export const ACTIVATION_NUDGE_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.activationNudge,
  cron: '0 10 * * *',
  lockName: JOB_NAMES.activationNudge,
};
