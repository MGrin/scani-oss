import type { ScheduledJobStepDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// The one reminder to an account that has added nothing (SC-1503). A step of
// the `morning` group, after the alert sweep (SC-1688).
// The lock stops two overlapping fires; `users.activation_nudge_sent_at` is
// what makes a retry safe (see `SendActivationNudgesUseCase`).
export const ACTIVATION_NUDGE_SCHEDULE: ScheduledJobStepDescriptor = {
  name: JOB_NAMES.activationNudge,
  lockName: JOB_NAMES.activationNudge,
};
