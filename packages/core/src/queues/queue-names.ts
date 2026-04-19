/**
 * Shared BullMQ queue + job name constants.
 *
 * Both apps/backend (producer) and apps/worker (consumer) import from here
 * so the wire contract for queue/job names is centrally defined.
 */

/** Single queue for all scani background work. */
export const SCANI_QUEUE = 'scani-jobs';

export const JOB_NAMES = {
  /** Scheduled by BullMQ repeatable jobs hourly. */
  pricing: 'pricing',
  /** Scheduled by BullMQ repeatable jobs hourly. */
  walletBalances: 'wallet-balances',
  /** Scheduled by BullMQ repeatable jobs hourly. */
  exchangeBalances: 'exchange-balances',
  /** Scheduled by BullMQ repeatable jobs daily at midnight UTC. */
  apyPayouts: 'apy-payouts',
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
];
