// Single source of truth for the per-job string names used in BullMQ
// dispatch keys. Both producer and consumer import from here so a typo
// is caught at the type level.
//
// These names are part of the wire contract with deployed BullMQ state —
// renaming requires a coordinated rolling deploy.
export const JOB_NAMES = {
  pricing: 'pricing',
  walletBalances: 'wallet-balances',
  exchangeBalances: 'exchange-balances',
  apyPayouts: 'apy-payouts',
  reconcilePendingCredentials: 'reconcile-pending-credentials',
  reconcileOrphanedUserJobs: 'reconcile-orphaned-user-jobs',
  historicalPriceBackfill: 'historical-price-backfill',
  forexBackfill: 'forex-backfill',
  portfolioValueRollup: 'portfolio-value-rollup',
  transferLinking: 'transfer-linking',
  backfillTokenIdentity: 'backfill-token-identity',
  screenshotParse: 'screenshot-parse',
  exchangeImport: 'exchange-import',
  walletImport: 'wallet-import',
  fileImport: 'file-import',
  manualHoldingsCreate: 'manual-holdings-create',
  portfolioHistoryBackfill: 'portfolio-history-backfill',
  holdingPriceUpdate: 'holding-price-update',
  userDataDelete: 'user-data-delete',
  transactionImport: 'transaction-import',
  hideClosedHoldings: 'hide-closed-holdings',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];
