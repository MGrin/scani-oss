import type { ScheduledJobStepDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// Foundation A1's nightly shadow (D-10): the new engine's balances beside
// today's stored ones, every difference stored with its cause in
// `engine_shadow_differences`. It writes only its report tables. Removed at
// the flip (A5).
//
// A step of the `nightly` group, after the rollup has finished writing, so it
// compares the day's settled state (SC-1688). The advisory lock keeps two
// machines from running it at once. A failed attempt is retried inside the
// run, and a retry runs only the kinds no earlier attempt recorded
// (`EngineShadowProcessor`).
export const ENGINE_SHADOW_SCHEDULE: ScheduledJobStepDescriptor = {
  name: JOB_NAMES.engineShadow,
  lockName: JOB_NAMES.engineShadow,
};
