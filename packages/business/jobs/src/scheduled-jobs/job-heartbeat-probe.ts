import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// Scheduled liveness probe over `job_heartbeats`. Every 10 minutes the
// worker reads the heartbeat row for each known scheduled job and
// escalates to Sentry whenever a job's `last_success_at` falls behind
// its expected interval × tolerance. Without this, a silently stuck
// job (worker crashed mid-deploy, advisory lock collision burning
// repeatedly, BullMQ scheduler glitch) goes unnoticed until users
// notice stale data.
//
// Advisory lock keeps two machines from double-paging when both probe
// at the same minute. The probe itself is idempotent and read-only.
export const JOB_HEARTBEAT_PROBE_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.jobHeartbeatProbe,
  cron: '*/10 * * * *',
  lockName: JOB_NAMES.jobHeartbeatProbe,
};

// Tolerance map per job — how stale a heartbeat may be before we page.
// Values are milliseconds. The map is centralised here rather than
// per-job so changes ride a single PR; defaults err on the side of
// noise (page sooner) since false positives are cheap to investigate
// and false negatives lose data freshness.
//
// Each entry is read by the probe processor against the corresponding
// row in `job_heartbeats`. Jobs not listed here are skipped — newly
// added jobs must opt in here so we don't get noise from a one-off
// repeatable that nobody monitors.
export const HEARTBEAT_TOLERANCE_MS: Readonly<Record<string, number>> = {
  // Hourly cadence (1h) — alert at 2h.
  [JOB_NAMES.pricing]: 2 * 60 * 60 * 1000,
  [JOB_NAMES.walletBalances]: 2 * 60 * 60 * 1000,
  [JOB_NAMES.exchangeBalances]: 2 * 60 * 60 * 1000,
  // Daily cadence — alert at 36h (gives a missed run + the next one).
  [JOB_NAMES.apyPayouts]: 36 * 60 * 60 * 1000,
  [JOB_NAMES.historicalPriceBackfill]: 36 * 60 * 60 * 1000,
  [JOB_NAMES.forexBackfill]: 36 * 60 * 60 * 1000,
  [JOB_NAMES.portfolioValueRollup]: 36 * 60 * 60 * 1000,
  [JOB_NAMES.transferLinking]: 36 * 60 * 60 * 1000,
  [JOB_NAMES.hideClosedHoldings]: 36 * 60 * 60 * 1000,
  // Weekly cadence — alert at 9 days.
  [JOB_NAMES.backfillTokenIdentity]: 9 * 24 * 60 * 60 * 1000,
  // Every-minute reconcilers — 30min tolerance is conservative; if
  // the worker has been stuck for half an hour something is very
  // wrong.
  [JOB_NAMES.reconcilePendingCredentials]: 30 * 60 * 1000,
  [JOB_NAMES.reconcileOrphanedUserJobs]: 30 * 60 * 1000,
  // Every 5min — alert at 30min.
  [JOB_NAMES.dlqDepthProbe]: 30 * 60 * 1000,
};
