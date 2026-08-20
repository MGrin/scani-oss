export { ALERT_SWEEP_SCHEDULE } from './alert-sweep';
export { APY_PAYOUTS_SCHEDULE } from './apy-payouts';
export { BACKFILL_COUNTERPARTY_SCHEDULE } from './backfill-counterparty';
export { BACKFILL_TOKEN_IDENTITY_SCHEDULE } from './backfill-token-identity';
export { DLQ_DEPTH_PROBE_SCHEDULE } from './dlq-depth-probe';
export { EXCHANGE_BALANCES_SCHEDULE } from './exchange-balances';
export { EXCHANGE_TRANSACTIONS_SCHEDULE } from './exchange-transactions';
export { FOREX_BACKFILL_SCHEDULE } from './forex-backfill';
export { HIDE_CLOSED_HOLDINGS_SCHEDULE } from './hide-closed-holdings';
export { HISTORICAL_PRICE_BACKFILL_SCHEDULE } from './historical-price-backfill';
export {
  HEARTBEAT_TOLERANCE_MS,
  JOB_HEARTBEAT_PROBE_SCHEDULE,
} from './job-heartbeat-probe';
export { PAYMENT_DUE_REMINDER_SCHEDULE } from './payment-due-reminder';
export { PORTFOLIO_VALUE_ROLLUP_SCHEDULE } from './portfolio-value-rollup';
export { PRICING_SCHEDULE } from './pricing';
export { RECONCILE_ORPHANED_USER_JOBS_SCHEDULE } from './reconcile-orphaned-user-jobs';
export { RECONCILE_PENDING_CREDENTIALS_SCHEDULE } from './reconcile-pending-credentials';
export { RESCORE_SCAM_TOKENS_SCHEDULE } from './rescore-scam-tokens';
export { SPLIT_HOLDING_PROBE_SCHEDULE } from './split-holding-probe';
export { STALE_SYNC_PROBE_SCHEDULE } from './stale-sync-probe';
export {
  TOKEN_PRICES_DOWNSAMPLE_SCHEDULE,
  TOKEN_PRICES_INTRADAY_RETENTION_DAYS,
} from './token-prices-downsample';
export { TRANSFER_LINKING_SCHEDULE } from './transfer-linking';
export { WALLET_BALANCES_SCHEDULE } from './wallet-balances';
export { WEEKLY_DIGEST_SCHEDULE } from './weekly-digest';

import { ALERT_SWEEP_SCHEDULE } from './alert-sweep';
import { APY_PAYOUTS_SCHEDULE } from './apy-payouts';
import { BACKFILL_COUNTERPARTY_SCHEDULE } from './backfill-counterparty';
import { BACKFILL_TOKEN_IDENTITY_SCHEDULE } from './backfill-token-identity';
import { DLQ_DEPTH_PROBE_SCHEDULE } from './dlq-depth-probe';
import { EXCHANGE_BALANCES_SCHEDULE } from './exchange-balances';
import { EXCHANGE_TRANSACTIONS_SCHEDULE } from './exchange-transactions';
import { FOREX_BACKFILL_SCHEDULE } from './forex-backfill';
import { HIDE_CLOSED_HOLDINGS_SCHEDULE } from './hide-closed-holdings';
import { HISTORICAL_PRICE_BACKFILL_SCHEDULE } from './historical-price-backfill';
import { JOB_HEARTBEAT_PROBE_SCHEDULE } from './job-heartbeat-probe';
import { PAYMENT_DUE_REMINDER_SCHEDULE } from './payment-due-reminder';
import { PORTFOLIO_VALUE_ROLLUP_SCHEDULE } from './portfolio-value-rollup';
import { PRICING_SCHEDULE } from './pricing';
import { RECONCILE_ORPHANED_USER_JOBS_SCHEDULE } from './reconcile-orphaned-user-jobs';
import { RECONCILE_PENDING_CREDENTIALS_SCHEDULE } from './reconcile-pending-credentials';
import { RESCORE_SCAM_TOKENS_SCHEDULE } from './rescore-scam-tokens';
import { SPLIT_HOLDING_PROBE_SCHEDULE } from './split-holding-probe';
import { STALE_SYNC_PROBE_SCHEDULE } from './stale-sync-probe';
import { TOKEN_PRICES_DOWNSAMPLE_SCHEDULE } from './token-prices-downsample';
import { TRANSFER_LINKING_SCHEDULE } from './transfer-linking';
import { WALLET_BALANCES_SCHEDULE } from './wallet-balances';
import { WEEKLY_DIGEST_SCHEDULE } from './weekly-digest';

export const SCHEDULED_JOB_DESCRIPTORS = [
  PRICING_SCHEDULE,
  WALLET_BALANCES_SCHEDULE,
  EXCHANGE_BALANCES_SCHEDULE,
  EXCHANGE_TRANSACTIONS_SCHEDULE,
  APY_PAYOUTS_SCHEDULE,
  // Registered in the SAME commit as `PaymentDueReminderProcessor` (SC-283).
  // A schedule with no processor does not fail the build, a test, or boot —
  // it fails once per tick, in production, into the DLQ.
  PAYMENT_DUE_REMINDER_SCHEDULE,
  // Registered in the SAME commit as `WeeklyDigestProcessor`, for the reason
  // stated one line above (SC-460).
  WEEKLY_DIGEST_SCHEDULE,
  // And in the SAME commit as `AlertSweepProcessor` (SC-459).
  ALERT_SWEEP_SCHEDULE,
  RECONCILE_PENDING_CREDENTIALS_SCHEDULE,
  RECONCILE_ORPHANED_USER_JOBS_SCHEDULE,
  HISTORICAL_PRICE_BACKFILL_SCHEDULE,
  FOREX_BACKFILL_SCHEDULE,
  TOKEN_PRICES_DOWNSAMPLE_SCHEDULE,
  PORTFOLIO_VALUE_ROLLUP_SCHEDULE,
  TRANSFER_LINKING_SCHEDULE,
  BACKFILL_TOKEN_IDENTITY_SCHEDULE,
  BACKFILL_COUNTERPARTY_SCHEDULE,
  HIDE_CLOSED_HOLDINGS_SCHEDULE,
  DLQ_DEPTH_PROBE_SCHEDULE,
  RESCORE_SCAM_TOKENS_SCHEDULE,
  JOB_HEARTBEAT_PROBE_SCHEDULE,
  STALE_SYNC_PROBE_SCHEDULE,
  SPLIT_HOLDING_PROBE_SCHEDULE,
] as const;
