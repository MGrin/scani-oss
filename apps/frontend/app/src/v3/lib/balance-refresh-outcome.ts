import type { TFunction } from 'i18next';

/**
 * What "Refresh balance" is allowed to claim once its job lands (SC-852).
 *
 * The venue is asked about the whole account, not about one position, and it
 * can come back without the symbol the user actually pressed. Saying
 * "refreshed" then would be a claim the numbers on the screen disprove — so
 * the hook reported every absence as an error advising "try again in a
 * minute", and that advice is IMPOSSIBLE for half of them.
 *
 * Two causes produce one absence, and the job now separates them because only
 * one of them can be resolved by asking again:
 *
 * - **the position is gone.** Etherscan's discovery reads one `tokentx` page
 *   and drops every zero balance, so a token that left the wallet falls out of
 *   the response and never returns. The refresh asks about it directly, the
 *   chain answers zero, and the holding is anchored there. Nothing is wrong
 *   and there is nothing to retry — a reader who follows that advice follows
 *   it forever, while the dashboard keeps counting a position the chain
 *   reports as `0x0`;
 * - **nobody knows.** A rate limit, an unreadable answer, or a token that IS
 *   still held and fell outside the 10k-row discovery window. The old figure
 *   stays on screen, and here "try again in a minute" is true.
 *
 * The split lives in a pure module for the same reason `describePriceRefresh`
 * does: the branch is the whole behaviour, and a test that renders the hook
 * to reach it would need a tRPC client to assert a sentence.
 */

export interface BalanceRefreshReport {
  /** Symbols the provider returned a snapshot for. */
  syncedSymbols?: string[];
  /** Absent, and still unexplained after the probe. */
  missingSymbols?: string[];
  /** Absent because the position left the account, measured at zero. */
  exitedSymbols?: string[];
}

export interface BalanceRefreshOutcome {
  /** `unresolved` is the only one that is an error — the rest are outcomes. */
  kind: 'exited' | 'unresolved' | 'one' | 'many';
  message: string;
  /** Toast title, on the branch that has one. */
  title?: string;
}

/**
 * @param symbol upper-cased ticker of the holding the user pressed.
 *
 * ORDER IS THE BEHAVIOUR. `exited` is tested before `unresolved`, because a
 * symbol that left the wallet is absent from `syncedSymbols` and would
 * otherwise fall straight into the retry-forever branch this exists to remove.
 * A report from an older job carries neither list, so it reads as `many` —
 * the pre-existing behaviour, and the only safe default: it claims a count and
 * nothing about any particular symbol.
 */
export function describeBalanceRefresh(
  t: TFunction,
  report: BalanceRefreshReport | null | undefined,
  symbol: string
): BalanceRefreshOutcome {
  const upper = (list: string[] | undefined) => (list ?? []).map((s) => s.toUpperCase());
  const synced = upper(report?.syncedSymbols);
  const missing = upper(report?.missingSymbols);
  const exited = upper(report?.exitedSymbols);

  if (symbol && exited.includes(symbol)) {
    return { kind: 'exited', message: t('v3.holdings.refresh.exited', { symbol }) };
  }
  if (symbol && missing.includes(symbol) && !synced.includes(symbol)) {
    return {
      kind: 'unresolved',
      message: t('v3.holdings.refresh.partial', { symbol, count: synced.length }),
      title: t('v3.holdings.refresh.partialTitle'),
    };
  }
  if (symbol && synced.includes(symbol)) {
    return { kind: 'one', message: t('v3.holdings.refresh.oneBalance', { symbol }) };
  }
  return {
    kind: 'many',
    message: t('v3.holdings.refresh.manyBalances', { count: synced.length }),
  };
}
