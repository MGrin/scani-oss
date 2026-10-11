import type { ScheduledJobStepDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// The offsite database dump (SC-793).
//
// WHY IT IS HERE AND NOT IN CI. `.github/workflows/backup-db.yaml` took this
// weekly and last succeeded 2026-08-09; runs after that reported `failure` in
// ~2s having executed zero steps, which is the Actions billing block (SC-128,
// SC-433) reaching a durability control rather than a check. A durability
// control may not ride on that at all: it FLAPS (SC-1023), so a window where
// it happens to run is not coverage. The only thing
// still taking dumps was a LaunchAgent on one laptop, and `StartCalendarInterval`
// skips an occurrence outright when the Mac was powered off — three misses in
// thirteen days. Neither failure mode announces itself: a run that never starts
// has no code executing to report itself.
//
// DAILY, not weekly. Weekly was the offsite tier; daily was the cadence
// actually being relied on. This machine runs whether or not anybody is awake.
//
// The LAST step of the `nightly` group (SC-1688): after the whole chain has
// finished writing, so the dump captures a settled state rather than racing
// the rollup. A failed or timed-out earlier step does not skip it, and
// `job-heartbeat-probe` alerts when no backup has completed by 07:00 UTC.
//
// `lockName` is what puts this under the Postgres advisory lock —
// `ScheduledJobProcessor` wraps `handle()` in `JOB_LOCK` whenever it is set.
// Two overlapping fires would otherwise take two dumps of the same database
// and race each other's upload.
export const DB_BACKUP_SCHEDULE: ScheduledJobStepDescriptor = {
  name: JOB_NAMES.dbBackup,
  lockName: JOB_NAMES.dbBackup,
};
