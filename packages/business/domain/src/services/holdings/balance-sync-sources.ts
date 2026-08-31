/**
 * The `holdings.source` each balance sync stamps on the rows it owns.
 *
 * `HoldingsSyncHelper` reconciles against every existing holding EXCEPT the
 * ones at `source = 'manual'`, so this string is what decides whether a row
 * is maintained by a sync or left alone forever. A writer outside the sync
 * that wants its row adopted has to use the exact same string — a copy that
 * drifts produces a holding no sync can ever see, which is half of SC-356.
 */
/**
 * The `holdings.source` that means "a person maintains this number".
 *
 * Declared here rather than spelled at each site because it is load-bearing at
 * BOTH ends and in opposite directions (SC-856): `HoldingsSyncHelper` skips a
 * row carrying it, and `TransferReviewService`'s `arrivalMovesTheAnchor` moves
 * a row carrying it precisely BECAUSE the sync will not. The two must agree on
 * the string or an arrival is either counted twice or not at all, and neither
 * failure shows up as a test going red.
 */
export const MANUAL_HOLDING_SOURCE = 'manual';

export const WALLET_BALANCE_SYNC_SOURCE = 'blockchain';
export const EXCHANGE_BALANCE_SYNC_SOURCE = 'sync_exchange_balances';

export type BalanceSyncSource =
  | typeof WALLET_BALANCE_SYNC_SOURCE
  | typeof EXCHANGE_BALANCE_SYNC_SOURCE;
