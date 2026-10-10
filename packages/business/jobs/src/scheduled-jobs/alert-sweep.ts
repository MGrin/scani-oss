import type { ScheduledJobStepDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// One pass over the alert rules a day: the first step of the `morning` group,
// 09:00 UTC (SC-459, SC-1688).
//
// **Daily, not hourly, even though the fault is detected hourly.** The signal
// underneath this is `findStaleSyncTargets`, which `stale-sync-probe` already
// runs every hour at a 3-hour threshold — the right cadence for paging US,
// because two missed sync cycles is a bug we want to see today. It is the wrong
// cadence for telling a USER: their integration will be exactly as broken in
// twelve hours, and the only thing a tighter loop buys is the chance to reach
// them at 04:00. The user-facing threshold is `ALERT_STALE_SYNC_HOURS`
// (default 24) for the same reason.
//
// **An hour after the Monday digest.** The `morning` group runs at 09:00 and
// `weekly-digest` keeps a schedule of its own at 08:00, so a Monday never
// delivers a digest and an alert in the same second, which reads as one system
// mailing twice.
//
// The advisory lock makes two overlapping fires no-op rather than race. It does
// NOT make a retry safe: a run that mailed half the affected accounts and then
// threw takes the lock cleanly on the retry. `alert_deliveries` carries that
// guarantee — see `AlertDeliveryRepository`.
export const ALERT_SWEEP_SCHEDULE: ScheduledJobStepDescriptor = {
  name: JOB_NAMES.alertSweep,
  lockName: JOB_NAMES.alertSweep,
};
