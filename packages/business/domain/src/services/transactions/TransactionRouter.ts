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
   * Best-effort claim: true when the run has no `since` and the
   * provider didn't truncate. The new providers don't yet surface a
   * truncation flag in `TransactionEvent`, so today we conservatively
   * report `!since` only.
   */
  hasCompleteTxHistory: boolean;
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

    const ctx: WithUserCreds<ProviderContext> & {
      institutionCode: string;
      since?: Date;
      until?: Date;
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
    };

    const events = await provider.fetchTransactions(ctx);
    if (events.length === 0) {
      return this.emptyResult(!request.since);
    }

    return this.materializeEvents(events, request);
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
    request: TransactionRouterRequest
  ): Promise<TransactionRouterResult> {
    const transactions: NewHoldingTransaction[] = [];
    const warnings: string[] = [];
    const accumulator: { first: Date | null; last: Date | null } = {
      first: null,
      last: null,
    };

    // Per-symbol token + holding cache. A typical tx import touches
    // a handful of symbols thousands of times; resolving them
    // through the DB on every event would be needlessly expensive.
    const tokenCache = new Map<string, string>();
    const holdingCache = new Map<string, string>();

    const cryptoTokenType = await this.tokenTypeRepository.findByCode('crypto');
    const fiatTokenType = await this.tokenTypeRepository.findByCode('fiat');
    const defaultTypeId = cryptoTokenType?.id ?? fiatTokenType?.id;
    if (!defaultTypeId) {
      throw new Error('TransactionRouter: neither crypto nor fiat token type seeded');
    }

    const resolveTokenId = async (identity: Partial<NewToken>): Promise<string | null> => {
      const cacheKey = this.identityCacheKey(identity);
      const cached = tokenCache.get(cacheKey);
      if (cached) return cached;
      try {
        const partial: Partial<NewToken> = {
          ...identity,
          // Default to crypto for tx-history events when the provider
          // didn't tag a typeId. Fiat exchange-leg tokens (USD, EUR)
          // are seeded with fiat typeId already and the
          // findOrCreateByIdentity lookup-by-tuple finds them
          // regardless of the supplied typeId.
          typeId: identity.typeId ?? defaultTypeId,
        };
        const token = await this.tokenIdentityService.findOrCreateByIdentity(partial);
        tokenCache.set(cacheKey, token.id);
        return token.id;
      } catch (err) {
        warnings.push(
          `Failed to resolve token identity ${cacheKey}: ${err instanceof Error ? err.message : String(err)}`
        );
        return null;
      }
    };

    // Wallet-derived imports (`etherscan`) are gated by the wallet
    // review: only the holdings the user kept are pre-created. We
    // FIND ONLY here so a tx referencing a token the user dropped at
    // review doesn't silently re-introduce that holding (which is how
    // 100+ spam tokens used to leak back in via OpeningBalanceReconciliation).
    // Exchange-derived imports keep the create-on-miss flavour
    // because deposits of new tokens are legitimate without a review.
    const findOnly = request.source === 'etherscan';
    const skippedByToken = new Map<string, number>();
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
      const primaryTokenId = await resolveTokenId(event.primary.tokenIdentity);
      if (!primaryTokenId) continue;
      const primaryHoldingId = await resolveHoldingId(primaryTokenId);
      if (!primaryHoldingId) continue;

      const counterTokenId = event.counter
        ? await resolveTokenId(event.counter.tokenIdentity)
        : null;
      const feeTokenId = event.fee ? await resolveTokenId(event.fee.tokenIdentity) : null;
      const priceNativeTokenId = event.priceNative
        ? await resolveTokenId(event.priceNative.quoteIdentity)
        : null;

      if (!accumulator.first || event.occurredAt < accumulator.first) {
        accumulator.first = event.occurredAt;
      }
      if (!accumulator.last || event.occurredAt > accumulator.last) {
        accumulator.last = event.occurredAt;
      }

      transactions.push({
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
        source: request.source,
        sourceMetadata: {},
        rawPayload: (event.rawPayload as Record<string, unknown> | null) ?? null,
      });
    }

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
      hasCompleteTxHistory: !request.since,
    };
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

  private emptyResult(hasCompleteTxHistory: boolean): TransactionRouterResult {
    return {
      transactions: [],
      observations: [],
      warnings: [],
      firstEventAt: null,
      lastEventAt: null,
      hasCompleteTxHistory,
    };
  }
}
