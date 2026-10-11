import type { ScheduledJobStepDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// Daily UTC sweep that hides holdings whose balance has been zero for
// long enough that they're clearly closed positions, so the user's
// holdings list doesn't accumulate every meme token they ever
// touched. A step of the `nightly` group, right after the rollup, so the
// closed-state snapshot is fresh.
export const HIDE_CLOSED_HOLDINGS_SCHEDULE: ScheduledJobStepDescriptor = {
  name: JOB_NAMES.hideClosedHoldings,
  lockName: JOB_NAMES.hideClosedHoldings,
};
