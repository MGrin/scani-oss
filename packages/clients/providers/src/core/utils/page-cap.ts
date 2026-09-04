/**
 * A page cap that stops a walk is evidence about the LEDGER, not about the
 * request, so it belongs on the retraction channel (SC-395, SC-426).
 *
 * The two must not be confused. A HORIZON is known before the call — "a
 * `since`-less run through this provider reaches five years back and no
 * further" — and it caps what the run may CLAIM (SC-418). A page cap is
 * something the walk discovers about itself: the rows past it exist, the
 * account really is longer than what we hold, and a provider that hits one has
 * no way to say so except by retracting. Silence there writes
 * `holding_coverage.has_complete_tx_history = true` over a ledger that stopped
 * early, and SC-149 renders that as a `complete` cost basis.
 *
 * `BaseCexProvider` subclasses report this by returning
 * `{ hasCompleteTxHistory: false }` from their paginator, which the base
 * forwards. The providers that hand-roll their own loops have no terminal
 * value to return, so they collect their capped walks here and retract once,
 * at the end of `fetchTransactions`.
 */

import type { TransactionFetchContext } from '../types';

/** How many capped walks the retraction names before it summarizes the rest. */
const WALKS_NAMED = 3;

/** One walk that stopped because it ran out of allowance, not out of rows. */
export interface PageCapHit {
  /** What was being walked, phrased for the reader who meets it in a warning. */
  walk: string;
  /** The cap it stopped at. */
  pages: number;
  /** Rows it did return before stopping. */
  rows: number;
}

/**
 * Collects the capped walks of one `fetchTransactions` call and retracts the
 * run's completeness claim if there were any.
 *
 * One instance per call — nothing here is shared between runs, which is what
 * lets a private paginator record a fact the public method reports.
 */
export class PageCapWatch {
  private readonly hits: PageCapHit[] = [];

  note(hit: PageCapHit): void {
    this.hits.push(hit);
  }

  get capped(): boolean {
    return this.hits.length > 0;
  }

  /**
   * Retract once, naming what stopped. One warning per run rather than one per
   * walk: a Coinbase account list can cap fifty times over and the reader
   * learns nothing from the fiftieth.
   *
   * Says what the walk observed rather than that it failed — "stopped at its
   * 200-page cap after 20,000 rows" survives being read a month later, and
   * "incomplete history" does not.
   */
  retract(ctx: TransactionFetchContext, providerKey: string): void {
    const sentence = this.describe(providerKey);
    if (!sentence) return;
    ctx.retractHistoryClaim?.(`${sentence} — the rest of this account's history was never fetched`);
  }

  /**
   * Say it without taking the claim away, for a walk that annotates rather
   * than produces (SC-428).
   *
   * `consequence` is the caller's, because only the caller knows what its walk
   * was for. A cap on a lookup that hangs an on-chain hash onto events some
   * other walk already returned costs an annotation and no rows, so retracting
   * on it would downgrade a cost basis over a missing hash — and staying
   * silent, which is what bitstamp did until now, leaves the reader with a
   * sparser screen and nothing that says why.
   */
  warn(ctx: TransactionFetchContext, providerKey: string, consequence: string): void {
    const sentence = this.describe(providerKey);
    if (!sentence) return;
    ctx.noteWarning?.(`${sentence} — ${consequence}`);
  }

  /**
   * What the walks observed, or null when none of them capped.
   *
   * **This sentence stays a plain string, and that is a decision (SC-434).**
   * Every other producer keyed under `v3.jobs.notices.*` interpolates only
   * identifiers, numbers and dates — a provider key, an API's own stream name,
   * an ISO date — so the frame can be translated and the params left alone.
   * This one interpolates `hit.walk`, which is an English NOUN PHRASE written
   * by the caller: `the crypto-transactions lookup`, `the account list`,
   * `transactions for account <id>`. A key here would put a Russian frame
   * around English prose, which reads worse than the all-English sentence it
   * replaces, and `JobNotice.params` is flat primitives by design — a
   * variable-length list of clauses has to be pre-joined into one string, so
   * the mechanism cannot reach inside it.
   *
   * Keying it properly means giving `PageCapHit` a key of its own, which is
   * eight call sites across five providers plus a translation each, two of
   * them interpolated (`${symbol} trades`). That is a design change rather
   * than a migration, so it is not done here. `key: null` is the honest
   * answer meanwhile, and the sentence renders exactly as it does today.
   */
  private describe(providerKey: string): string | null {
    if (this.hits.length === 0) return null;
    const named = this.hits
      .slice(0, WALKS_NAMED)
      .map((hit) => `${hit.walk} stopped at its ${hit.pages}-page cap after ${hit.rows} rows`);
    const rest = this.hits.length - named.length;
    if (rest > 0) named.push(`${rest} further walk${rest === 1 ? '' : 's'} did the same`);
    return `${providerKey}: ${named.join('; ')}`;
  }
}
