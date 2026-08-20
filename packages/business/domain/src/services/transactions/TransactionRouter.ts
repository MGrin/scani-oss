/**
 * `TransactionRouter` — translates the new
 * `TransactionsProvider.fetchTransactions(ctx)` shape into the
 * `NewHoldingTransaction[]` rows the existing `TransactionImportCoordinator
 * .persistAndReport` consumes.
 *
 * The migration target is to retire the per-CEX `*TransactionIngester`
 * classes from `@scani/integrations` (which expose `{ resolveHolding,
 * resolveToken }` callbacks at the call site) in favour of generic
 * `TransactionEvent` events that carry `Partial<NewToken>` identity
 * hints, and let the orchestrator resolve identities + holdings AFTER
 * receiving events.
 *
 * This router is a single resolution pipeline:
 *   1. `registry.getTransactionsFetcher(institutionCode).fetchTransactions(ctx)`
 *      → `TransactionEvent[]` from the provider directory.
 *   2. Per event, `findOrCreateByIdentity(primary.tokenIdentity)` →
 *      tokenId; `holdingService.findOrCreateForIngest(...)` → holdingId.
 *      Same for counter / fee / priceNative.
 *   3. Build `NewHoldingTransaction` rows; the coordinator's existing
 *      `persistAndReport` writes them.
 *
 * Coverage tracking: the router carries `firstEventAt`, `lastEventAt`,
 * and a `hasCompleteTxHistory` hint forward; the coordinator combines
 * those with the holdings touched in this run to update
 * `holding_coverage`.
 */

import type {
  NewHoldingBalanceObservation,
  NewHoldingTransaction,
  NewToken,
  Token,
} from '@scani/db/schema';
import type { TransactionsProvider } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { ProviderContext, TransactionEvent, WithUserCreds } from '@scani/providers/core/types';
import { Container, Service } from 'typedi';
import { TokenTypeRepository } from '../../repositories/EnumRepositories';
import { HoldingService } from '../holdings/HoldingService';
import { TokenIdentityService } from '../tokens/TokenIdentityService';
import { isWalletDerivedSource } from './transaction-sources';

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
  transactions: NewHoldingTransaction[];
  observations: NewHoldingBalanceObservation[];
  warnings: string[];
  firstEventAt: Date | null;
  lastEventAt: Date | null;
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
  const days = Math.max(1, Math.floor(ms / DAY_MS));
  if (days >= 365) {
    const years = Math.floor(days / 365);
    return `${years} year${years === 1 ? '' : 's'}`;
  }
  if (days >= 30) {
    const months = Math.floor(days / 30);
    return `${months} month${months === 1 ? '' : 's'}`;
  }
  return `${days} day${days === 1 ? '' : 's'}`;
}

