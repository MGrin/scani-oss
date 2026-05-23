import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// Daily UTC sweep that hides holdings whose balance has been zero for
// long enough that they're clearly closed positions, so the user's
// holdings list doesn't accumulate every meme token they ever
// touched. Runs at 04:30 UTC — between the rollup (04:00) and the
// transfer-linker (05:00) so the closed-state snapshot is fresh.
export const HIDE_CLOSED_HOLDINGS_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.hideClosedHoldings,
  cron: '30 4 * * *',
  lockName: JOB_NAMES.hideClosedHoldings,
};
