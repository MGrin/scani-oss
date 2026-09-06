import type { ScheduledJobDescriptor } from '@scani/queue';
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
// 06:00 UTC: after the whole nightly chain has finished writing (the last of it
// is `backfill-counterparty` at 05:30), so the dump captures a settled state
// rather than racing the rollup. It is also ~11h from the laptop's 19:30 UTC
// fire, which halves the worst-case exposure while both exist.
//
// `lockName` is what puts this under the Postgres advisory lock —
// `ScheduledJobProcessor` wraps `handle()` in `JOB_LOCK` whenever it is set.
// Two overlapping fires would otherwise take two dumps of the same database
// and race each other's upload.
export const DB_BACKUP_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.dbBackup,
  cron: '0 6 * * *',
  lockName: JOB_NAMES.dbBackup,
};
