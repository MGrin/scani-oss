/**
 * Shared BullMQ queue + job name constants.
 *
 * Both apps/backend (producer) and apps/worker (consumer) import from here
 * so the wire contract for queue/job names is centrally defined.
 */

/** Single queue for all scani background work. */
export const SCANI_QUEUE = 'scani-jobs';

/**
 * Dead-letter queue. Jobs that exhaust their retry attempts are pushed here
 * so they don't vanish with BullMQ's `removeOnFail` truncation. The admin
 * BullMQ dashboard surfaces them for inspection + manual replay.
 */
export const SCANI_DLQ = 'scani-dlq';

export const JOB_NAMES = {
  /** Scheduled by BullMQ repeatable jobs hourly. */
  pricing: 'pricing',
  /** Scheduled by BullMQ repeatable jobs hourly. */
  walletBalances: 'wallet-balances',
  /** Scheduled by BullMQ repeatable jobs hourly. */
  exchangeBalances: 'exchange-balances',
  /** Scheduled by BullMQ repeatable jobs daily at midnight UTC. */
  apyPayouts: 'apy-payouts',
  /** Scheduled every minute: reconcile credentials stuck in pending_enqueue. */
  reconcilePendingCredentials: 'reconcile-pending-credentials',
  /** Scheduled every minute: reconcile `user_jobs` rows stuck in `queued`. */
  reconcileOrphanedUserJobs: 'reconcile-orphaned-user-jobs',
  /** User-initiated: parse N screenshots via AI providers. */
  screenshotParse: 'screenshot-parse',
  /** User-initiated: import accounts and holdings from an exchange. */
  exchangeImport: 'exchange-import',
  /** User-initiated: import a wallet address (multi-chain detection + balance sync). */
  walletImport: 'wallet-import',
  /** User-initiated: parse a CSV/OFX/QIF file uploaded to R2. */
  fileImport: 'file-import',
  /** User-initiated: update a single holding price and recalculate dependent vaults. */
  holdingPriceUpdate: 'holding-price-update',
  /** User-initiated: delete all user data in a large DB transaction. */
  userDataDelete: 'user-data-delete',
  /**
   * Triggered after an integration connects (chain-enqueued by
   * exchange-import / wallet-import / IBKR import processors) to pull
   * historical transactions for a single account. Dispatches by `source`
   * tag to the right TransactionIngester (etherscan, binance-api,
   * kraken-api, …). Scheduled sparingly — one per account on creation,
   * not on every balance sync.
   */
  transactionImport: 'transaction-import',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/**
 * Repeatable-job cron expressions, in UTC.
 *
 * Cadence is deliberately conservative (hourly for most, daily for payouts)
 * to keep Upstash Redis free-tier usage low. Bump these up when there are
 * enough active integrations that stale balances start to bother users.
 */
export const REPEATABLE_SCHEDULES: Array<{ name: JobName; pattern: string }> = [
  { name: JOB_NAMES.pricing, pattern: '0 * * * *' },
  { name: JOB_NAMES.walletBalances, pattern: '0 * * * *' },
  { name: JOB_NAMES.exchangeBalances, pattern: '0 * * * *' },
  { name: JOB_NAMES.apyPayouts, pattern: '0 0 * * *' },
  // Reconcile credentials stuck in 'pending_enqueue' every 15 minutes —
  // the backend marks rows pending_enqueue, calls BullMQ.add(), and
  // promotes to 'enqueued'. If the backend dies in between, this sweeper
  // re-enqueues. Quarter-hour cadence (not every minute) so Neon's
  // scale-to-zero gets idle windows between batched DB wakes.
  { name: JOB_NAMES.reconcilePendingCredentials, pattern: '*/15 * * * *' },
  // Same pattern for `user_jobs`: backend inserts the mirror row before
  // `queue.add`; if it crashes between them, the row sits in `queued`
  // forever. This sweeper marks abandoned rows `failed`.
  { name: JOB_NAMES.reconcileOrphanedUserJobs, pattern: '*/15 * * * *' },
];
