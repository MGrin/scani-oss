/**
 * A walk that failed and was swallowed is evidence about the LEDGER, exactly
 * like a page cap (SC-426), so it belongs on the same retraction channel
 * (SC-1481).
 *
 * The exchange providers tolerate a failed sub-walk on purpose — one refused
 * symbol must not fail a multi-thousand-event import — and until SC-1481 they
 * did it with `.catch(() => [])` and nothing else. The router then claimed a
 * complete history over a run whose transfers walk had returned a 500, and
 * SC-149 rendered that as a `complete` cost basis. Tolerating the failure is
 * still right; staying silent about it was the defect.
 *
 * The sentence is a plain string rather than a keyed notice: it names walks in
 * the provider's own words, and a key would need a bundle entry this package
 * cannot ship.
 */

import type { CustomLogger } from '@scani/logging';
import type { TransactionFetchContext } from '../types';

/** How many failed walks the retraction names before it summarizes the rest. */
const WALKS_NAMED = 3;

/** One instance per `fetchTransactions` call. */
export class WalkFailureWatch {
  private readonly walks: string[] = [];

  constructor(
    private readonly providerKey: string,
    private readonly logger: CustomLogger
  ) {}

  /** Record a walk that did not complete. `walk` is a noun phrase: "the transfers walk". */
  note(walk: string, err?: unknown): void {
    this.walks.push(walk);
    this.logger.warn(
      {
        providerKey: this.providerKey,
        walk,
        err: err instanceof Error ? err.message : err,
      },
      'Transaction walk failed; this run will not claim a complete history'
    );
  }

  /**
   * Run a walk, recording a failure and handing back `fallback` instead of
   * throwing. An error `isFatal` accepts is rethrown instead: a refusal that
   * says the REQUEST is wrong (bad key, rate limit) fails every walk alike, and
   * tolerating it would turn a broken sync into a quietly shorter ledger.
   */
  async attempt<T>(
    walk: string,
    run: () => Promise<T>,
    fallback: T,
    isFatal?: (err: unknown) => boolean
  ): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (isFatal?.(err)) throw err;
      this.note(walk, err);
      return fallback;
    }
  }

  /** Retract once, naming what failed. */
  retract(ctx: Pick<TransactionFetchContext, 'retractHistoryClaim'>): void {
    if (this.walks.length === 0) return;
    const named = this.walks.slice(0, WALKS_NAMED);
    const rest = this.walks.length - named.length;
    if (rest > 0) named.push(`${rest} further walk${rest === 1 ? '' : 's'}`);
    const list = new Intl.ListFormat('en', { type: 'conjunction' }).format(named);
    ctx.retractHistoryClaim?.(
      `${this.providerKey}: ${list} failed — the history ${this.walks.length === 1 ? 'it' : 'they'} would have returned was never fetched`
    );
  }
}
