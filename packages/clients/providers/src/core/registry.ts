/**
 * `ProviderRegistry` — single registration target for every provider
 * the app boots with. Apps build the registry via
 * `buildProviderRegistry()` from `boot.ts`, then `Container.set` it
 * on typedi so domain services (TokenService, TransactionImportCoordinator,
 * HistoricalPriceBackfillService, etc.) can dispatch by capability.
 *
 * The registry is duck-typed: a provider class doesn't need to declare
 * which interfaces it implements — `register()` inspects via the
 * `is*Provider` type guards and slots it into every relevant capability
 * bucket. Same provider can appear in multiple buckets (e.g. Kraken is
 * a CurrentPriceProvider + HistoricalPriceProvider + BalanceProvider +
 * TransactionsProvider + TokenIdentityProvider + CredentialValidator).
 *
 * Registration order is the dispatch priority order: the first
 * provider returning a non-null result wins. Apps register cheap /
 * platform-credentialed providers first, fall through to pool-
 * credentialed user-scoped providers second, paid providers last.
 */

import type { Token } from '@scani/db/schema';
import { Service } from 'typedi';
import {
  type AccountDiscoveryProvider,
  type AddressValidatorProvider,
  type AIInferenceProvider,
  type BalanceProvider,
  type CredentialValidator,
  type CurrentPriceProvider,
  type HistoricalPriceProvider,
  isAccountDiscoveryProvider,
  isAddressValidatorProvider,
  isAIInferenceProvider,
  isBalanceProvider,
  isCredentialValidator,
  isCurrentPriceProvider,
  isHistoricalPriceProvider,
  isTokenIdentityProvider,
  isTransactionsProvider,
  type ProviderBase,
  type TokenIdentityProvider,
  type TransactionsProvider,
} from './capabilities';
import type { IntegrationManifest } from './integration-manifest';

@Service()
export class ProviderRegistry {
  // Storage is per-capability rather than a single set so dispatch
  // doesn't have to filter on every call. Each provider may appear in
  // multiple lists (Kraken across all six). Order = registration
  // order = dispatch priority.
  private readonly currentPricers: CurrentPriceProvider[] = [];
  private readonly historicalPricers: HistoricalPriceProvider[] = [];
  private readonly balanceFetchers: BalanceProvider[] = [];
  private readonly transactionsFetchers: TransactionsProvider[] = [];
  private readonly identityEnrichers: TokenIdentityProvider[] = [];
  private readonly credentialValidators: CredentialValidator[] = [];
  private readonly addressValidators: AddressValidatorProvider[] = [];
  private readonly accountDiscoverers: AccountDiscoveryProvider[] = [];
  private readonly aiProviders: AIInferenceProvider[] = [];
  private readonly manifestsByProviderKey: Map<string, IntegrationManifest> = new Map();

  /**
   * Add a provider. The same instance can be registered once and
   * automatically slotted into every capability bucket it satisfies.
   * Boot fails loud (via the rate-limiter-registry's namespace check
   * elsewhere) before reaching this method, so we don't need defensive
   * dedup here.
   */
  register(provider: object): void {
    // CurrentPriceProvider check is shared by HistoricalPriceProvider
    // because the latter extends the former. Add to the historical
    // list FIRST so the priority order matches the registration order
    // even when one provider satisfies both.
    if (isHistoricalPriceProvider(provider)) {
      this.historicalPricers.push(provider);
    }
    if (isCurrentPriceProvider(provider)) {
      this.currentPricers.push(provider);
    }
    if (isBalanceProvider(provider)) {
      this.balanceFetchers.push(provider);
    }
    if (isTransactionsProvider(provider)) {
      this.transactionsFetchers.push(provider);
    }
    if (isTokenIdentityProvider(provider)) {
      this.identityEnrichers.push(provider);
    }
    if (isCredentialValidator(provider)) {
      this.credentialValidators.push(provider);
    }
    if (isAddressValidatorProvider(provider)) {
      this.addressValidators.push(provider);
    }
    if (isAccountDiscoveryProvider(provider)) {
      this.accountDiscoverers.push(provider);
    }
    if (isAIInferenceProvider(provider)) {
      this.aiProviders.push(provider);
    }
    // Slot the integration manifest if the provider exposes one.
    // Indexed by providerKey for O(1) lookups by the api router.
    const base = provider as Partial<ProviderBase>;
    if (base.manifest) {
      this.manifestsByProviderKey.set(base.manifest.providerKey, base.manifest);
    }
  }

  // ============================================================
  // Capability-scoped lookups. All return arrays / nulls — the
  // orchestrator picks the first non-null response.
  // ============================================================

  /** All current-price providers that claim to know about `token`. */
  getCurrentPricers(token: Token): CurrentPriceProvider[] {
    return this.currentPricers.filter((p) => p.canPrice(token));
  }

  /** All historical-price providers that claim to know about `token`. */
  getHistoricalPricers(token: Token): HistoricalPriceProvider[] {
    return this.historicalPricers.filter((p) => p.canPrice(token));
  }

