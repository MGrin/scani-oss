/**
 * `CloudCurrentPricer` — `CurrentPriceProvider` proxy that forwards
 * calls to the data-provider service via `CloudProviderClient`.
 *
 * In cloud mode, every primary pricing provider (CoinGecko, Finnhub,
 * DeFiLlama, Frankfurter) is registered as a `CloudCurrentPricer`
 * instance carrying its own `providerKey`. The data-provider runs the
 * real provider directory in `direct` mode and dispatches inbound
 * requests via its own in-process `ProviderRegistry`. From the
 * caller's perspective (PricingService et al.) the dispatch is
 * identical — the registry just hands back the proxy.
 */

import type { Token } from '@scani/db/schema';
import type { Capability, CurrentPriceProvider } from '../capabilities';
import type { PriceQuote, ProviderContext } from '../types';
import type { CloudProviderClient } from './cloud-client';

export class CloudCurrentPricer implements CurrentPriceProvider {
  readonly capabilities: readonly Capability[] = ['current-price'];

  constructor(
    readonly providerKey: string,
    private readonly client: CloudProviderClient,
    /**
     * Predicate the proxy uses to short-circuit before crossing the
     * network. The data-provider would still answer null for tokens
     * the upstream provider doesn't cover, but checking client-side
     * spares an HTTP round-trip for the obvious mismatches (asking
     * Finnhub about a Solana SPL).
     *
     * Defaults to "always". Concrete provider directories pass a
     * tighter predicate when their boot code constructs the proxy.
     */
    private readonly canPriceFn: (t: Token) => boolean = () => true
  ) {}

  canPrice(t: Token): boolean {
    return this.canPriceFn(t);
  }

  async fetchCurrentPrice(t: Token, ctx: ProviderContext): Promise<PriceQuote | null> {
    return this.client.fetchCurrentPrice({
      providerKey: this.providerKey,
      token: t,
      baseCurrencyId: ctx.baseCurrency.id,
    });
  }

  async fetchCurrentPrices(
    tokens: Token[],
    ctx: ProviderContext
  ): Promise<Map<string, PriceQuote>> {
    const filtered = tokens.filter((t) => this.canPrice(t));
    if (filtered.length === 0) return new Map();
    const rows = await this.client.fetchCurrentPrices({
      providerKey: this.providerKey,
      tokens: filtered,
      baseCurrencyId: ctx.baseCurrency.id,
    });
    return new Map(rows.map((r) => [r.tokenId, r.quote]));
  }
}
