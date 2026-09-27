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

import type { JobNotice, JobNoticeList, TransactionFetchContext } from '../types';
import { englishList } from './english-list';

/** How many capped walks the retraction names before it summarizes the rest. */
const WALKS_NAMED = 3;

/**
 * What was being walked, as a KIND rather than a phrase (SC-1028).
 *
 * Until SC-1028 this was an English noun phrase written by each caller —
 * `the crypto-transactions lookup`, `${symbol} trades` — and the sentence
 * built from it could not be translated, because the phrase arrived already
 * written. A kind carries only identifiers, so the clause is keyed per kind
 * and the identifiers ride as params.
 */
export type PageCapWalk =
  | { kind: 'addressHistory' }
  | { kind: 'userTransactionsLedger' }
  | { kind: 'cryptoTransactionsLookup' }
  | { kind: 'accountList' }
  | { kind: 'accountTransactions'; account: string }
  | { kind: 'symbolTrades'; symbol: string }
  | { kind: 'transfers' }
  | { kind: 'currencyDeposits'; currency: string }
  | { kind: 'currencyWithdrawals'; currency: string }
  | { kind: 'feed'; path: string }
  | { kind: 'trxTransfers' }
  | { kind: 'trc20Transfers' };

/** One walk that stopped because it ran out of allowance, not out of rows. */
export interface PageCapHit {
  walk: PageCapWalk;
  /** The cap it stopped at. */
  pages: number;
  /** Rows it did return before stopping. */
  rows: number;
}

/**
 * One clause per kind. The keys are written out literally, because
 * `i18n-keys.test.ts` finds a producer's keys by scanning for the quoted
 * string, and a key assembled from a template is one it cannot see.
 */
function walkClause(hit: PageCapHit): JobNotice {
  const cap = `stopped at its ${hit.pages}-page cap after ${hit.rows} rows`;
  const counts = { pages: hit.pages, rows: hit.rows };
  const w = hit.walk;
  switch (w.kind) {
    case 'addressHistory':
      return {
        key: 'v3.jobs.notices.pageCapAddressHistory',
        params: counts,
        text: `the address history ${cap}`,
      };
    case 'userTransactionsLedger':
      return {
        key: 'v3.jobs.notices.pageCapUserTransactionsLedger',
        params: counts,
        text: `the user-transactions ledger ${cap}`,
      };
    case 'cryptoTransactionsLookup':
      return {
        key: 'v3.jobs.notices.pageCapCryptoTransactionsLookup',
        params: counts,
        text: `the crypto-transactions lookup ${cap}`,
      };
    case 'accountList':
      return {
        key: 'v3.jobs.notices.pageCapAccountList',
        params: counts,
        text: `the account list ${cap}`,
      };
    case 'accountTransactions':
      return {
        key: 'v3.jobs.notices.pageCapAccountTransactions',
        params: { ...counts, account: w.account },
        text: `transactions for account ${w.account} ${cap}`,
      };
    case 'symbolTrades':
      return {
        key: 'v3.jobs.notices.pageCapSymbolTrades',
        params: { ...counts, symbol: w.symbol },
        text: `${w.symbol} trades ${cap}`,
      };
    case 'transfers':
      return { key: 'v3.jobs.notices.pageCapTransfers', params: counts, text: `transfers ${cap}` };
    case 'currencyDeposits':
      return {
        key: 'v3.jobs.notices.pageCapCurrencyDeposits',
        params: { ...counts, currency: w.currency },
        text: `${w.currency} deposits ${cap}`,
      };
    case 'currencyWithdrawals':
      return {
        key: 'v3.jobs.notices.pageCapCurrencyWithdrawals',
        params: { ...counts, currency: w.currency },
        text: `${w.currency} withdrawals ${cap}`,
      };
    case 'feed':
      return {
        key: 'v3.jobs.notices.pageCapFeed',
        params: { ...counts, path: w.path },
        text: `the ${w.path} feed ${cap}`,
      };
    case 'trxTransfers':
      return {
        key: 'v3.jobs.notices.pageCapTrxTransfers',
        params: counts,
        text: `the TRX transfer history ${cap}`,
      };
    case 'trc20Transfers':
      return {
        key: 'v3.jobs.notices.pageCapTrc20Transfers',
        params: counts,
        text: `the TRC-20 transfer history ${cap}`,
      };
  }
}

/** Why a walk that annotates, rather than produces, matters when it stops short. */
export type PageCapConsequence = 'missingTxIds';

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
    const walks = this.walks();
    if (!walks) return;
    ctx.retractHistoryClaim?.({
      key: 'v3.jobs.notices.pageCapRetracted',
      params: { provider: providerKey },
      lists: { walks },
      text: `${providerKey}: ${englishList(walks)} — the rest of this account's history was never fetched`,
    });
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
  warn(ctx: TransactionFetchContext, providerKey: string, consequence: PageCapConsequence): void {
    const walks = this.walks();
    if (!walks) return;
    switch (consequence) {
      case 'missingTxIds':
        ctx.noteWarning?.({
          key: 'v3.jobs.notices.pageCapMissingTxIds',
          params: { provider: providerKey },
          lists: { walks },
          text:
            `${providerKey}: ${englishList(walks)} — ` +
            'some deposits and withdrawals in this run carry no on-chain transaction id',
        });
    }
  }

  /** What the walks observed, or null when none of them capped. */
  private walks(): JobNoticeList | null {
    if (this.hits.length === 0) return null;
    const items = this.hits.slice(0, WALKS_NAMED).map(walkClause);
    const rest = this.hits.length - items.length;
    if (rest > 0) {
      items.push({
        key: 'v3.jobs.notices.pageCapFurtherWalks',
        params: { count: rest },
        text: `${rest} further walk${rest === 1 ? '' : 's'} did the same`,
      });
    }
    return { type: 'conjunction', items };
  }
}
