import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// Hourly safety net: detects active, credentialed integrations that have
// silently stopped syncing (stale lastSync) or never produced an account,
// and escalates to Sentry. Mirrors dlq-depth-probe. The advisory lock
// keeps two machines from double-firing the Sentry alert.
export const STALE_SYNC_PROBE_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.staleSyncProbe,
  cron: '0 * * * *',
  lockName: JOB_NAMES.staleSyncProbe,
};

/**
 * The alarm this probe opens conditions under, in `operator_alarms`.
 *
 * Written into every row, so it is part of the stored contract: renaming it
 * orphans every open condition and re-escalates all of them at once.
 */
export const STALE_SYNC_ALARM = 'stale-sync';

/**
 * How long a broken integration may stay open without being re-stated (SC-870).
 *
 * Firing only on the transition removes the repetition and introduces the
 * opposite risk: a condition that persists for a month with no signal at all.
 * That is the quieter failure of the two and needs a bound, not an argument.
 *
 * A week is chosen against the thing a repeating alarm hides. The signals that
 * get buried are the low-frequency ones — a job that fails once a day is the
 * canonical case — so the re-statement has to sit comfortably BELOW their
 * frequency. At 168h a permanently broken integration contributes one event a
 * week and can no longer outnumber, let alone bury, a daily signal. A 24h
 * window would put the two at parity and hand the persistent one back the
 * advantage it just lost; much longer and a real condition can go a month
 * unmentioned, which is what this constant exists to bound rather than cause.
 *
 * A constant and not an env var: `HEARTBEAT_TOLERANCE_MS` and
 * `ALERT_CLAIM_TTL_MS` are the same kind of number, and none of them is
 * something a deployment tunes — changing it is a decision about what the
 * alarm means, which belongs in a diff.
 */
export const STALE_SYNC_RENOTIFY_MS = 7 * 24 * 60 * 60 * 1000;
