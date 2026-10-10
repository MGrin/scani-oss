import { LEDGER_SOURCES } from './transaction-source';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Ledger sources read in the same run as their balance (SC-1665): each one's
 * read is server-side incremental and costs a few calls. A source not here
 * stays on the nightly `exchange-transactions` run until its read stops
 * walking whole histories (spec: "Which providers merge").
 */
export const BALANCE_RUN_LEDGER_SOURCES: ReadonlySet<string> = new Set([
  'airwallex-api',
  'kraken-api',
  'bybit-api',
  'okx-api',
  'kucoin-api',
  'bitget-api',
  'ibkr-api',
  'bitcoin',
  'solana',
  'etherscan',
]);

/**
 * Ledger sources still read nightly, apart from their balance: a balance gap
 * on one of them waits for that read (`awaiting-ledger`, SC-1665).
 */
export const NIGHTLY_LEDGER_SOURCES: readonly string[] = [...LEDGER_SOURCES].filter(
  (source) => !BALANCE_RUN_LEDGER_SOURCES.has(source)
);

/** The longest a gap waits for a nightly read: one night's cycle and two hours. */
export const AWAITING_LEDGER_MAX_MS = 26 * HOUR_MS;

/** IBKR stamps a date-only cash row at the end of its day, after the read-through point. */
const OVERLAP_MS: Readonly<Record<string, number>> = { 'ibkr-api': 48 * HOUR_MS };

/** How far before the read-through point a ledger read starts again. */
export function ledgerOverlapMs(source: string): number {
  return OVERLAP_MS[source] ?? HOUR_MS;
}