  /** Single balance fetcher per institution — only one CEX or chain
      ever owns balance reads for a given institution. */
  getBalanceFetcher(institutionCode: string): BalanceProvider | null {
    return this.balanceFetchers.find((p) => p.canFetchBalances(institutionCode)) ?? null;
  }

  /** Same single-provider rule for transactions. */
  getTransactionsFetcher(institutionCode: string): TransactionsProvider | null {
    return this.transactionsFetchers.find((p) => p.canFetchTransactions(institutionCode)) ?? null;
  }

  /** Same for credential validation. */
  getCredentialValidator(institutionCode: string): CredentialValidator | null {
    // Credential validators are typically the same class as the
    // balance/transactions provider; canFetchBalances is a reasonable
    // proxy for "this is the provider that owns this institution."
    // Falls back to providerKey === institutionCode when a dedicated
    // validator class (no BalanceProvider methods) registers separately.
    return (
      this.credentialValidators.find(
        (p) =>
          p.providerKey === institutionCode ||
          (isBalanceProvider(p) && p.canFetchBalances(institutionCode))
      ) ?? null
    );
  }

  /** All current-price providers, in priority order — irrespective of
      what they `canPrice`. Lets orchestrators pick a provider by
      `providerKey` (e.g. PricingService discriminates per-token-type
      and needs to address `coingecko` / `defillama` / `frankfurter` /
      `finnhub` directly). */
  getAllCurrentPricers(): readonly CurrentPriceProvider[] {
    return this.currentPricers;
  }

  /** All historical-price providers, in priority order. Same use as
      `getAllCurrentPricers` for backfill orchestration. */
  getAllHistoricalPricers(): readonly HistoricalPriceProvider[] {
    return this.historicalPricers;
  }

  /** Address validator for the given institution, if any. Used by
      `WalletDiscoveryService` to syntax-check, probe activity, and
      resolve names. */
  getAddressValidator(institutionCode: string): AddressValidatorProvider | null {
    return this.addressValidators.find((p) => p.canValidate(institutionCode)) ?? null;
  }

  /** All address validators — drives multi-chain probing in
      `detectWalletChains` (asks every one in parallel). */
  getAllAddressValidators(): readonly AddressValidatorProvider[] {
    return this.addressValidators;
  }

  /** Multi-account discovery for venues that expose more than one
      account per credential (IBKR, Wise, Binance spot/margin). */
  getAccountDiscoverer(institutionCode: string): AccountDiscoveryProvider | null {
    return this.accountDiscoverers.find((p) => p.canDiscoverAccounts(institutionCode)) ?? null;
  }

  /** All identity enrichers, in priority order. The exhaustive create
      path in TokenService runs every one in parallel. */
  getIdentityEnrichers(): readonly TokenIdentityProvider[] {
    return this.identityEnrichers;
  }

  /** All AI providers, in priority order. AIRouter walks this list as
      a fallback chain. */
  getAIProviders(): readonly AIInferenceProvider[] {
    return this.aiProviders;
  }

  /** Every credentialed provider's user-facing manifest. The api
      `integrations.listAvailable` query proxies this straight to the
      frontend. Order matches registration order for consistent UI. */
  listIntegrationManifests(): readonly IntegrationManifest[] {
    return Array.from(this.manifestsByProviderKey.values());
  }

  /** Single manifest by providerKey. Used by the api
      `integrations.validateKeys` mutation to validate the submitted
      payload shape against the provider's declared field schema. */
  getIntegrationManifest(providerKey: string): IntegrationManifest | null {
    return this.manifestsByProviderKey.get(providerKey) ?? null;
  }

  /** Diagnostic snapshot for boot logs and admin dashboards. */
  describe(): {
    counts: Record<string, number>;
    providerKeys: Record<string, string[]>;
  } {
    return {
      counts: {
        currentPrice: this.currentPricers.length,
        historicalPrice: this.historicalPricers.length,
        balances: this.balanceFetchers.length,
        transactions: this.transactionsFetchers.length,
        tokenIdentity: this.identityEnrichers.length,
        credentialValidators: this.credentialValidators.length,
        addressValidators: this.addressValidators.length,
        accountDiscoverers: this.accountDiscoverers.length,
        ai: this.aiProviders.length,
      },
      providerKeys: {
        currentPrice: this.currentPricers.map((p) => p.providerKey),
        historicalPrice: this.historicalPricers.map((p) => p.providerKey),
        balances: this.balanceFetchers.map((p) => p.providerKey),
        transactions: this.transactionsFetchers.map((p) => p.providerKey),
        tokenIdentity: this.identityEnrichers.map((p) => p.providerKey),
        credentialValidators: this.credentialValidators.map((p) => p.providerKey),
        addressValidators: this.addressValidators.map((p) => p.providerKey),
        accountDiscoverers: this.accountDiscoverers.map((p) => p.providerKey),
        ai: this.aiProviders.map((p) => p.providerKey),
      },
    };
  }
}