@Service()
export class TransactionRouter {
  // Class-field DI per the project's typedi conventions (see CLAUDE.md).
  private readonly tokenIdentityService = Container.get(TokenIdentityService);
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);
  private readonly holdingService = Container.get(HoldingService);

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
   * Run the transactions fetcher for the given institution and
   * convert the resulting `TransactionEvent[]` into
   * `NewHoldingTransaction[]` rows ready for persistence.
   *
   * Throws when no provider is registered for the institution code.
   * The coordinator should call `hasProviderFor()` first to surface
   * a cleaner unrecoverable error.
   */
  async run(request: TransactionRouterRequest): Promise<TransactionRouterResult> {
    const provider = this.resolveProvider(request.institutionCode);

    // One array per run, closed over by the sinks below. Nothing here is
    // shared between runs, which is the property that lets a provider write
    // to the caller's state without the caller handing it a service.
    const retractions: string[] = [];
    const notices: string[] = [];

    const ctx: WithUserCreds<ProviderContext> & {
      institutionCode: string;
      since?: Date;
      until?: Date;
      retractHistoryClaim?: (reason: string) => void;
      noteWarning?: (reason: string) => void;
    } = {
      baseCurrency: request.baseCurrency,
      timestamp: new Date(),
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
      retractHistoryClaim: (reason: string) => {
        retractions.push(reason);
      },
      // The other half of the same channel, and deliberately NOT the same
      // array. A retraction is evidence about the ledger and moves
      // `has_complete_tx_history`; this says something the reader should know
      // and moves nothing. A walk that ran short of a lookup it uses to
      // ANNOTATE events — bitstamp's `/crypto-transactions/` txid map — costs
      // an annotation and not a row, so retracting on it would downgrade a
      // cost basis over a missing hash (SC-426, SC-428).
      noteWarning: (reason: string) => {
        notices.push(reason);
      },
    };

    const events = await provider.fetchTransactions(ctx);
    const complete = this.claimsCompleteHistory(provider, request) && retractions.length === 0;
    const horizon = this.describeHorizon(provider, request);
    if (horizon) notices.unshift(horizon);

    if (events.length === 0) {
      return this.emptyResult(complete, retractions, notices);
    }

    return this.materializeEvents(events, request, complete, retractions, notices);
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
  ): string | null {
    const horizon = provider.transactionHistoryHorizonMs;
    if (request.since || horizon === undefined) return null;
    return (
      `${provider.providerKey}: a run with no start date reaches ${describeDuration(horizon)} ` +
      `back and no further — anything older than that was never fetched`
    );
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

  /**
   * Convert `TransactionEvent[]` into ledger-ready
   * `NewHoldingTransaction[]`. Every `tokenIdentity` flows through
   * `tokenIdentityService.findOrCreateByIdentity` so brand-new symbols
   * (token discovered for the first time on a tx page) get a
   * persisted `tokens` row with the federated metadata before the
   * tx row is written.
   *
   * Returns warnings (non-fatal) when an identity can't be
   * resolved — the event is skipped but the surrounding run
   * continues.
   */
  private async materializeEvents(
    events: readonly TransactionEvent[],
    request: TransactionRouterRequest,
    hasCompleteTxHistory: boolean,
    historyRetractions: readonly string[],
    notices: readonly string[] = []
  ): Promise<TransactionRouterResult> {
    const transactions: NewHoldingTransaction[] = [];
    // Seeded with the retractions so a reader meets "why is my history
    // incomplete" in the same list as every other thing this run wants to
    // tell them, rather than in a log line nobody opens. The notices sit in
    // front of them: a declared horizon is the standing shape of the run and
    // reads first, a retraction is what this particular walk observed.
    const warnings: string[] = [...notices, ...historyRetractions];
    const accumulator: { first: Date | null; last: Date | null } = {
      first: null,
      last: null,
    };

    // Per-symbol token + holding cache. A typical tx import touches
    // a handful of symbols thousands of times; resolving them
    // through the DB on every event would be needlessly expensive.
    const tokenCache = new Map<string, string>();
    const holdingCache = new Map<string, string>();
    // Identities a find-only lookup already missed. Without it, a wallet
    // whose history is mostly spam re-queries the same absent contract once
    // per event — 410 of them in the production run that found this.
    const unknownIdentities = new Set<string>();
    // Events dropped for want of a holding the user kept, keyed by whatever
    // identifies the token we could not use: its id when the row exists, its
    // identity key when it does not. Both are one reason.
    const skippedByToken = new Map<string, number>();

    // Pre-resolve every token-type code we might map against per-leg
    // `tokenType` hints. IBKR equity legs declare `tokenType: 'stock'`
    // (otherwise they'd default to crypto and silently route Yahoo →
    // ETF look-alike pricing — see prod incident 2026-05-06 where
    // AAPL/MSFT/NVDA/AMZN/PLTR/VOO ended up `crypto`-typed).
    const seededTypes = await this.tokenTypeRepository.findByCodes([
      'crypto',
      'fiat',
      'stock',
      'private-company',
      'other',
    ]);
    const tokenTypeIdByCode = new Map<string, string>(seededTypes.map((t) => [t.code, t.id]));
    const defaultTypeId = tokenTypeIdByCode.get('crypto') ?? tokenTypeIdByCode.get('fiat');
    if (!defaultTypeId) {
      throw new Error('TransactionRouter: neither crypto nor fiat token type seeded');
    }

    const resolveTokenId = async (
      identity: Partial<NewToken>,
      tokenType?: string,
      findOnlyIdentity = false
    ): Promise<string | null> => {
      const cacheKey = this.identityCacheKey(identity);
      const cached = tokenCache.get(cacheKey);
      if (cached) return cached;
      if (unknownIdentities.has(cacheKey)) {
        skippedByToken.set(cacheKey, (skippedByToken.get(cacheKey) ?? 0) + 1);
        return null;
      }
      try {
        // Per-leg `tokenType` hint takes precedence over the default;
        // identity.typeId (rare, usually unset by providers) wins over
        // both. The findOrCreateByIdentity lookup-by-tuple still finds
        // existing rows regardless of the supplied typeId, so this only
        // matters for newly-created tokens.
        const hintedTypeId = tokenType ? tokenTypeIdByCode.get(tokenType) : undefined;
        const partial: Partial<NewToken> = {
          ...identity,
          typeId: identity.typeId ?? hintedTypeId ?? defaultTypeId,
        };
        // FIND-ONLY, for exactly the sources that resolve holdings find-only.
        // A holding cannot exist without a `tokens` row, so an identity the
        // database has never seen can never produce one — the create would be
        // followed, always, by the event being dropped for want of a holding.
        // What it leaves behind is a permanent row: 111 in one production
        // re-import, 47 of them a bare `USDC` / `Tether USD` on a spam
        // contract that scores 0 and so survives every scam filter token
        // search applies (SC-343).
        const token = findOnlyIdentity
          ? await this.tokenIdentityService.findByIdentity(partial)
          : await this.tokenIdentityService.findOrCreateByIdentity(partial);
        if (!token) {
          unknownIdentities.add(cacheKey);
          skippedByToken.set(cacheKey, (skippedByToken.get(cacheKey) ?? 0) + 1);
          return null;
        }
        tokenCache.set(cacheKey, token.id);
        return token.id;
      } catch (err) {
        warnings.push(
          `Failed to resolve token identity ${cacheKey}: ${err instanceof Error ? err.message : String(err)}`
        );
        return null;
      }
    };

    // Wallet-derived imports (EVM via `etherscan`, Solana, and any
    // other on-chain source) are gated by the wallet review: only the
    // holdings the user kept are pre-created. We FIND ONLY for them so
    // a tx referencing a token the user dropped at review doesn't
    // silently re-introduce that holding (which is how 100+ spam
    // tokens used to leak back in via OpeningBalanceReconciliation).
    // Exchange-derived imports keep the create-on-miss flavour because
    // deposits of new tokens are legitimate without a review. The
    // source taxonomy lives in `transaction-sources.ts`.
    //
    // `findOnly` gates the TOKEN IDENTITY as well as the holding, and one
    // flag drives both because they are one decision. A holding cannot exist
    // without a `tokens` row, so under find-only an identity the database
    // does not already hold is guaranteed to resolve no holding — the create
    // was never anything but a row left behind (SC-343).
    // Legs a provider declared to be one swap, keyed by its own group key.
    // Collected while the rows are built and settled once, below, because
    // whether a swap survived is only knowable after every leg has been
    // through holding resolution.
    const swapGroups = new Map<string, NewHoldingTransaction[]>();

    const findOnly = isWalletDerivedSource(request.source);
    const resolveHoldingId = async (tokenId: string): Promise<string | null> => {
      const cached = holdingCache.get(tokenId);
      if (cached) return cached;
      try {
        if (findOnly) {
          const existing = await this.holdingService.findExistingForIngest({
            userId: request.userId,
            accountId: request.accountId,
            tokenId,
          });
          if (!existing) {
            skippedByToken.set(tokenId, (skippedByToken.get(tokenId) ?? 0) + 1);
            return null;
          }
          holdingCache.set(tokenId, existing.id);
          return existing.id;
        }
        const holding = await this.holdingService.findOrCreateForIngest({
          userId: request.userId,
          accountId: request.accountId,
          tokenId,
        });
        holdingCache.set(tokenId, holding.id);
        return holding.id;
      } catch (err) {
        warnings.push(
          `Failed to resolve holding for token ${tokenId}: ${err instanceof Error ? err.message : String(err)}`
        );
        return null;
      }
    };

    for (const event of events) {
      const primaryTokenId = await resolveTokenId(
        event.primary.tokenIdentity,
        event.primary.tokenType,
        findOnly
      );
      if (!primaryTokenId) continue;
      const primaryHoldingId = await resolveHoldingId(primaryTokenId);
      if (!primaryHoldingId) continue;

      // The counter, fee and quote sides are resolved create-on-miss even on
      // a wallet source, and only for an event that already cleared holding
      // resolution above. They are priced against, not held, so gating them
      // on a holding would strip the quote off a swap that did land — and a
      // swap leg without its price realizes at zero (SC-332).
      const counterTokenId = event.counter
        ? await resolveTokenId(event.counter.tokenIdentity, event.counter.tokenType)
        : null;
      const feeTokenId = event.fee
        ? await resolveTokenId(event.fee.tokenIdentity, event.fee.tokenType)
        : null;
      const priceNativeTokenId = event.priceNative
        ? await resolveTokenId(event.priceNative.quoteIdentity, event.priceNative.tokenType)
        : null;

      if (!accumulator.first || event.occurredAt < accumulator.first) {
        accumulator.first = event.occurredAt;
      }
      if (!accumulator.last || event.occurredAt > accumulator.last) {
        accumulator.last = event.occurredAt;
      }

      const row: NewHoldingTransaction = {
        userId: request.userId,
        holdingId: primaryHoldingId,
        tokenId: primaryTokenId,
        kind: event.kind,
        quantity: event.primary.quantity,
        priceNative: event.priceNative?.value ?? null,
        priceNativeTokenId,
        counterTokenId,
        counterQuantity: event.counter?.quantity ?? null,
        feeQuantity: event.fee?.quantity ?? null,
        feeTokenId,
        occurredAt: event.occurredAt,
        externalId: event.externalId,
        swapGroupId: null,
        source: request.source,
        sourceMetadata: {},
        rawPayload: (event.rawPayload as Record<string, unknown> | null) ?? null,
        counterparty: event.counterparty ?? null,
        description: event.description ?? null,
      };
      transactions.push(row);
      if (event.swapGroupKey) {
        const siblings = swapGroups.get(event.swapGroupKey);
        if (siblings) siblings.push(row);
        else swapGroups.set(event.swapGroupKey, [row]);
      }
    }

    this.resolveSwapGroups(swapGroups, warnings);

    if (skippedByToken.size > 0) {
      let skippedTotal = 0;
      for (const n of skippedByToken.values()) skippedTotal += n;
      warnings.push(
        `Skipped ${skippedTotal} tx event(s) referencing ${skippedByToken.size} token(s) the user didn't keep during wallet review.`
      );
    }

    return {
      transactions,
      observations: [],
      warnings,
      firstEventAt: accumulator.first,
      lastEventAt: accumulator.last,
      hasCompleteTxHistory,
      historyRetractions: [...historyRetractions],
    };
  }

  /**
   * Turn each provider swap-group key into one `swap_group_id`, or undo the
   * swap where the group did not survive (SC-332).
   *
   * A provider knows two legs are one swap. It cannot know whether both
   * reach the ledger: wallet-derived sources resolve holdings FIND-ONLY, so
   * a leg whose token has no holding on the account is dropped above, and
   * that is common — a token swapped into and later out of again leaves no
   * holding behind for its own history to land on.
   *
   * A leg left alone must not stay a swap, and the reason is that a lone
   * swap leg is worse than the plain transfer it replaced, twice over:
   *
   *  - it leaves the transfer-review queue, whose pending predicate is
   *    `kind IN ('withdraw','transfer_out')`, so the one question a human
   *    could still answer about it stops being asked; and
   *  - it asserts a trade whose other side is not in the ledger, so nothing
   *    can ever say what was received for it.
   *
   * The second reason USED to be that `CostBasisService.txValueInBase`
   * refused the held-token fallback for swap kinds, popping a partnerless
   * outflow's lots at ZERO realized. SC-397 removed that refusal — a leg
   * whose counter cannot be valued is now valued from the token that left —
   * so the revert is no longer what stands between a lone leg and a zero.
   * **It is still right**, and for the reason above rather than that one: a
   * lone leg is not a swap, and calling it one loses the only question a
   * person could still answer about it.
   *
   * Both remaining reasons are this repo's documented failure shape — a value
   * that reads as an answer nobody gave. So the leg goes back to being exactly
   * the transfer it was, and the run says out loud that it did.
   */
  private resolveSwapGroups(
    groups: ReadonlyMap<string, NewHoldingTransaction[]>,
    warnings: string[]
  ): void {
    let orphaned = 0;
    for (const legs of groups.values()) {
      if (legs.length > 1) {
        const swapGroupId = crypto.randomUUID();
        for (const leg of legs) leg.swapGroupId = swapGroupId;
        continue;
      }
      const orphan = legs[0];
      if (!orphan) continue;
      orphaned++;
      orphan.kind = orphan.quantity.trimStart().startsWith('-') ? 'transfer_out' : 'transfer_in';
      orphan.swapGroupId = null;
      orphan.counterTokenId = null;
      orphan.counterQuantity = null;
      orphan.priceNative = null;
      orphan.priceNativeTokenId = null;
    }
    if (orphaned > 0) {
      warnings.push(
        `Recorded ${orphaned} swap leg(s) as plain transfers: the other side of the swap has no holding on this account, so nothing could be linked or priced.`
      );
    }
  }

  private identityCacheKey(identity: Partial<NewToken>): string {
    const meta = identity.providerMetadata as Record<string, unknown> | undefined;
    // Prefer the most-specific identity component for cache keying.
    if (meta && typeof meta === 'object') {
      const eth = meta.etherscan as { chainId?: number; contractAddress?: string } | undefined;
      if (eth?.chainId && eth.contractAddress) {
        return `evm:${eth.chainId}:${eth.contractAddress.toLowerCase()}`;
      }
    }
    return `sym:${(identity.symbol ?? '').toUpperCase()}:${identity.marketSegment ?? ''}`;
  }

  private emptyResult(
    hasCompleteTxHistory: boolean,
    historyRetractions: readonly string[],
    notices: readonly string[] = []
  ): TransactionRouterResult {
    return {
      transactions: [],
      observations: [],
      // A run that fetched nothing still tells the user why its coverage
      // moved. Zero events is the shape a revoked key or an emptied feed
      // takes, which is exactly when the reason matters most — and an empty
      // result from a horizon provider is exactly the run whose short history
      // looks like lost data.
      warnings: [...notices, ...historyRetractions],
      firstEventAt: null,
      lastEventAt: null,
      hasCompleteTxHistory,
      historyRetractions: [...historyRetractions],
    };
  }
}
