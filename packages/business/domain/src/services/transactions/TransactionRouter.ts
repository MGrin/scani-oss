/**
 * `TransactionRouter` fetches one run's `TransactionEvent[]` from the
 * provider that claims the institution, and says what the run is entitled to
 * claim about the ledger: whether it read the whole of it, why not, and how
 * far back it reached. It resolves nothing and writes nothing; the coordinator
 * turns the events into a feed batch (`legacyTransactionBatch`) and
 * `FeedIngestService` writes it (foundation A2).
 */

import type { Token } from '@scani/db/schema';
import type { TransactionsProvider } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import {
  type HistoryBound,
  type JobNotice,
  type NoticeInput,
  type ProviderContext,
  type TransactionEvent,
  toJobNotice,
  type WithUserCreds,
} from '@scani/providers/core/types';
import { Container, Service } from 'typedi';

export interface TransactionRouterRequest {
  userId: string;
  accountId: string;
  institutionId: string;
  /** Institution code the registry filter dispatches by. */
  institutionCode: string;
  /** Source tag stored on every transaction row for dedup + audit. */
  source: string;
  /** Optional incremental cutoff. */
  since?: Date;
  /** Optional upper bound (rare; balance-snapshot use case). */
  until?: Date;
  /** Base currency for the provider context. */
  baseCurrency: Token;
  /**
   * Decryption callback. Wired from the coordinator to
   * `IntegrationCredentialsService.getDecryptedCredentials`.
   */
  resolveCredentials: ProviderContext['resolveCredentials'];
}

