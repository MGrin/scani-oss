/**
 * The one thing a balance sync knows that the account row did not: whether
 * the source answered about NOW or about some earlier moment (SC-384).
 *
 * `accounts.metadata.lastSync` has always recorded when we asked. For every
 * live-balance venue that is also when the answer was true, so the two were
 * never distinguished and the screen said "synced 20 minutes ago" meaning
 * both. IBKR's Flex Web Service breaks the equivalence: it is a reporting
 * interface that generates a statement after the close and serves that same
 * statement all day, so a sync at 15:10Z returns positions as of the previous
 * business day and `lastSync` describes the request rather than the data.
 *
 * That is what made a correct sync read as a wrong number — mgrin bought four
 * ETFs, Scani showed the pre-trade quantities under a fresh timestamp, and
 * nothing on the screen could distinguish "we are a day behind, as designed"
 * from "this integration is broken". Every untraded position matched IBKR to
 * the decimal; the balances were right about a day the screen did not name.
 *
 * So `balancesAsOf` is a SECOND claim, written next to `lastSync` rather than
 * over it. Two questions, two answers: when did we last reach the source, and
 * what moment does the source's answer describe.
 */

/** What a provider's snapshots say about when their balances were true. */
export interface BalancesAsOf {
  /** ISO instant the source claims the balances describe. */
  at: string;
  /** The provider's one-sentence reason for the lag, verbatim. */
  note: string;
}

/**
 * How far behind the fetch a source's as-of has to sit before it is a fact
 * worth putting on screen.
 *
 * An hour, which is generous on purpose. Providers that answer live stamp
 * `capturedAt` at fetch time, and the gap between that and the moment the
 * transaction commits is seconds to minutes — well inside this — so they
 * write nothing and the fact stays rare enough to mean something when it
 * appears. IBKR's gap is measured in days, so no plausible threshold in this
 * region changes its answer; the number is chosen to keep the OTHER twenty
 * providers silent, not to classify this one.
 */
export const AS_OF_LAG_THRESHOLD_MS = 60 * 60 * 1000;

interface AsOfCandidate {
  capturedAt: Date;
  asOfNote?: string;
}

/**
 * The as-of to record for an account, or `null` when there is nothing to say.
 *
 * The NEWEST `capturedAt` wins rather than the oldest. A statement's rows
 * share one report date, so in practice they are all equal and the choice is
 * moot; where it is not — a provider that mixes a live leg with a reported
 * one — the newest is the only defensible answer, because the older rows are
 * still true at the newer instant and the reverse is not. Taking the oldest
 * would let one lagging row backdate an account whose figures are current.
 *
 * Returns `null` unless a snapshot both trails the fetch by more than the
 * threshold AND carries a note. Both halves are required: a date with no
 * reason is the bare "your data is old" that leaves a reader to guess whether
 * it is also broken, and a reason attached to a current figure is noise.
 */
export function deriveBalancesAsOf(
  snapshots: readonly AsOfCandidate[],
  fetchedAt: Date = new Date()
): BalancesAsOf | null {
  let newest: AsOfCandidate | null = null;
  for (const snapshot of snapshots) {
    const at = snapshot.capturedAt?.getTime();
    if (!Number.isFinite(at)) continue;
    if (!newest || at > newest.capturedAt.getTime()) newest = snapshot;
  }
  if (!newest?.asOfNote) return null;
  if (fetchedAt.getTime() - newest.capturedAt.getTime() <= AS_OF_LAG_THRESHOLD_MS) return null;
  return { at: newest.capturedAt.toISOString(), note: newest.asOfNote };
}

/**
 * Merge the derived as-of into an account's existing metadata.
 *
 * A `null` DELETES the key rather than leaving it. The stale reading is the
 * dangerous one: an account that has since moved to a live source, or an IBKR
 * statement that has caught up, would otherwise keep displaying a date that
 * stopped being true — and a warning that outlives its cause teaches readers
 * to ignore the next one.
 */
export function withBalancesAsOf(
  metadata: unknown,
  asOf: BalancesAsOf | null
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  if (asOf) base.balancesAsOf = asOf;
  else delete base.balancesAsOf;
  return base;
}
