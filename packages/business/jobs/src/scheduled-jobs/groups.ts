import type { ScheduledJobGroupDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// The grouped schedules (SC-1688). 26 schedules became these four, plus
// `active-pricing` and `weekly-digest`, which keep schedules of their own.
// Each step runs through its own processor, lock, retry and heartbeat
// (`ScheduledJobGroupProcessor`); a failed step never skips a later one.

const sundaysOnly = (at: Date) => at.getUTCDay() === 0;

// The four quarter-hour probes and reconcilers. Two minutes past each quarter,
// so they do not queue behind the :00 syncs (SC-1601); that is inside Neon's
// 300s suspend timeout, so the database still idles between bursts.
export const HOUSEKEEPING_SCHEDULE: ScheduledJobGroupDescriptor = {
  name: JOB_NAMES.housekeeping,
  cron: '2-59/15 * * * *',
  steps: [
    { name: JOB_NAMES.dlqDepthProbe },
    { name: JOB_NAMES.jobHeartbeatProbe },
    { name: JOB_NAMES.reconcileOrphanedUserJobs },
    { name: JOB_NAMES.reconcilePendingCredentials },
  ],
};

// The stale-sync probe reads the `lastSync` the two balance syncs just wrote.
// The payment reminder selects users for whom it is 17:00 locally, so it must
// run inside the hour the group started in.
export const HOURLY_SCHEDULE: ScheduledJobGroupDescriptor = {
  name: JOB_NAMES.hourly,
  cron: '0 * * * *',
  steps: [
    { name: JOB_NAMES.pricing },
    { name: JOB_NAMES.walletBalances },
    { name: JOB_NAMES.exchangeBalances },
    { name: JOB_NAMES.staleSyncProbe },
    { name: JOB_NAMES.paymentDueReminder },
  ],
};

// One chain, in order. The hard dependencies: the rollup values holdings with
// the backfilled prices and reads the `transfer_group_id` transfer-linking
// writes; the closed-holdings sweep, the split probe and the engine shadow read
// the rollup's settled state. db-backup is last so the dump is of that state.
// exchange-transactions only queues imports, so transfer-linking may still
// miss rows those imports write later, as it could before.
export const NIGHTLY_SCHEDULE: ScheduledJobGroupDescriptor = {
  name: JOB_NAMES.nightly,
  cron: '0 0 * * *',
  steps: [
    { name: JOB_NAMES.apyPayouts },
    { name: JOB_NAMES.exchangeTransactions },
    { name: JOB_NAMES.backfillTokenIdentity, runOn: sundaysOnly },
    { name: JOB_NAMES.rescoreScamTokens },
    // Measured at up to 1,070s (docs/technical/2026-10-06_sc1598-liveness-audit.md).
    { name: JOB_NAMES.historicalPriceBackfill, timeoutMs: 60 * 60 * 1000 },
    { name: JOB_NAMES.transferLinking },
    { name: JOB_NAMES.portfolioValueRollup },
    { name: JOB_NAMES.hideClosedHoldings },
    { name: JOB_NAMES.splitHoldingProbe },
    { name: JOB_NAMES.paymentHorizonRoll },
    { name: JOB_NAMES.backfillCounterparty },
    { name: JOB_NAMES.engineShadow },
    { name: JOB_NAMES.dbBackup },
  ],
};

// 09:00, an hour after the Monday digest (SC-459), which is why the digest is
// not a step here.
export const MORNING_SCHEDULE: ScheduledJobGroupDescriptor = {
  name: JOB_NAMES.morning,
  cron: '0 9 * * *',
  steps: [{ name: JOB_NAMES.alertSweep }, { name: JOB_NAMES.activationNudge }],
};
