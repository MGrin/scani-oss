import type { ScheduledJobStepDescriptor } from '@scani/queue';

export { ACTIVATION_NUDGE_SCHEDULE } from './activation-nudge';
export { ACTIVE_PRICING_SCHEDULE } from './active-pricing';
export { ALERT_SWEEP_SCHEDULE } from './alert-sweep';
export { APY_PAYOUTS_SCHEDULE } from './apy-payouts';
export { BACKFILL_COUNTERPARTY_SCHEDULE } from './backfill-counterparty';
export { BACKFILL_TOKEN_IDENTITY_SCHEDULE } from './backfill-token-identity';
export { DB_BACKUP_SCHEDULE } from './db-backup';
export { DEMO_RESET_SCHEDULE } from './demo-reset';
export {
  DEAD_LETTER_ALARM,
  DEAD_LETTER_MAX_AGE_MS,
  DEAD_LETTER_RENOTIFY_MS,
  DLQ_DEPTH_PROBE_SCHEDULE,
  FAILED_JOB_MAX_AGE_MS,
} from './dlq-depth-probe';
export { ENGINE_SHADOW_SCHEDULE } from './engine-shadow';
export { EXCHANGE_BALANCES_SCHEDULE } from './exchange-balances';
export { EXCHANGE_TRANSACTIONS_SCHEDULE } from './exchange-transactions';
export {
  HOURLY_SCHEDULE,
  HOUSEKEEPING_SCHEDULE,
  MORNING_SCHEDULE,
  NIGHTLY_SCHEDULE,
} from './groups';
export { HIDE_CLOSED_HOLDINGS_SCHEDULE } from './hide-closed-holdings';
export { HISTORICAL_PRICE_BACKFILL_SCHEDULE } from './historical-price-backfill';
export {
  HEARTBEAT_DAILY_DEADLINE_UTC_HOUR,
  HEARTBEAT_TOLERANCE_MS,
  JOB_HEARTBEAT_PROBE_SCHEDULE,
  missedDailyDeadline,
} from './job-heartbeat-probe';
export { PAYMENT_DUE_REMINDER_SCHEDULE } from './payment-due-reminder';
export { PAYMENT_HORIZON_ROLL_SCHEDULE } from './payment-horizon-roll';
export { PORTFOLIO_VALUE_ROLLUP_SCHEDULE } from './portfolio-value-rollup';
export { PRICING_SCHEDULE } from './pricing';
export { RECONCILE_ORPHANED_USER_JOBS_SCHEDULE } from './reconcile-orphaned-user-jobs';
export { RECONCILE_PENDING_CREDENTIALS_SCHEDULE } from './reconcile-pending-credentials';
export { RESCORE_SCAM_TOKENS_SCHEDULE } from './rescore-scam-tokens';
export { SPLIT_HOLDING_PROBE_SCHEDULE } from './split-holding-probe';
export {
  STALE_SYNC_ALARM,
  STALE_SYNC_PROBE_SCHEDULE,
  STALE_SYNC_RENOTIFY_MS,
} from './stale-sync-probe';
export { TRANSFER_LINKING_SCHEDULE } from './transfer-linking';
export { WALLET_BALANCES_SCHEDULE } from './wallet-balances';
export { WEEKLY_DIGEST_SCHEDULE } from './weekly-digest';

