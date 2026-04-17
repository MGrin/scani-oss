/**
 * Shared BullMQ queue + job name constants.
 *
 * Both apps/backend (producer) and apps/worker (consumer) import from here
 * so the wire contract for queue/job names is centrally defined.
 */

/** Single queue for all scani background work. */
export const SCANI_QUEUE = 'scani-jobs';

export const JOB_NAMES = {
  /** Scheduled by BullMQ repeatable jobs every 30 minutes. */
  pricing: 'pricing',
  /** Scheduled by BullMQ repeatable jobs every 15 minutes. */
  walletBalances: 'wallet-balances',
  /** Scheduled by BullMQ repeatable jobs every 15 minutes. */
  exchangeBalances: 'exchange-balances',
  /** Scheduled by BullMQ repeatable jobs daily at midnight UTC. */
  apyPayouts: 'apy-payouts',
  /** On-demand: triggered by the backend when a user adds a wallet. */
  walletImport: 'wallet-import',
  /** On-demand: triggered by the backend when a user connects an exchange. */
  exchangeSync: 'exchange-sync',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/**
 * Repeatable-job cron expressions, in UTC. Shape mirrors the old Render
 * cron services one-for-one.
 */
export const REPEATABLE_SCHEDULES: Array<{ name: JobName; pattern: string }> = [
  { name: JOB_NAMES.pricing, pattern: '*/30 * * * *' },
  { name: JOB_NAMES.walletBalances, pattern: '*/15 * * * *' },
  { name: JOB_NAMES.exchangeBalances, pattern: '*/15 * * * *' },
  { name: JOB_NAMES.apyPayouts, pattern: '0 0 * * *' },
];
