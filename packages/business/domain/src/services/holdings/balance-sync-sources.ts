/**
 * The `holdings.source` each balance sync stamps on the rows it owns.
 *
 * `HoldingsSyncHelper` reconciles against every existing holding EXCEPT the
 * ones at `source = 'manual'`, so this string is what decides whether a row
 * is maintained by a sync or left alone forever. A writer outside the sync
 * that wants its row adopted has to use the exact same string — a copy that
 * drifts produces a holding no sync can ever see, which is half of SC-356.
 */
export const WALLET_BALANCE_SYNC_SOURCE = 'blockchain';
export const EXCHANGE_BALANCE_SYNC_SOURCE = 'sync_exchange_balances';

export type BalanceSyncSource =
  | typeof WALLET_BALANCE_SYNC_SOURCE
  | typeof EXCHANGE_BALANCE_SYNC_SOURCE;