import { ACTIVATION_NUDGE_SCHEDULE } from './activation-nudge';
import { ACTIVE_PRICING_SCHEDULE } from './active-pricing';
import { ALERT_SWEEP_SCHEDULE } from './alert-sweep';
import { APY_PAYOUTS_SCHEDULE } from './apy-payouts';
import { BACKFILL_COUNTERPARTY_SCHEDULE } from './backfill-counterparty';
import { BACKFILL_TOKEN_IDENTITY_SCHEDULE } from './backfill-token-identity';
import { DB_BACKUP_SCHEDULE } from './db-backup';
import { DLQ_DEPTH_PROBE_SCHEDULE } from './dlq-depth-probe';
import { ENGINE_SHADOW_SCHEDULE } from './engine-shadow';
import { EXCHANGE_BALANCES_SCHEDULE } from './exchange-balances';
import { EXCHANGE_TRANSACTIONS_SCHEDULE } from './exchange-transactions';
import {
  HOURLY_SCHEDULE,
  HOUSEKEEPING_SCHEDULE,
  MORNING_SCHEDULE,
  NIGHTLY_SCHEDULE,
} from './groups';
import { HIDE_CLOSED_HOLDINGS_SCHEDULE } from './hide-closed-holdings';
import { HISTORICAL_PRICE_BACKFILL_SCHEDULE } from './historical-price-backfill';
import { JOB_HEARTBEAT_PROBE_SCHEDULE } from './job-heartbeat-probe';
import { PAYMENT_DUE_REMINDER_SCHEDULE } from './payment-due-reminder';
import { PAYMENT_HORIZON_ROLL_SCHEDULE } from './payment-horizon-roll';
import { PORTFOLIO_VALUE_ROLLUP_SCHEDULE } from './portfolio-value-rollup';
import { PRICING_SCHEDULE } from './pricing';
import { RECONCILE_ORPHANED_USER_JOBS_SCHEDULE } from './reconcile-orphaned-user-jobs';
import { RECONCILE_PENDING_CREDENTIALS_SCHEDULE } from './reconcile-pending-credentials';
import { RESCORE_SCAM_TOKENS_SCHEDULE } from './rescore-scam-tokens';
import { SPLIT_HOLDING_PROBE_SCHEDULE } from './split-holding-probe';
import { STALE_SYNC_PROBE_SCHEDULE } from './stale-sync-probe';
import { TRANSFER_LINKING_SCHEDULE } from './transfer-linking';
import { WALLET_BALANCES_SCHEDULE } from './wallet-balances';
import { WEEKLY_DIGEST_SCHEDULE } from './weekly-digest';

// The schedules the worker arms (SC-1688): four groups and the two jobs that
// keep a schedule of their own. A step is registered in the SAME commit as its
// processor: a step with no processor refuses at boot
// (`ScheduledJobGroupProcessor`), and a schedule with no processor fails once
// per tick, in production, into the DLQ (SC-283).
export const SCHEDULED_JOB_DESCRIPTORS = [
  HOUSEKEEPING_SCHEDULE,
  ACTIVE_PRICING_SCHEDULE,
  HOURLY_SCHEDULE,
  NIGHTLY_SCHEDULE,
  MORNING_SCHEDULE,
  // Alone, so it never mails in the same hour as alert-sweep (SC-459).
  WEEKLY_DIGEST_SCHEDULE,
] as const;

// Every job that runs as a step of a group, by name: its lock, jitter and
// heartbeat name.
export const SCHEDULED_JOB_STEPS: Readonly<Record<string, ScheduledJobStepDescriptor>> =
  Object.fromEntries(
    [
      ACTIVATION_NUDGE_SCHEDULE,
      ALERT_SWEEP_SCHEDULE,
      APY_PAYOUTS_SCHEDULE,
      BACKFILL_COUNTERPARTY_SCHEDULE,
      BACKFILL_TOKEN_IDENTITY_SCHEDULE,
      DB_BACKUP_SCHEDULE,
      DLQ_DEPTH_PROBE_SCHEDULE,
      ENGINE_SHADOW_SCHEDULE,
      EXCHANGE_BALANCES_SCHEDULE,
      EXCHANGE_TRANSACTIONS_SCHEDULE,
      HIDE_CLOSED_HOLDINGS_SCHEDULE,
      HISTORICAL_PRICE_BACKFILL_SCHEDULE,
      JOB_HEARTBEAT_PROBE_SCHEDULE,
      PAYMENT_DUE_REMINDER_SCHEDULE,
      PAYMENT_HORIZON_ROLL_SCHEDULE,
      PORTFOLIO_VALUE_ROLLUP_SCHEDULE,
      PRICING_SCHEDULE,
      RECONCILE_ORPHANED_USER_JOBS_SCHEDULE,
      RECONCILE_PENDING_CREDENTIALS_SCHEDULE,
      RESCORE_SCAM_TOKENS_SCHEDULE,
      SPLIT_HOLDING_PROBE_SCHEDULE,
      STALE_SYNC_PROBE_SCHEDULE,
      TRANSFER_LINKING_SCHEDULE,
      WALLET_BALANCES_SCHEDULE,
    ].map((d) => [d.name, d])
  );