export interface TransactionRouterResult {
  /** What the provider returned, in its order. */
  events: TransactionEvent[];
  /** When the provider was asked, which is where the run's window ends. */
  fetchedAt: Date;
  /** `TransactionsProvider.transactionHistoryHorizonMs`, when it declares one. */
  horizonMs: number | undefined;
  warnings: string[];
  /**
   * True when the caller asked for the whole ledger, the provider declares
   * no look-back horizon of its own
   * (`TransactionsProvider.transactionHistoryHorizonMs`), AND the provider
   * did not retract during the walk.
   *
   * The first two are what the router can know before the call. Deriving
   * the flag from `!since` alone was SC-166: a provider that substitutes
   * its own 30-day window still satisfies `!since`, so the optimistic
   * reading was wrong exactly where it mattered.
   *
   * The third is SC-395. A declared horizon covers a provider that KNOWS
   * in advance how far it can see; it says nothing about a walk that set
   * out for the whole ledger and came back short. Kraken's paginator
   * computed exactly that verdict and returned it into a generator value
   * the base class dropped, so a run that had just measured 2 breaks in
   * Kraken's own running balance and 40 half-arrived operations still
   * wrote `has_complete_tx_history = true`.
   */
  hasCompleteTxHistory: boolean;
  /**
   * What the provider said when it took the claim away, one entry per
   * reason. Empty on every run that retracted nothing.
   *
   * Carried out of the router rather than folded into the boolean because
   * two callers need it: `warnings` shows the user WHY their coverage
   * changed, and the coordinator uses its non-emptiness to decide that an
   * incremental run is entitled to write a `false` it did not merely
   * inherit from having asked for a window (SC-360).
   */
  historyRetractions: string[];
  /**
   * The same lines as `warnings`, same order and same length, each carrying
   * the key it can be translated under when we wrote it (SC-434).
   *
   * Parallel to `warnings` rather than replacing it, and both halves of that
   * matter. `user_jobs.result` already holds 182 English sentences that
   * cannot be re-derived, and the job page is served to a PWA whose service
   * worker may be several builds old — a client that has never heard of this
   * field keeps reading `warnings` and keeps rendering exactly what it
   * renders today. The invariant `warnings[i] === warningDetails[i].text` is
   * what lets a reader treat either one as authoritative, and
   * `transaction-router-notices.test.ts` asserts it.
   */
  warningDetails: JobNotice[];
  /**
   * The earliest date any retracting provider says its source COVERS, or null
   * when none named one (SC-900).
   *
   * The EARLIEST of what was stated, not the latest. It is written to
   * `holding_coverage.history_starts_at` and read back as "money that moved
   * before this has no row here" — a claim that must never reach further
   * forward than the ledger actually does, or it explains away rows we hold.
   * One run resolves one provider today, so the reduction has nothing to do
   * but pass a single value through; it is written as a reduction because that
   * is a property of this method rather than of the type.
   */
  historyStartsAt: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A horizon in the words a reader uses, not milliseconds.
 *
 * The declared values are `5 * 365 * DAY_MS`, thirty days and seven days, so
 * the three scales below cover every provider that declares one. Rounded down
 * rather than to nearest: "reaches 5 years back and no further" must not be
 * read as a promise of more history than the provider actually serves.
 */
function describeDuration(ms: number): string {
  const { count, unit } = measureDuration(ms);
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/**
 * The same horizon as a number and a unit, for a client that can say it in
 * its own language (SC-434).
 *
 * Deliberately NOT a translation key per scale. `Intl.NumberFormat` with
 * `style: 'unit'` renders `5 years` / `5 лет` / `5 ans` from CLDR, which
 * already knows every plural category of every locale we ship and of every
 * locale we have not written yet. Three hand-written keys with `_one` /
 * `_few` / `_many` variants would be a second, worse copy of a table the
 * platform maintains — and the one that rots the first time a language is
 * added.
 */
function measureDuration(ms: number): { count: number; unit: 'year' | 'month' | 'day' } {
  const days = Math.max(1, Math.floor(ms / DAY_MS));
  if (days >= 365) return { count: Math.floor(days / 365), unit: 'year' };
  if (days >= 30) return { count: Math.floor(days / 30), unit: 'month' };
  return { count: days, unit: 'day' };
}

@Service()
export class TransactionRouter {
  // Class-field DI per the project's typedi conventions (see CLAUDE.md).
  /**
   * Returns whether the registry has any provider that claims the
   * given institution code. The coordinator uses this to decide
   * whether to dispatch the import or surface an unrecoverable
   * "no provider registered" error.
   */
  hasProviderFor(institutionCode: string): boolean {
    try {
      return Container.get(ProviderRegistry).getTransactionsFetcher(institutionCode) !== null;
    } catch {
      return false;
    }
  }

  /**
   * Run the transactions fetcher for the given institution and return its
   * events with what the run may claim. A run that fetched nothing still
   * carries its notices and retractions: zero events is the shape a revoked
   * key or an emptied feed takes, which is exactly when the reason matters.
   *
   * Throws when no provider is registered for the institution code.
   * The coordinator should call `hasProviderFor()` first to surface
   * a cleaner unrecoverable error.
   */
  async run(request: TransactionRouterRequest): Promise<TransactionRouterResult> {
    const provider = this.resolveProvider(request.institutionCode);
    const fetchedAt = new Date();

    // One array per run, closed over by the sinks below. Nothing here is
    // shared between runs, which is the property that lets a provider write
    // to the caller's state without the caller handing it a service.
    const retractions: JobNotice[] = [];
    const notices: JobNotice[] = [];
    let historyStartsAt: Date | null = null;

    const ctx: WithUserCreds<ProviderContext> & {
      institutionCode: string;
      since?: Date;
      until?: Date;
      retractHistoryClaim?: (reason: NoticeInput, bound?: HistoryBound) => void;
      noteWarning?: (reason: NoticeInput) => void;
    } = {
      baseCurrency: request.baseCurrency,
      timestamp: fetchedAt,
      userId: request.userId,
      accountId: request.accountId,
      credentialsRef: { userId: request.userId, institutionId: request.institutionId },
      resolveCredentials: request.resolveCredentials!,
      institutionCode: request.institutionCode,
      since: request.since,
      until: request.until,
      // Retraction only, and idempotent in effect: a provider that calls
      // this twice retracts once and explains twice. There is deliberately
      // no way back — a provider cannot know whether the caller asked for a
      // window, so letting it CLAIM completeness would let an incremental
      // run declare a whole ledger every night.
      retractHistoryClaim: (reason: NoticeInput, bound?: HistoryBound) => {
        retractions.push(toJobNotice(reason));
        // Kept beside the reason rather than folded into it: the sentence is
        // for the reader and the date is for reconciliation, and a service
        // parsing a date back out of English prose is how the two come to
        // disagree (SC-900).
        if (bound && (historyStartsAt === null || bound.historyStartsAt < historyStartsAt)) {
          historyStartsAt = bound.historyStartsAt;
        }
      },
      // The other half of the same channel, and deliberately NOT the same
      // array. A retraction is evidence about the ledger and moves
      // `has_complete_tx_history`; this says something the reader should know
      // and moves nothing. A walk that ran short of a lookup it uses to
      // ANNOTATE events — bitstamp's `/crypto-transactions/` txid map — costs
      // an annotation and not a row, so retracting on it would downgrade a
      // cost basis over a missing hash (SC-426, SC-428).
      noteWarning: (reason: NoticeInput) => {
        notices.push(toJobNotice(reason));
      },
    };

    const events = await provider.fetchTransactions(ctx);
    const complete = this.claimsCompleteHistory(provider, request) && retractions.length === 0;
    const horizon = this.describeHorizon(provider, request);
    if (horizon) notices.unshift(horizon);

    // The notices read first: a declared horizon is the standing shape of the
    // run, a retraction is what this particular walk observed.
    const warningDetails = [...notices, ...retractions];
    return {
      events,
      fetchedAt,
      horizonMs: provider.transactionHistoryHorizonMs,
      warnings: warningDetails.map((notice) => notice.text),
      warningDetails,
      hasCompleteTxHistory: complete,
      historyRetractions: retractions.map((notice) => notice.text),
      historyStartsAt,
    };
  }

  /**
   * Why a run that asked for everything came back with a bounded ledger.
   *
   * `claimsCompleteHistory` already writes `has_complete_tx_history = false`
   * for a provider that declares a horizon, and that is right. But nothing
   * said so: a Binance import wrote the `false` with an empty `warnings` list,
   * and the cost-basis chip read "partial" with no stated cause, while a
   * page-cap (SC-426) and a self-contradicting ledger (SC-395) both explain
   * themselves. Not a wrong flag — a wrong-looking screen (SC-428).
   *
   * **It is guarded in both directions, and that is the whole subtlety.** A
   * `since`-bounded run through the same provider says nothing, because the
   * two falses are different claims: "I was only asked for a window" is
   * SILENCE about the ledger (SC-360), and a window is the caller's choice
   * rather than a shortfall. Only a run that asked for the whole ledger and
   * was handed a horizon has something to report.
   */
  private describeHorizon(
    provider: TransactionsProvider,
    request: TransactionRouterRequest
  ): JobNotice | null {
    const horizon = provider.transactionHistoryHorizonMs;
    if (request.since || horizon === undefined) return null;
    const { count, unit } = measureDuration(horizon);
    return {
      key: 'v3.jobs.notices.providerHorizon',
      // The provider key travels as a param rather than being spliced into
      // the sentence: `binance` is a name and reads the same in every
      // language, but where it sits in the sentence does not.
      params: { provider: provider.providerKey, durationCount: count, durationUnit: unit },
      text:
        `${provider.providerKey}: a run with no start date reaches ${describeDuration(horizon)} ` +
        `back and no further — anything older than that was never fetched`,
    };
  }

  /**
   * Whether this run really did walk the account's whole ledger.
   *
   * Two conditions, and the second one is the fix. `!request.since` says the
   * caller asked for everything; `transactionHistoryHorizonMs` says whether
   * the provider can deliver it. Asking was previously taken as receiving,
   * so Bybit — which substitutes a 30-day look-back when handed no `since` —
   * marked coverage complete on a month of history (SC-166).
   *
   * Both are known BEFORE the call, which is why this is a claim and not a
   * finding. What the walk itself observed arrives afterwards, through
   * `retractHistoryClaim`, and `run` ands the two together (SC-395).
   */
  private claimsCompleteHistory(
    provider: TransactionsProvider,
    request: TransactionRouterRequest
  ): boolean {
    return !request.since && provider.transactionHistoryHorizonMs === undefined;
  }

  // ============================================================
  // Internals
  // ============================================================

  private resolveProvider(institutionCode: string): TransactionsProvider {
    const registry = Container.get(ProviderRegistry);
    const provider = registry.getTransactionsFetcher(institutionCode);
    if (!provider) {
      throw new Error(
        `TransactionRouter: no provider registered for institutionCode '${institutionCode}'`
      );
    }
    return provider;
  }
}
