import type { HoldingKind } from '../../engine/types';

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
 * The `holdings.source` that means "a person created this row".
 *
 * Since A5 D-4 a row's KIND says who writes it, and this string decides only
 * for a row whose kind was never set (`holdingKindOf`).
 */
export const MANUAL_HOLDING_SOURCE = 'manual';

/**
 * A holding's kind as the balance syncs and an arriving transfer read it (A5
 * D-4, #2): a feed is the sync's to write and waits for its feed; a snapshot is
 * a person's and moves when money arrives. A row whose kind was never set is
 * judged by its source, a person's row a snapshot and any other a feed.
 * Production holds no such row since A2's backfill, and the column stays
 * nullable, so the rule stays total. `HoldingRepository`'s `isFeedHolding` is
 * this rule in SQL; the two must agree, or the sync and the arrival disagree
 * about who owns a row.
 */
export function holdingKindOf(holding: { kind: HoldingKind | null; source: string }): HoldingKind {
  return holding.kind ?? (holding.source === MANUAL_HOLDING_SOURCE ? 'snapshot' : 'feed');
}

export const WALLET_BALANCE_SYNC_SOURCE = 'blockchain';
export const EXCHANGE_BALANCE_SYNC_SOURCE = 'sync_exchange_balances';

/**
 * The prefix of the `holdings.source` a credentialed import writes:
 * `import_<institution>` from `ImportExchangeAccountsUseCase`, `import_ibkr`
 * from `ImportIbkrAccountsUseCase`.
 */
export const IMPORTED_HOLDING_SOURCE_PREFIX = 'import_';

export type BalanceSyncSource =
  | typeof WALLET_BALANCE_SYNC_SOURCE
  | typeof EXCHANGE_BALANCE_SYNC_SOURCE;
